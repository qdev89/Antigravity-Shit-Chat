# Antigravity Shit-Chat v2 💩

**Dual-channel remote control for Antigravity IDE** — monitor and control your AI coding agent from anywhere.

- **Web Viewer** — live HTML snapshot viewer, mobile-friendly, works on LAN
- **Telegram Bot** — send tasks, get notifications, approve actions from your phone

Both channels share the same CDP core. Everything runs locally.

## Quick Start

### 1. Install

```bash
git clone https://github.com/gherghett/Antigravity-Shit-Chat.git
cd Antigravity-Shit-Chat
npm install
```

### 2. Launch Antigravity with CDP enabled

```bash
antigravity . --remote-debugging-port=9000
```

### 3. Start Shit-Chat

```bash
# Web viewer only (no Telegram)
node server.js

# With Telegram bot
cp .env.example .env
# Edit .env with your bot token and user ID
node server.js
```

That's it! Open `http://<your-local-ip>:3000` on your phone.

## Telegram Bot Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the token
2. Message [@userinfobot](https://t.me/userinfobot) to get your Telegram user ID
3. Create `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
ALLOWED_USER_IDS=123456789
```

4. Restart: `node server.js`

### Telegram Commands

| Command | Description |
|---|---|
| `/status` | Agent status + last message preview |
| `/screenshot` | Capture and send IDE screenshot |
| `/cascades` | List connected Antigravity windows |
| `/stop` | Stop current agent task |
| `/autoaccept` | Toggle auto-approval of file edits |
| `/help` | Show all commands |

**Natural language**: Just type any message and it's sent directly to Antigravity as a prompt.

### Example Interaction

```
You: refactor the auth module into separate files

Bot: 📤 Sending to Antigravity-Shit-Chat...
Bot: ✅ Message sent! Monitoring response...
Bot: ⚡ Agent started working
Bot: ✅ Task complete — Antigravity-Shit-Chat
     ```
     Created 4 files:
     • src/auth/login.js
     • src/auth/register.js
     • src/auth/middleware.js
     • src/auth/index.js
     ```
```

## Configuration

All settings in `.env` (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | *(empty)* | Telegram bot token from @BotFather |
| `ALLOWED_USER_IDS` | *(empty)* | Comma-separated Telegram user IDs |
| `PORT` | `3000` | Web viewer port |
| `CDP_PORTS` | `9000,9001,9002,9003` | CDP ports to scan |
| `DISCOVERY_INTERVAL` | `10000` | Target discovery interval (ms) |
| `POLL_INTERVAL` | `3000` | HTML snapshot poll interval (ms) |
| `MONITOR_INTERVAL` | `2000` | Agent phase detection interval (ms) |

## Architecture

```
┌──────────────┐     ┌───────────────┐
│  Web Viewer  │     │ Telegram Bot  │
│  (browser)   │     │  (grammy)     │
└──────┬───────┘     └──────┬────────┘
       │                     │
       └─────────┬───────────┘
                 ▼
        ┌────────────────┐
        │   Shared Core  │
        │                │
        │ • CDP Manager  │
        │ • Response     │
        │   Monitor      │
        └────────┬───────┘
                 ▼
        ┌────────────────┐
        │  Antigravity   │
        │  (CDP port)    │
        └────────────────┘
```

## Project Structure

```
server.js              # Main entry point
.env.example           # Configuration template
public/
  index.html           # Web viewer (mobile-friendly)
src/
  cdp/
    connection.js      # CDP WebSocket client
    manager.js         # Target discovery, snapshots, injection
    selectors.js       # DOM selector definitions
  web/
    server.js          # Express + WebSocket server
  monitor/
    response.js        # Agent phase detection (idle/thinking/streaming/complete)
  bot/
    telegram.js        # grammy Telegram bot
```

## How It Works

1. **CDP Manager** discovers Antigravity windows via Chrome DevTools Protocol
2. **Web Server** serves HTML snapshots to your phone's browser via WebSocket
3. **Response Monitor** polls the DOM to detect agent phases (thinking → working → done)
4. **Telegram Bot** sends notifications on phase changes and accepts natural language prompts
5. Everything runs locally — no cloud, no external servers, no API keys (except Telegram)

## Troubleshooting

| Problem | Solution |
|---|---|
| "No chats found" | Make sure Antigravity is running with `--remote-debugging-port=9000` |
| Port 3000 in use | Set `PORT=3001` in `.env` or kill the process using port 3000 |
| Telegram bot not responding | Check `TELEGRAM_BOT_TOKEN` in `.env`, restart server |
| Can't see from phone | Use `http://<your-local-ip>:3000` (check with `ipconfig`) |

## Inspired By

- [Remoat](https://github.com/optimistengineer/remoat) — Telegram remote control for Antigravity
- [LazyGravity](https://github.com/tokyoweb3/LazyGravity) — Original inspiration

## License

MIT
