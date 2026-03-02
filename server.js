#!/usr/bin/env node
/**
 * Antigravity Shit-Chat v2 — AG Mission Control
 * 
 * Dual-channel remote control for Antigravity IDE:
 * - Web portal: premium dashboard — monitor, send tasks, screenshots
 * - Telegram bot: mobile remote control + push notifications
 * 
 * Both channels share the same CDP core.
 */
import 'dotenv/config';
import { CDPManager } from './src/cdp/manager.js';
import { createWebServer } from './src/web/server.js';
import { ResponseMonitor } from './src/monitor/response.js';
import { TelegramBot } from './src/bot/telegram.js';

async function main() {
    console.log('');
    console.log('  ┌─────────────────────────────────┐');
    console.log('  │   AG Mission Control         🚀  │');
    console.log('  │   Web Portal + Telegram Bot      │');
    console.log('  └─────────────────────────────────┘');
    console.log('');

    // 1. CDP Manager — connects to Antigravity via Chrome DevTools Protocol
    const cdp = new CDPManager({
        ports: (process.env.CDP_PORTS || '9000,9001,9002,9003').split(',').map(Number),
        discoveryInterval: parseInt(process.env.DISCOVERY_INTERVAL || '10000'),
        pollInterval: parseInt(process.env.POLL_INTERVAL || '3000')
    });

    // 2. Response Monitor — tracks agent activity phases
    const monitor = new ResponseMonitor(cdp, {
        pollInterval: parseInt(process.env.MONITOR_INTERVAL || '2000')
    });

    // 3. Web Server — AG Mission Control dashboard
    const web = createWebServer(cdp, monitor, {
        port: parseInt(process.env.PORT || '3000')
    });

    // 4. Telegram Bot — grammy-based remote control
    const telegram = new TelegramBot(cdp, monitor, {
        token: process.env.TELEGRAM_BOT_TOKEN,
        allowedUsers: process.env.ALLOWED_USER_IDS
    });

    // Start everything
    cdp.start();
    monitor.start();
    await telegram.start();

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n🛑 Shutting down...');
        telegram.stop();
        monitor.stop();
        cdp.stop();
        web.server.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
});
