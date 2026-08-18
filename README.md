# Claude Remote Control

Cloudflare Worker + Durable Object for controlling a Claude Code session from a phone browser. The current slice includes permission decisions, stop-hook message injection, soft interrupt polling, WebSocket reconnect snapshots, and a mobile console.

## Local development

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
# Replace the two local token values in .dev.vars
npm run dev -- --port 8787
```

Open `http://127.0.0.1:8787/s/<session_id>` on the phone and enter `PHONE_TOKEN`. The browser keeps that token in `localStorage`; it is sent in the WebSocket subprotocol, never in the URL.

## Claude Code hooks

Set these environment variables in the computer session that runs Claude Code:

```powershell
$env:CLAUDE_REMOTE_CONTROL_URL = 'https://your-worker.example.workers.dev'
$env:CLAUDE_REMOTE_CONTROL_TOKEN = '<computer token>'
```

Add the following to `~/.claude/settings.json`, preserving any existing hooks. The two HTTP hooks are synchronous by design; the command hook is asynchronous and only runs after Bash tools.

```json
{
  "hooks": {
    "PermissionRequest": [{
      "hooks": [{
        "type": "http",
        "url": "https://your-worker.example.workers.dev/hook/permission",
        "timeout": 600,
        "headers": { "Authorization": "Bearer $CLAUDE_REMOTE_CONTROL_TOKEN" },
        "allowedEnvVars": ["CLAUDE_REMOTE_CONTROL_TOKEN"]
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "http",
        "url": "https://your-worker.example.workers.dev/hook/stop",
        "timeout": 600,
        "headers": { "Authorization": "Bearer $CLAUDE_REMOTE_CONTROL_TOKEN" },
        "allowedEnvVars": ["CLAUDE_REMOTE_CONTROL_TOKEN"]
      }]
    }],
    "PostToolUse": [{
      "matcher": "Bash(*)",
      "hooks": [{
        "type": "command",
        "shell": "powershell",
        "command": "& 'C:\\path\\to\\connect\\hooks\\remote-interrupt.ps1'",
        "asyncRewake": true
      }]
    }]
  }
}
```

Claude Code's HTTP hook supports environment interpolation in headers when the variable is listed in `allowedEnvVars`; the example uses that mechanism so the computer token never appears in `settings.json`.

## Remote mode

Remote mode is **off by default**, and while it is off the system behaves exactly as it did before: if no phone is connected, hook requests return immediately and you get the normal local prompt with zero added latency.

Turn it on from the toggle in the top-right of the phone console when you are away from the computer. While it is on:

- Every suspended permission request and every end-of-turn `Stop` sends an ntfy push.
- If no phone is connected, the request waits `REMOTE_OFFLINE_TIMEOUT_MS` (90 s by default) for one to connect. If one does, it waits up to the 590 s total; if not, it fails open.
- The mode expires on its own after `REMOTE_MODE_TTL_MS` (8 hours by default), so forgetting to switch it off costs you at most one night.

Pushes deliberately carry no `tool_input` and no reply text - only the tool name, or fixed copy for `Stop`. You have to open the token-protected console to see anything else.

### ntfy setup

Install the [ntfy](https://ntfy.sh/) app, subscribe to a topic that nobody else could guess, then:

```powershell
wrangler secret put NTFY_TOPIC
```

The topic name is itself a credential: anyone who knows it can read every notification you send. Never put it in `wrangler.jsonc`.

### Tunables

These live in `wrangler.jsonc` under `vars` and are all strings:

| Var | Default | Purpose |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | `590000` | Total suspension ceiling, inside the hook's 600 s limit |
| `REMOTE_OFFLINE_TIMEOUT_MS` | `90000` | How long a remote-mode request waits for a phone to connect |
| `REMOTE_MODE_TTL_MS` | `28800000` | How long remote mode stays on before expiring by itself |

## Connect the current session from your phone

Every Claude Code session has its own URL, and the session ID changes when you start a new session (a fresh VSCode window or `/clear`). To get the URL of the session you are in right now, run:

```powershell
pwsh -NoProfile -File scripts/get-session.ps1
```

It reads the project directory from the current working directory, takes the most recently modified session file under `~/.claude/projects/<project>/`, and prints the console URL. Open that URL on the phone and enter the phone token.

When you want to use the "继续指令" input on the phone, note that it only lands while the end-of-turn `Stop` hook is suspended - i.e. **after** Claude has finished its turn and while either the phone is connected or remote mode is on. If Claude is still working, or the hook already returned, the message is dropped. Keep the phone page in the foreground and, when away from the computer, turn on remote mode so the stop window stays open for `REMOTE_OFFLINE_TIMEOUT_MS`.

## Deploy

```powershell
npm run types
npm run typecheck
npm test
npm run deploy:check
wrangler secret put COMPUTER_TOKEN
wrangler secret put PHONE_TOKEN
wrangler secret put NTFY_TOPIC
npm run deploy
```

The Worker fails open on missing credentials, malformed requests, network errors, offline phones, and timeouts: all of those paths return an empty/non-blocking hook response rather than approving a command.
