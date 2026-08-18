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

## Deploy

```powershell
npm run types
npm run typecheck
npm test
npm run deploy:check
wrangler secret put COMPUTER_TOKEN
wrangler secret put PHONE_TOKEN
npm run deploy
```

The Worker fails open on missing credentials, malformed requests, network errors, offline phones, and timeouts: all of those paths return an empty/non-blocking hook response rather than approving a command.
