/**
 * Telegram Bot — grammy-based bot for remote control of Antigravity.
 * Supports: /status, /screenshot, /send, /stop, /help, natural language prompts.
 */
import { Bot, InlineKeyboard, InputFile } from 'grammy';
import { PHASE } from '../monitor/response.js';

export class TelegramBot {
    constructor(cdpManager, responseMonitor, opts = {}) {
        this.cdp = cdpManager;
        this.monitor = responseMonitor;
        this.token = opts.token || process.env.TELEGRAM_BOT_TOKEN;
        this.allowedUsers = (opts.allowedUsers || process.env.ALLOWED_USER_IDS || '')
            .split(',')
            .map(id => parseInt(id.trim()))
            .filter(id => !isNaN(id));
        this.autoAccept = false;
        this.bot = null;
        this._activeCascadeId = null; // track which cascade Telegram controls
    }

    async start() {
        if (!this.token) {
            console.log('⚠️  No TELEGRAM_BOT_TOKEN set — Telegram bot disabled');
            console.log('   To enable: create a bot via @BotFather and add token to .env');
            return;
        }

        this.bot = new Bot(this.token);

        // Auth middleware
        this.bot.use(async (ctx, next) => {
            const userId = ctx.from?.id;
            if (this.allowedUsers.length > 0 && !this.allowedUsers.includes(userId)) {
                await ctx.reply('🚫 Unauthorized. Your ID: ' + userId);
                return;
            }
            await next();
        });

        // Register commands
        this._registerCommands();

        // Listen for natural language messages
        this.bot.on('message:text', async (ctx) => {
            const text = ctx.message.text;
            if (text.startsWith('/')) return; // already handled by commands

            // Natural language → inject into Antigravity
            const cascade = this._getTargetCascade();
            if (!cascade) {
                await ctx.reply('❌ No Antigravity connection. Make sure Antigravity is running with --remote-debugging-port=9000');
                return;
            }

            await ctx.reply(`📤 Sending to ${cascade.metadata.chatTitle}...`);

            const result = await this.cdp.injectMessage(cascade.cdp, text);
            if (result.ok) {
                await ctx.reply('✅ Message sent! Monitoring response...');
            } else {
                await ctx.reply(`❌ Failed to send: ${result.reason || 'unknown error'}`);
            }
        });

        // Handle photo messages (screenshots as context)
        this.bot.on('message:photo', async (ctx) => {
            const caption = ctx.message.caption || '';
            if (caption) {
                const cascade = this._getTargetCascade();
                if (!cascade) {
                    await ctx.reply('❌ No Antigravity connection');
                    return;
                }
                await ctx.reply(`📤 Sending: "${caption}"\n(Note: image not forwarded, only text)`);
                const result = await this.cdp.injectMessage(cascade.cdp, caption);
                if (!result.ok) await ctx.reply(`❌ Failed: ${result.reason}`);
            } else {
                await ctx.reply('📸 Got image, but no caption text to send. Add a caption with your instruction.');
            }
        });

        // Bind response monitor events
        this._bindMonitorEvents();

        // Start polling
        this.bot.start({
            onStart: (info) => console.log(`🤖 Telegram bot: @${info.username} connected`)
        });
    }

