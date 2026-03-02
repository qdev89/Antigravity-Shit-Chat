/* AG Mission Control — App Logic */
(function () {
    // ── State ──────────────────────────────────────
    let cascades = [];
    let currentCascadeId = null;
    let ws = null;
    let phaseMap = {};
    let notificationsEnabled = false;
    let refreshTimer = null;
    let activePanel = 'projects'; // nav panel state

    const $ = id => document.getElementById(id);
    const $$ = sel => document.querySelectorAll(sel);

    // ── Theme ──────────────────────────────────────
    function initTheme() {
        const saved = localStorage.getItem('ag-theme');
        const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        setTheme(theme);
    }
    function setTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('ag-theme', t);
        const btn = $('themeToggle');
        if (btn) btn.textContent = t === 'dark' ? '🌙' : '☀️';
    }
    function toggleTheme() {
        setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    }

    // ── Notifications ──────────────────────────────
    function requestNotifications() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().then(p => { notificationsEnabled = (p === 'granted'); });
        } else notificationsEnabled = (Notification.permission === 'granted');
    }
    function playSound() {
        try {
            const ctx = new AudioContext(), osc = ctx.createOscillator(), g = ctx.createGain();
            osc.connect(g); g.connect(ctx.destination);
            osc.frequency.value = 880; osc.type = 'sine';
            g.gain.setValueAtTime(0.3, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
            osc.start(); osc.stop(ctx.currentTime + 0.3);
        } catch { }
    }
    function getPhase(id) { return phaseMap[id || currentCascadeId] || 'idle'; }

    // ── WebSocket ──────────────────────────────────
    function connect() {
        ws = new WebSocket(`ws://${location.host}`);
        ws.onopen = () => {
            $('connectionBadge').classList.remove('disconnected');
            $('connectionBadge').querySelector('span').textContent = 'Connected';
        };
        ws.onclose = () => {
            $('connectionBadge').classList.add('disconnected');
            $('connectionBadge').querySelector('span').textContent = 'Reconnecting...';
            setTimeout(connect, 2000);
        };
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'cascade_list') {
                cascades = data.cascades;
                renderCascadeList();
                if (!currentCascadeId && cascades.length > 0) selectCascade(cascades[0].id);
            }
            if (data.type === 'snapshot_update' && data.cascadeId === currentCascadeId) {
                updateChat(currentCascadeId);
            }
            if (data.type === 'phase_change') {
                updatePhase(data.phase, data.cascadeId, data.title);
            }
        };
    }

    // ── Cascade List ───────────────────────────────
    function renderCascadeList() {
        const list = $('cascadeList');
        if (!list) return;
        if (cascades.length === 0) {
            list.innerHTML = `<div class="empty-state" style="padding:30px"><div class="icon">🔍</div>
                <h3>No workspaces found</h3>
                <p>Launch Antigravity with<br><code>--remote-debugging-port=9000</code></p></div>`;
            return;
        }
        list.innerHTML = cascades.map(c => {
            const active = c.id === currentCascadeId;
            const phase = getPhase(c.id);
            const name = shortTitle(c.title);
            const emoji = { idle: '', streaming: '⚡', complete: '✅' };
            return `<div class="ws-item ${active ? 'active' : ''}" onclick="window.AG.selectCascade('${c.id}')">
                <div class="ws-dot ${phase}"></div>
                <div class="ws-info">
                    <div class="ws-name">${name} ${emoji[phase] || ''}</div>
                    <div class="ws-meta">${c.window || 'Port ' + (c.port || '9000')}</div>
                </div>
            </div>`;
        }).join('');
    }

    function shortTitle(title) {
        if (!title) return 'Untitled';
        return title.split(' - ')[0] || title;
    }

    // ── Cascade Actions ────────────────────────────
    function selectCascade(id) {
        currentCascadeId = id;
        renderCascadeList();
        loadCascade(id);
        // Close sidebar on mobile
        document.querySelector('.sidebar')?.classList.remove('open');
    }

    async function loadCascade(id) {
        const c = cascades.find(x => x.id === id);
        $('topbarTitle').textContent = c ? shortTitle(c.title) : 'AG Mission Control';
        $('topbarSubtitle').textContent = c ? (c.window || '') : '';
        try {
            const sr = await fetch(`/styles/${id}`);
            if (sr.ok) {
                const sd = await sr.json();
                const el = $('cascadeStyle');
                if (el) el.textContent = sd.css;
            }
            await updateChat(id);
        } catch (e) { console.error(e); }
    }

    async function updateChat(id) {
        try {
            const res = await fetch(`/snapshot/${id}`);
            if (!res.ok) throw new Error('Failed');
            const data = await res.json();
            const chatArea = $('chatArea');
            const chatContent = $('chatContent');
            if (!chatArea || !chatContent) return;
            const atBottom = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight < 80;
            chatContent.innerHTML = `<div class="chat-mirror">${data.html}</div>`;
            if (atBottom) requestAnimationFrame(() => chatArea.scrollTop = chatArea.scrollHeight);
        } catch { }
    }

    // ── Phase ──────────────────────────────────────
    function updatePhase(phase, cascadeId, title) {
        if (cascadeId) phaseMap[cascadeId] = phase;
        if (!cascadeId || cascadeId === currentCascadeId) {
            const badge = $('statusBadge');
            const text = $('statusText');
            if (badge) badge.className = `status-badge ${phase}`;
            const labels = { idle: '💤 Idle', streaming: '⚡ Streaming', complete: '✅ Complete' };
            if (text) text.textContent = labels[phase] || phase;
        }
        renderCascadeList();
        if (phase === 'complete') {
            const name = title || shortTitle((cascades.find(c => c.id === cascadeId) || {}).title) || 'Antigravity';
            showToast(`✅ ${name} — Task complete`);
            playSound();
            if (notificationsEnabled && document.hidden) {
                new Notification('AG Mission Control', { body: `✅ ${name} — Task complete`, tag: 'ag-' + cascadeId });
            }
        }
        if (phase === 'streaming' && cascadeId === currentCascadeId) showToast('⚡ Agent started...');
        startAutoRefresh();
    }

    // ── Send ───────────────────────────────────────
    async function sendMessage() {
        const input = $('messageInput');
        const btn = $('sendBtn');
        if (!input) { showToast('❌ Input not found'); return; }
        if (!currentCascadeId) { showToast('❌ No project selected — tap a workspace first'); return; }
        const text = input.value.trim();
        if (!text) { showToast('💬 Type a message first'); return; }
        if (btn) btn.disabled = true;
        showToast('📤 Sending...');
        requestNotifications();
        try {
            const res = await fetch(`/send/${currentCascadeId}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
            });
            const data = await res.json();
            if (data.ok) { input.value = ''; input.style.height = 'auto'; showToast('✅ Sent!'); }
            else showToast(`❌ ${data.reason || 'Send failed'}`);
        } catch (err) { showToast('❌ Connection error: ' + (err.message || '')); }
        if (btn) btn.disabled = false;
    }

    // ── Actions ────────────────────────────────────
    async function takeScreenshot() {
        if (!currentCascadeId) return;
        showToast('📸 Capturing...');
        try {
            const res = await fetch(`/screenshot/${currentCascadeId}`);
            if (res.ok) {
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const w = window.open('', '_blank', 'width=800,height=600');
                w.document.write(`<img src="${url}" style="max-width:100%;height:auto">`);
                showToast('📸 Screenshot ready');
            }
        } catch { showToast('❌ Screenshot failed'); }
    }

    async function stopAgent() {
        if (!currentCascadeId) return;
        try {
            await fetch(`/stop/${currentCascadeId}`, { method: 'POST' });
            showToast('🛑 Stop signal sent');
        } catch { showToast('❌ Stop failed'); }
    }

    // ── Settings Panel ─────────────────────────────
    function toggleRightPanel() {
        const panel = $('rightPanel');
        if (panel) panel.classList.toggle('open');
    }

    // ── Add Workspace Modal ────────────────────────
    function showAddWorkspace() {
        const modal = $('addWsModal');
        if (modal) modal.classList.add('open');
    }
    function closeAddWorkspace() {
        const modal = $('addWsModal');
        if (modal) modal.classList.remove('open');
    }
    function addWorkspace() {
        const host = $('wsHost')?.value || 'localhost';
        const port = $('wsPort')?.value || '9000';
        showToast(`🔍 Scanning ${host}:${port}...`);
        closeAddWorkspace();
        // Server-side: would trigger a CDP scan on the specified port
        // For MVP: just show feedback
        setTimeout(() => showToast(`⚡ Connect to AG at ${host}:${port} manually`), 1000);
    }

    // ── Nav ────────────────────────────────────────
    function switchNav(panel) {
        activePanel = panel;
        $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.panel === panel));
        // Show/hide sidebar sections based on nav
        $$('.sidebar-section').forEach(s => {
            s.style.display = s.dataset.panel === panel ? 'block' : 'none';
        });
        // Show right panel for settings
        if (panel === 'settings') toggleRightPanel();
    }

    // ── Toast ──────────────────────────────────────
    function showToast(msg) {
        const container = $('toastContainer');
        if (!container) return;
        const t = document.createElement('div');
        t.className = 'toast';
        t.textContent = msg;
        container.appendChild(t);
        setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3000);
    }

    // ── Auto Refresh ───────────────────────────────
    function startAutoRefresh() {
        stopAutoRefresh();
        const p = getPhase(currentCascadeId);
        refreshTimer = setInterval(() => { if (currentCascadeId) updateChat(currentCascadeId); }, p === 'streaming' ? 2000 : 5000);
    }
    function stopAutoRefresh() { if (refreshTimer) clearInterval(refreshTimer); }

    // ── Mobile ─────────────────────────────────────
    function toggleSidebar() {
        document.querySelector('.sidebar')?.classList.toggle('open');
    }

    // ── Init ───────────────────────────────────────
    function init() {
        initTheme();
        connect();
        startAutoRefresh();

        // Event listeners — click + touchend for mobile reliability
        const sendBtn = $('sendBtn');
        const msgInput = $('messageInput');
        if (sendBtn) {
            sendBtn.addEventListener('click', sendMessage);
            sendBtn.addEventListener('touchend', (e) => { e.preventDefault(); sendMessage(); });
        }
        if (msgInput) {
            msgInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
            });
            msgInput.addEventListener('input', function () {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });
        }

        // Expose API (including sendMessage for onclick fallback)
        window.AG = {
            selectCascade, sendMessage, toggleTheme, takeScreenshot, stopAgent,
            showAddWorkspace, closeAddWorkspace, addWorkspace,
            toggleRightPanel, switchNav, toggleSidebar
        };
    }

    document.addEventListener('DOMContentLoaded', init);
})();
