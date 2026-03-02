/**
 * Web Server — Express + WebSocket server for AG Mission Control.
 * Serves the web dashboard and provides API endpoints for cascade management.
 */
import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createWebServer(cdpManager, responseMonitor, opts = {}) {
    const port = opts.port || parseInt(process.env.PORT) || 3000;
    const app = express();
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server });

    app.use(express.json());
    app.use(express.static(join(__dirname, '../../public'), { maxAge: 0, etag: false }));

    // ── API: Get cascade list ─────────────────────────
    app.get('/cascades', (req, res) => {
        res.json({ cascades: cdpManager.getCascadeList() });
    });

    // ── API: Add workspace (new CDP target) ───────────
    app.post('/workspace/add', (req, res) => {
        const { host, port } = req.body;
        if (!port) return res.status(400).json({ ok: false, reason: 'Port required' });
        const isNew = cdpManager.addPort(port, host || '127.0.0.1');
        res.json({ ok: true, isNew, message: isNew ? `Scanning ${host || '127.0.0.1'}:${port}...` : 'Already scanning this target' });
    });

    // ── API: List scan targets ────────────────────────
    app.get('/workspace/ports', (req, res) => {
        res.json({ ports: cdpManager.ports });
    });

    // ── API: Get cascade snapshot ─────────────────────
    app.get('/snapshot/:id', (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade || !cascade.snapshot) {
            return res.status(404).json({ error: 'No snapshot' });
        }
        res.json({
            html: cascade.snapshot.html,
            bodyBg: cascade.snapshot.bodyBg,
            bodyColor: cascade.snapshot.bodyColor
        });
    });

    // ── API: Get cascade CSS ──────────────────────────
    app.get('/styles/:id', async (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) {
            return res.status(404).json({ error: 'Cascade not found' });
        }
        res.json({ css: cascade.css || '' });
    });

    // ── API: Send message to cascade ──────────────────
    app.post('/send/:id', async (req, res) => {
        console.log(`📨 POST /send/${req.params.id} body:`, JSON.stringify(req.body).substring(0, 100));
        try {
            const cascade = cdpManager.cascades.get(req.params.id);
            if (!cascade) {
                console.log('📨 Cascade not found');
                return res.status(404).json({ ok: false, reason: 'Cascade not found' });
            }

            const { message } = req.body;
            if (!message) {
                console.log('📨 No message in body');
                return res.status(400).json({ ok: false, reason: 'No message provided' });
            }

            const result = await cdpManager.injectMessage(cascade.cdp, message);
            console.log(`📨 Inject result:`, result);
            if (result.ok) {
                res.json({ ok: true, method: result.method });
            } else {
                res.status(500).json({ ok: false, reason: result.reason });
            }
        } catch (err) {
            console.error('📨 Send error:', err);
            res.status(500).json({ ok: false, reason: err.message || 'Server error' });
        }
    });

    // ── API: Take screenshot ──────────────────────────
    app.get('/screenshot/:id', async (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) {
            return res.status(404).json({ error: 'Cascade not found' });
        }

        const png = await cdpManager.captureScreenshot(cascade.cdp);
        if (png) {
            res.type('image/png').send(png);
        } else {
            res.status(500).json({ error: 'Screenshot failed' });
        }
    });

    // ── API: Stop agent ───────────────────────────────
    app.post('/stop/:id', async (req, res) => {
        const cascade = cdpManager.cascades.get(req.params.id);
        if (!cascade) {
            return res.status(404).json({ error: 'Cascade not found' });
        }

        try {
            await cascade.cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"]');
                    if (stopBtn) { stopBtn.click(); return 'clicked'; }
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    return 'escape';
                })()`,
                returnByValue: true,
                contextId: cascade.cdp.rootContextId
            });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, reason: e.message });
        }
    });

    // ── API: Get status ───────────────────────────────
    app.get('/status', async (req, res) => {
        const cascade = cdpManager.getActiveCascade();
        if (!cascade) {
            return res.json({ connected: false });
        }

        const response = await cdpManager.extractResponseText(cascade.cdp);
        res.json({
            connected: true,
            cascadeId: cascade.id,
            title: cascade.metadata.chatTitle,
            textLength: response?.textLength || 0,
            messageCount: response?.messageCount || 0,
            isStreaming: response?.isStreaming || false
        });
    });

    // ── WebSocket — real-time updates ─────────────────
    wss.on('connection', (client) => {
        console.log('🔌 Web client connected');

        // Send current cascade list
        client.send(JSON.stringify({
            type: 'cascade_list',
            cascades: cdpManager.getCascadeList()
        }));
    });

    // Broadcast helper
    function broadcast(data) {
        const msg = JSON.stringify(data);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
            }
        });
    }

    // ── CDP Manager events → WebSocket ────────────────
    cdpManager.on('cascade:list', (list) => {
        broadcast({ type: 'cascade_list', cascades: list });
    });

    cdpManager.on('cascade:added', (cascade) => {
        broadcast({
            type: 'cascade_list',
            cascades: cdpManager.getCascadeList()
        });
    });

    cdpManager.on('cascade:removed', () => {
        broadcast({
            type: 'cascade_list',
            cascades: cdpManager.getCascadeList()
        });
    });

    cdpManager.on('snapshot:update', (cascade) => {
        broadcast({
            type: 'snapshot_update',
            cascadeId: cascade.id,
            title: cascade.metadata.chatTitle
        });
    });

    // ── Response Monitor events → WebSocket ───────────
    if (responseMonitor) {
        responseMonitor.on('phase', (event) => {
            broadcast({
                type: 'phase_change',
                phase: event.phase,
                prevPhase: event.prevPhase,
                cascadeId: event.cascadeId,
                title: event.cascade.metadata.chatTitle,
                messageCount: event.messageCount
            });
        });
    }

    // ── Start ─────────────────────────────────────────
    server.listen(port, '0.0.0.0', () => {
        console.log(`🌐 Web viewer: http://localhost:${port}`);
    });

    return { app, server, wss, broadcast };
}