    _registerCommands() {
        // /start — welcome
        this.bot.command('start', async (ctx) => {
            const cascadeCount = this.cdp.cascades.size;
            await ctx.reply(
                `🚀 *Antigravity Shit\\-Chat Bot*\n\n` +
                `Connected to ${cascadeCount} cascade${cascadeCount !== 1 ? 's' : ''}\\.\n\n` +
                `*Commands:*\n` +
                `/status — Agent status\n` +
                `/screenshot — Capture IDE screenshot\n` +
                `/stop — Stop current task\n` +
                `/autoaccept — Toggle auto\\-approve\n` +
                `/help — Show all commands\n\n` +
                `Or just type a message to send it to Antigravity\\!`,
                { parse_mode: 'MarkdownV2' }
            );
        });

        // /help
        this.bot.command('help', async (ctx) => {
            await ctx.reply(
                '📖 *Commands*\n\n' +
                '/status — Current agent status + last message\n' +
                '/screenshot — Take screenshot of IDE\n' +
                '/cascades — List connected cascades\n' +
                '/select — Select active cascade\n' +
                '/stop — Send stop signal\n' +
                '/autoaccept — Toggle auto-approval\n' +
                '/help — This message\n\n' +
                '💬 *Natural Language*\n' +
                'Just type any message and it will be sent to Antigravity as a prompt.',
                { parse_mode: 'Markdown' }
            );
        });

        // /status
        this.bot.command('status', async (ctx) => {
            const cascade = this._getTargetCascade();
            if (!cascade) {
                await ctx.reply('❌ No Antigravity connection');
                return;
            }

            const response = await this.cdp.extractResponseText(cascade.cdp);
            const phaseEmoji = {
                idle: '💤', thinking: '🤔', streaming: '⚡', complete: '✅', error: '❌'
            };

            const state = this.monitor._getState(cascade.id);
            const emoji = phaseEmoji[state.phase] || '❓';

            let msg = `${emoji} *${this._escMd(cascade.metadata.chatTitle)}*\n`;
            msg += `Phase: ${state.phase}\n`;
            msg += `Messages: ${response?.messageCount || 0}\n`;

            if (response?.text) {
                const preview = response.text.substring(0, 300).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
                msg += `\nLast message:\n\`\`\`\n${preview}\n\`\`\``;
            }

            await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
        });

        // /screenshot
        this.bot.command('screenshot', async (ctx) => {
            const cascade = this._getTargetCascade();
            if (!cascade) {
                await ctx.reply('❌ No Antigravity connection');
                return;
            }

            await ctx.reply('📸 Capturing...');
            const png = await this.cdp.captureScreenshot(cascade.cdp);
            if (png) {
                await ctx.replyWithPhoto(new InputFile(png, 'screenshot.png'), {
                    caption: `📸 ${cascade.metadata.chatTitle}`
                });
            } else {
                await ctx.reply('❌ Screenshot failed');
            }
        });

        // /cascades
        this.bot.command('cascades', async (ctx) => {
            const list = this.cdp.getCascadeList();
            if (list.length === 0) {
                await ctx.reply('❌ No cascades connected');
                return;
            }

            const keyboard = new InlineKeyboard();
            for (const c of list) {
                const icon = c.active ? '🟢' : '⚪';
                const current = c.id === this._activeCascadeId ? ' ✓' : '';
                keyboard.text(`${icon} ${c.title}${current}`, `select:${c.id}`).row();
            }

            await ctx.reply('Select a cascade:', { reply_markup: keyboard });
        });

        // /select (alias for /cascades)
        this.bot.command('select', async (ctx) => {
            await ctx.api.sendMessage(ctx.chat.id, '/cascades');
        });

        // Inline button: cascade selection
        this.bot.callbackQuery(/^select:(.+)$/, async (ctx) => {
            const cascadeId = ctx.match[1];
            const cascade = this.cdp.cascades.get(cascadeId);
            if (cascade) {
                this._activeCascadeId = cascadeId;
                await ctx.answerCallbackQuery({ text: `Selected: ${cascade.metadata.chatTitle}` });
                await ctx.editMessageText(`✅ Active cascade: ${cascade.metadata.chatTitle}`);
            } else {
                await ctx.answerCallbackQuery({ text: 'Cascade not found' });
            }
        });

        // /stop
        this.bot.command('stop', async (ctx) => {
            const cascade = this._getTargetCascade();
            if (!cascade) {
                await ctx.reply('❌ No Antigravity connection');
                return;
            }

            // Press Escape or click stop button via CDP
            try {
                await cascade.cdp.call('Runtime.evaluate', {
                    expression: `(() => {
                        const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Cancel"], button[class*="stop"]');
                        if (stopBtn) { stopBtn.click(); return 'clicked'; }
                        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                        return 'escape';
                    })()`,
                    returnByValue: true,
                    contextId: cascade.cdp.rootContextId
                });
                await ctx.reply('🛑 Stop signal sent');
            } catch (e) {
                await ctx.reply(`❌ Failed to stop: ${e.message}`);
            }
        });

        // /autoaccept
        this.bot.command('autoaccept', async (ctx) => {
            this.autoAccept = !this.autoAccept;
            await ctx.reply(`Auto-accept: ${this.autoAccept ? '✅ ON' : '❌ OFF'}`);
        });

        // /probe — diagnostic: inspect DOM structure
        this.bot.command('probe', async (ctx) => {
            const cascade = this._getTargetCascade();
            if (!cascade) {
                await ctx.reply('❌ No Antigravity connection');
                return;
            }

            const probe = await this.cdp.probeDOMStructure(cascade.cdp);
            if (!probe || !probe.found) {
                await ctx.reply('❌ Chat panel not found in DOM');
                return;
            }

            let msg = `🔬 DOM Probe\n\n`;
            msg += `Panel: #${probe.panelId || '(none)'}\n`;
            msg += `Class: ${probe.panelClass?.substring(0, 60) || '(none)'}\n`;
            msg += `Children: ${probe.childCount}\n`;
            msg += `Text length: ${probe.textLength}\n\n`;

            msg += `Last 5 children:\n`;
            for (const child of probe.children || []) {
                msg += `  <${child.tag}> .${child.className?.substring(0, 40)} (${child.childCount} kids)\n`;
                if (child.textPreview) msg += `    "${child.textPreview.substring(0, 60)}"\n`;
            }

            msg += `\nButtons:\n`;
            for (const btn of (probe.buttons || []).slice(-5)) {
                msg += `  [${btn.text?.substring(0, 20) || btn.ariaLabel?.substring(0, 20)}] ${btn.disabled ? '(disabled)' : ''}\n`;
            }

            await ctx.reply(msg);
        });
    }

