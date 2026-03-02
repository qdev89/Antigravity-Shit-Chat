/**
 * CDP Manager — discovers Antigravity targets, manages connections,
 * captures snapshots, injects messages, and takes screenshots.
 */
import http from 'http';
import WebSocket from 'ws';
import { connectCDP } from './connection.js';
import { EventEmitter } from 'events';

export class CDPManager extends EventEmitter {
    constructor(opts = {}) {
        super();
        this.ports = opts.ports || [9000, 9001, 9002, 9003];
        this.discoveryInterval = opts.discoveryInterval || 10000;
        this.pollInterval = opts.pollInterval || 3000;
        this.cascades = new Map();
        this._discoveryTimer = null;
        this._pollTimer = null;
    }

    // --- Helpers ---

    hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash.toString(36);
    }

    getJson(url) {
        return new Promise((resolve) => {
            const req = http.get(url, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch { resolve([]); }
                });
            });
            req.on('error', () => resolve([]));
            req.setTimeout(2000, () => { req.destroy(); resolve([]); });
        });
    }

    // --- CDP Scripts ---

    async extractMetadata(cdp) {
        const SCRIPT = `(() => {
            const chatPanel = document.getElementById('conversation')
                || document.getElementById('cascade')
                || document.querySelector('.antigravity-agent-side-panel');
            if (!chatPanel) return { found: false };

            let chatTitle = null;
            const titleBar = document.querySelector('.window-title');
            if (titleBar && titleBar.textContent.length > 2 && titleBar.textContent.length < 80) {
                chatTitle = titleBar.textContent.trim();
            }
            if (!chatTitle) chatTitle = document.title || 'Agent';

            return {
                found: true,
                chatTitle,
                isActive: document.hasFocus(),
                panelId: chatPanel.id || 'side-panel'
            };
        })()`;

        if (cdp.rootContextId) {
            try {
                const res = await cdp.call('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
                if (res.result?.value?.found) return { ...res.result.value, contextId: cdp.rootContextId };
            } catch { cdp.rootContextId = null; }
        }

        for (const ctx of cdp.contexts) {
            try {
                const result = await cdp.call('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: ctx.id });
                if (result.result?.value?.found) return { ...result.result.value, contextId: ctx.id };
            } catch { }
        }
        return null;
    }

    async captureCSS(cdp) {
        const SCRIPT = `(() => {
            let css = '';
            for (const sheet of document.styleSheets) {
                try {
                    for (const rule of sheet.cssRules) {
                        let text = rule.cssText;
                        text = text.replace(/(^|[\\s,}])body(?=[\\s,{])/gi, '$1.chat-mirror');
                        text = text.replace(/(^|[\\s,}])html(?=[\\s,{])/gi, '$1.chat-mirror');
                        css += text + '\\n';
                    }
                } catch (e) { }
            }
            return { css };
        })()`;

        if (!cdp.rootContextId) return '';
        try {
            const result = await cdp.call('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            return result.result?.value?.css || '';
        } catch { return ''; }
    }

    async captureHTML(cdp) {
        const SCRIPT = `(() => {
            const chatPanel = document.getElementById('conversation')
                || document.getElementById('cascade')
                || document.querySelector('.antigravity-agent-side-panel');
            if (!chatPanel) return { error: 'chat panel not found' };

            const clone = chatPanel.cloneNode(true);
            const editables = clone.querySelectorAll('[contenteditable="true"]');
            editables.forEach(el => {
                const wrapper = el.closest('.relative.w-full')?.parentElement;
                if (wrapper) wrapper.remove();
                else el.remove();
            });

            const bodyStyles = window.getComputedStyle(document.body);
            const sidePanel = document.querySelector('.antigravity-agent-side-panel');
            const panelStyles = sidePanel ? window.getComputedStyle(sidePanel) : null;

            return {
                html: clone.outerHTML,
                bodyBg: panelStyles?.backgroundColor || bodyStyles.backgroundColor,
                bodyColor: panelStyles?.color || bodyStyles.color
            };
        })()`;

        if (!cdp.rootContextId) return null;
        try {
            const result = await cdp.call('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            if (result.result?.value && !result.result.value.error) return result.result.value;
        } catch { }
        return null;
    }

    async captureScreenshot(cdp) {
        try {
            const result = await cdp.call('Page.captureScreenshot', { format: 'png', quality: 80 });
            if (result?.data) return Buffer.from(result.data, 'base64');
        } catch { }
        return null;
    }

    async extractResponseText(cdp) {
        const SCRIPT = `(() => {
            const chatPanel = document.getElementById('conversation')
                || document.getElementById('cascade')
                || document.querySelector('.antigravity-agent-side-panel');
            if (!chatPanel) return { text: '', messageCount: 0, debug: 'no panel' };

            // Get top-level child divs as "turns"
            const messages = chatPanel.querySelectorAll(':scope > div');
            const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

            // Only use the Stop button as streaming indicator — it's the most reliable signal
            // Antigravity shows a Stop/Cancel button ONLY while the agent is actively working
            const stopBtn = document.querySelector(
                'button[aria-label*="Stop"], button[aria-label*="Cancel"]'
            );

            // Get the last portion of the chat text directly
            const fullText = chatPanel.innerText || '';
            const lastChunk = fullText.slice(-2000);

            return {
                text: lastMsg ? lastMsg.innerText.substring(0, 2000) : lastChunk,
                messageCount: messages.length,
                isStreaming: !!stopBtn,
                isThinking: false,  // disabled — too many false positives
                fullText: fullText.substring(0, 4000),
                textLength: fullText.length
            };
        })()`;

        if (!cdp.rootContextId) return null;
        try {
            const result = await cdp.call('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            return result.result?.value || null;
        } catch { return null; }
    }

    /**
     * Diagnostic: probe the DOM structure of the chat panel.
     * Use this to discover what selectors work in the current Antigravity version.
     */
    async probeDOMStructure(cdp) {
        const SCRIPT = `(() => {
            const chatPanel = document.getElementById('conversation')
                || document.getElementById('cascade')
                || document.querySelector('.antigravity-agent-side-panel');
            if (!chatPanel) return { found: false };

            // Collect info about children
            const children = Array.from(chatPanel.children).map(el => ({
                tag: el.tagName,
                className: el.className?.substring?.(0, 100) || '',
                id: el.id || '',
                childCount: el.children.length,
                textPreview: el.innerText?.substring(0, 80) || ''
            }));

            // Check for buttons
            const buttons = Array.from(document.querySelectorAll('button')).map(b => ({
                text: b.innerText?.substring(0, 40) || '',
                ariaLabel: b.getAttribute('aria-label') || '',
                className: b.className?.substring?.(0, 60) || '',
                disabled: b.disabled
            })).filter(b => b.ariaLabel || b.text);

            return {
                found: true,
                panelId: chatPanel.id,
                panelClass: chatPanel.className?.substring?.(0, 100) || '',
                childCount: children.length,
                children: children.slice(-5), // last 5 children
                buttons: buttons.slice(-10), // last 10 buttons
                textLength: chatPanel.innerText?.length || 0
            };
        })()`;

        if (!cdp.rootContextId) return null;
        try {
            const result = await cdp.call('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, contextId: cdp.rootContextId });
            return result.result?.value || null;
        } catch { return null; }
    }

    async injectMessage(cdp, text) {
        console.log(`💉 Injecting message (${text.length} chars)...`);

        try {
            // Step 1: Focus the editor and clear it
            const focusResult = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    const editor = document.querySelector('[contenteditable="true"]')
                        || document.querySelector('textarea');
                    if (!editor) return { ok: false, reason: "no editor found" };
                    editor.focus();
                    // Clear existing text
                    if (editor.tagName === 'TEXTAREA') {
                        editor.value = '';
                    } else {
                        // Select all and delete for contenteditable
                        document.execCommand('selectAll', false, null);
                        document.execCommand('delete', false, null);
                    }
                    return { ok: true, tag: editor.tagName };
                })()`,
                returnByValue: true,
                contextId: cdp.rootContextId
            });

            const focusVal = focusResult.result?.value;
            if (!focusVal?.ok) {
                console.log(`💉 Focus failed:`, focusVal);
                return { ok: false, reason: focusVal?.reason || 'focus failed' };
            }

            // Step 2: Insert text instantly via CDP Input.insertText (fast!)
            // This simulates a paste and triggers React's input handlers
            try {
                await cdp.call('Input.insertText', { text });
                console.log(`💉 Text inserted via Input.insertText`);
            } catch {
                // Fallback: type char-by-char (slower but more compatible)
                console.log(`💉 insertText failed, falling back to char-by-char...`);
                for (const char of text) {
                    await cdp.call('Input.dispatchKeyEvent', {
                        type: 'keyDown', key: char, text: char, unmodifiedText: char,
                    });
                    await cdp.call('Input.dispatchKeyEvent', {
                        type: 'keyUp', key: char,
                    });
                }
            }

            // Step 3: Small delay to let React process the input and enable Send button
            await new Promise(r => setTimeout(r, 300));

            // Step 4: Try clicking the enabled Send button first
            const sendResult = await cdp.call('Runtime.evaluate', {
                expression: `(() => {
                    // Look for Send button - try multiple selectors
                    const btns = document.querySelectorAll('button');
                    for (const b of btns) {
                        const text = (b.innerText || '').trim().toLowerCase();
                        const label = (b.getAttribute('aria-label') || '').toLowerCase();
                        if ((text === 'send' || label.includes('send')) && !b.disabled) {
                            b.click();
                            return { ok: true, method: 'button', label: b.innerText };
                        }
                    }
                    return { ok: false, reason: 'no enabled send button' };
                })()`,
                returnByValue: true,
                contextId: cdp.rootContextId
            });

            const sendVal = sendResult.result?.value;
            if (sendVal?.ok) {
                console.log(`💉 Sent via button click`);
                return sendVal;
            }

            // Step 5: Fallback — press Enter via CDP (real keystroke)
            console.log(`💉 Send button not found/disabled, pressing Enter...`);
            await cdp.call('Input.dispatchKeyEvent', {
                type: 'keyDown', key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
            await cdp.call('Input.dispatchKeyEvent', {
                type: 'keyUp', key: 'Enter', code: 'Enter',
                windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });

            console.log(`💉 Sent via Enter key`);
            return { ok: true, method: 'enter' };

        } catch (e) {
            console.error('💉 CDP error:', e.message || e);
            return { ok: false, reason: e.message || String(e) };
        }
    }

    // --- Discovery ---

    async discover() {
        const allTargets = [];
        await Promise.all(this.ports.map(async (port) => {
            const list = await this.getJson(`http://127.0.0.1:${port}/json/list`);
            const workbenches = list.filter(t =>
                t.url?.includes('workbench.html') || t.title?.includes('workbench')
            );
            workbenches.forEach(t => allTargets.push({ ...t, port }));
        }));

        const newCascades = new Map();

        for (const target of allTargets) {
            const id = this.hashString(target.webSocketDebuggerUrl);

            if (this.cascades.has(id)) {
                const existing = this.cascades.get(id);
                if (existing.cdp.ws.readyState === WebSocket.OPEN) {
                    const meta = await this.extractMetadata(existing.cdp);
                    if (meta) {
                        existing.metadata = { ...existing.metadata, ...meta };
                        if (meta.contextId) existing.cdp.rootContextId = meta.contextId;
                        newCascades.set(id, existing);
                        continue;
                    }
                }
            }

            try {
                const cdp = await connectCDP(target.webSocketDebuggerUrl);
                const meta = await this.extractMetadata(cdp);
                if (meta) {
                    if (meta.contextId) cdp.rootContextId = meta.contextId;
                    const cascade = {
                        id,
                        cdp,
                        metadata: {
                            windowTitle: target.title,
                            chatTitle: meta.chatTitle,
                            isActive: meta.isActive
                        },
                        snapshot: null,
                        css: await this.captureCSS(cdp),
                        snapshotHash: null
                    };
                    newCascades.set(id, cascade);
                    console.log(`✨ Added cascade: ${meta.chatTitle}`);
                    this.emit('cascade:added', cascade);
                } else {
                    cdp.ws.close();
                }
            } catch { }
        }

        // Cleanup old
        for (const [id, c] of this.cascades.entries()) {
            if (!newCascades.has(id)) {
                console.log(`👋 Removing cascade: ${c.metadata.chatTitle}`);
                try { c.cdp.ws.close(); } catch { }
                this.emit('cascade:removed', c);
            }
        }

        const changed = this.cascades.size !== newCascades.size;
        this.cascades = newCascades;
        if (changed) this.emit('cascade:list', this.getCascadeList());
    }

    async updateSnapshots() {
        await Promise.all(Array.from(this.cascades.values()).map(async (c) => {
            try {
                const snap = await this.captureHTML(c.cdp);
                if (snap) {
                    const hash = this.hashString(snap.html);
                    if (hash !== c.snapshotHash) {
                        const oldHash = c.snapshotHash;
                        c.snapshot = snap;
                        c.snapshotHash = hash;
                        this.emit('snapshot:update', c, oldHash);
                    }
                }
            } catch { }
        }));
    }

    getCascadeList() {
        return Array.from(this.cascades.values()).map(c => ({
            id: c.id,
            title: c.metadata.chatTitle,
            window: c.metadata.windowTitle,
            active: c.metadata.isActive
        }));
    }

    getActiveCascade() {
        return Array.from(this.cascades.values()).find(c => c.metadata.isActive)
            || this.cascades.values().next().value || null;
    }

    start() {
        this.discover();
        this._discoveryTimer = setInterval(() => this.discover(), this.discoveryInterval);
        this._pollTimer = setInterval(() => this.updateSnapshots(), this.pollInterval);
    }

    stop() {
        if (this._discoveryTimer) clearInterval(this._discoveryTimer);
        if (this._pollTimer) clearInterval(this._pollTimer);
        for (const c of this.cascades.values()) {
            try { c.cdp.ws.close(); } catch { }
        }
    }
}