    _bindMonitorEvents() {
        if (!this.bot) return;

        this.monitor.on('phase', async (event) => {
            // Only notify for the active cascade (or all if none selected)
            if (this._activeCascadeId && event.cascadeId !== this._activeCascadeId) return;

            const chatId = this.allowedUsers[0]; // send to first allowed user
            if (!chatId) return;

            try {
                const projectName = this._shortTitle(event.cascade.metadata.chatTitle);

                switch (event.phase) {
                    case PHASE.STREAMING:
                        if (event.prevPhase === PHASE.IDLE) {
                            await this.bot.api.sendMessage(chatId,
                                `⚡ Agent started working\n📁 ${projectName}`
                            );
                        }
                        break;

                    case PHASE.COMPLETE: {
                        // Send completion with preview + quick action keyboard
                        let msg = `✅ Task complete\n📁 ${projectName}`;
                        if (event.message) {
                            const preview = event.message.substring(0, 600);
                            msg += `\n\n${preview}`;
                        }

                        const keyboard = new InlineKeyboard()
                            .text('📸 Screenshot', `action:screenshot:${event.cascadeId}`)
                            .text('🔄 Follow Up', `action:followup:${event.cascadeId}`);

                        await this.bot.api.sendMessage(chatId, msg.substring(0, 4000), {
                            reply_markup: keyboard
                        });
                        break;
                    }
                }
            } catch (e) {
                console.error('Telegram notification error:', e.message);
            }
        });

        // Handle quick action buttons
        this.bot.callbackQuery(/^action:(\w+):(.+)$/, async (ctx) => {
            const action = ctx.match[1];
            const cascadeId = ctx.match[2];
            const cascade = this.cdp.cascades.get(cascadeId);

            if (!cascade) {
                await ctx.answerCallbackQuery({ text: 'Cascade disconnected' });
                return;
            }

            switch (action) {
                case 'screenshot': {
                    await ctx.answerCallbackQuery({ text: 'Capturing...' });
                    const png = await this.cdp.captureScreenshot(cascade.cdp);
                    if (png) {
                        await ctx.replyWithPhoto(new InputFile(png, 'screenshot.png'));
                    } else {
                        await ctx.reply('❌ Screenshot failed');
                    }
                    break;
                }
                case 'followup':
                    this._activeCascadeId = cascadeId;
                    await ctx.answerCallbackQuery({ text: 'Ready for follow-up' });
                    await ctx.reply(`💬 Reply with your follow-up message for ${this._shortTitle(cascade.metadata.chatTitle)}`);
                    break;
            }
        });
    }

    _getTargetCascade() {
        if (this._activeCascadeId) {
            const c = this.cdp.cascades.get(this._activeCascadeId);
            if (c) return c;
        }
        return this.cdp.getActiveCascade();
    }

    _shortTitle(title) {
        if (!title) return 'Untitled';
        const parts = title.split(' - ');
        return parts[0] || title;
    }

    _escMd(text) {
        return (text || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
    }

    stop() {
        if (this.bot) this.bot.stop();
    }
}
