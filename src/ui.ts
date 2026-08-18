import type { RecentMessage, PendingPermission } from "./protocol";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderConsole(sessionId: string): string {
  const safeSessionId = escapeHtml(sessionId);
  const serializedSessionId = JSON.stringify(sessionId).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';">
  <title>Claude Remote Control</title>
  <style>
    :root { color-scheme: dark; --bg: #0d1117; --panel: #161b22; --line: #30363d; --muted: #8b949e; --text: #f0f6fc; --accent: #2dd4bf; --warn: #f59e0b; --danger: #fb7185; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(900px, 100%); margin: 0 auto; padding: 20px 16px 48px; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 20px; }
    h1 { margin: 0; font-size: 20px; letter-spacing: 0; }
    .session { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .status { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 13px; white-space: nowrap; }
    .status::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
    .status.online::before { background: var(--accent); }
    #remote-toggle { min-height: 34px; padding: 6px 11px; font-size: 13px; white-space: nowrap; }
    section { margin-top: 20px; }
    section > h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 10px; }
    .empty { border: 1px dashed var(--line); color: var(--muted); padding: 18px; text-align: center; }
    #error-banner { display: none; margin-bottom: 16px; border: 1px solid var(--danger); background: #3d0d16; color: var(--text); padding: 10px 14px; font-size: 13px; }
    #error-banner.show { display: block; }
    .permission, .message { border: 1px solid var(--line); background: var(--panel); padding: 14px; margin-bottom: 10px; }
    .permission { border-left: 3px solid var(--warn); }
    .permission-title { display: flex; justify-content: space-between; gap: 10px; font-weight: 650; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; color: #c9d1d9; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button { border: 1px solid var(--line); border-radius: 6px; min-height: 40px; padding: 8px 13px; color: var(--text); background: #21262d; font: inherit; cursor: pointer; }
    button:hover { border-color: #8b949e; }
    button.primary { background: #0f766e; border-color: #14b8a6; }
    button.danger { background: #881337; border-color: #fb7185; }
    button:disabled { cursor: wait; opacity: .6; }
    form.compose { display: flex; gap: 8px; align-items: stretch; }
    textarea, input { width: 100%; border: 1px solid var(--line); border-radius: 6px; background: #0d1117; color: var(--text); padding: 10px; font: inherit; }
    textarea { min-height: 78px; resize: vertical; }
    .compose button { align-self: flex-end; }
    #token-panel { max-width: 520px; margin: 15vh auto 0; }
    #token-panel p { color: var(--muted); margin-top: 4px; }
    .hidden { display: none !important; }
    @media (max-width: 560px) { main { padding: 14px 12px 34px; } header { align-items: flex-start; flex-direction: column; } .compose { flex-direction: column; } .compose button { width: 100%; } }
  </style>
</head>
<body>
  <main id="token-panel" class="hidden">
    <h1>连接 Claude 会话</h1>
    <p>输入手机端 token 以建立安全连接。</p>
    <form id="token-form"><input id="token" type="password" autocomplete="off" required placeholder="Phone token"><div class="actions"><button class="primary" type="submit">连接</button></div></form>
  </main>
  <main id="app" class="hidden">
    <header><div><h1>Claude Remote Control</h1><div class="session">会话 ${safeSessionId}</div></div><div><div id="status" class="status">未连接</div><div class="actions"><button id="remote-toggle" type="button">远程模式 关</button></div></div></header>
    <div id="error-banner" role="alert"></div>
    <section><h2>待处理权限</h2><div id="permissions"><div class="empty">暂无待处理请求</div></div></section>
    <section><h2>对话</h2><div id="messages"><div class="empty">等待 Claude 回复</div></div></section>
    <section><form id="compose" class="compose"><textarea id="message" placeholder="继续指令" aria-label="继续指令"></textarea><button class="primary" type="submit">发送</button></form><div class="actions"><button id="interrupt" class="danger" type="button">停止当前任务</button></div></section>
  </main>
  <script>
    (() => {
      const sessionId = ${serializedSessionId};
      const tokenKey = 'claude-remote-token:' + sessionId;
      const tokenPanel = document.getElementById('token-panel');
      const app = document.getElementById('app');
      const status = document.getElementById('status');
      const permissions = document.getElementById('permissions');
      const messages = document.getElementById('messages');
      let socket;
      let recent = [];
      let pending = [];
      let remoteMode = { enabled: false, expiresAt: null };
      const remoteToggle = document.getElementById('remote-toggle');
      const errorBanner = document.getElementById('error-banner');
      let errorTimer = null;
      function showError(message) {
        errorBanner.textContent = message;
        errorBanner.classList.add('show');
        if (errorTimer) clearTimeout(errorTimer);
        errorTimer = setTimeout(() => errorBanner.classList.remove('show'), 5000);
      }
      function setStatus(text, online) { status.textContent = text; status.classList.toggle('online', online); }
      function encode(value) { const bytes = new TextEncoder().encode(value); let binary = ''; bytes.forEach((b) => { binary += String.fromCharCode(b); }); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
      function renderRemoteMode() {
        if (!remoteMode.enabled) { remoteToggle.textContent = '远程模式 关'; remoteToggle.classList.remove('primary'); return; }
        const minutes = Math.max(0, Math.round(((remoteMode.expiresAt || Date.now()) - Date.now()) / 60000));
        remoteToggle.textContent = '远程模式 开 · 剩余 ' + minutes + ' 分钟';
        remoteToggle.classList.add('primary');
      }
      function render() {
        permissions.replaceChildren();
        if (!pending.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂无待处理请求'; permissions.append(empty); }
        pending.forEach((item) => {
          const card = document.createElement('article'); card.className = 'permission';
          const title = document.createElement('div'); title.className = 'permission-title'; title.textContent = item.toolName;
          const body = document.createElement('pre'); body.textContent = JSON.stringify(item.toolInput, null, 2);
          const actions = document.createElement('div'); actions.className = 'actions';
          [['allow', '允许', 'primary'], ['allow-always', '总是允许这类', 'primary'], ['deny', '拒绝', 'danger']].forEach(([mode, label, style]) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = style; button.onclick = () => decide(item.id, mode); actions.append(button); });
          card.append(title, body, actions); permissions.append(card);
        });
        messages.replaceChildren();
        if (!recent.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '等待 Claude 回复'; messages.append(empty); }
        recent.forEach((item) => { const message = document.createElement('article'); message.className = 'message'; message.textContent = item.text; messages.append(message); });
        renderRemoteMode();
      }
      function decide(id, mode) { if (!socket || socket.readyState !== WebSocket.OPEN) return; socket.send(JSON.stringify({ type: 'decision', id, behavior: mode === 'deny' ? 'deny' : 'allow', always: mode === 'allow-always' })); pending = pending.filter((item) => item.id !== id); render(); }
      function connect(token) {
        app.classList.remove('hidden'); tokenPanel.classList.add('hidden'); setStatus('连接中', false);
        const url = location.origin.replace(/^http/, 'ws') + '/ws/' + encodeURIComponent(sessionId);
        socket = new WebSocket(url, ['claude-remote-control', 'token.' + encode(token)]);
        socket.onopen = () => setStatus('已连接', true);
        socket.onmessage = (event) => { try { const data = JSON.parse(event.data); if (data.type === 'snapshot') { pending = data.pending || []; recent = data.recent || []; remoteMode = { enabled: data.remoteMode === true, expiresAt: data.expiresAt ?? null }; render(); } else if (data.type === 'permission') { pending = pending.concat([data]); render(); } else if (data.type === 'idle') { recent = recent.concat([{ text: data.lastMessage, createdAt: data.createdAt }]).slice(-50); render(); } else if (data.type === 'remote_mode') { remoteMode = { enabled: data.enabled === true, expiresAt: data.expiresAt ?? null }; renderRemoteMode(); } else if (data.type === 'error') { showError(data.message || '会话返回了错误'); } } catch (_) {} };
        socket.onclose = (event) => { setStatus('连接断开', false); if (event.code === 1008) { localStorage.removeItem(tokenKey); tokenPanel.classList.remove('hidden'); app.classList.add('hidden'); } else { setTimeout(() => { const saved = localStorage.getItem(tokenKey); if (saved) connect(saved); }, 2500); } };
        socket.onerror = () => setStatus('连接失败', false);
      }
      document.getElementById('token-form').addEventListener('submit', (event) => { event.preventDefault(); const token = document.getElementById('token').value.trim(); if (!token) return; localStorage.setItem(tokenKey, token); connect(token); });
      document.getElementById('compose').addEventListener('submit', (event) => { event.preventDefault(); const input = document.getElementById('message'); const text = input.value.trim(); if (!text) return; if (!socket || socket.readyState !== WebSocket.OPEN) { showError('未连接到会话，请检查网络或等待自动重连'); return; } socket.send(JSON.stringify({ type: 'message', text })); input.value = ''; });
      document.getElementById('interrupt').addEventListener('click', () => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'interrupt' })); });
      remoteToggle.addEventListener('click', () => { if (!socket || socket.readyState !== WebSocket.OPEN) return; socket.send(JSON.stringify({ type: 'remote_mode', enabled: !remoteMode.enabled })); });
      setInterval(renderRemoteMode, 30000);
      const saved = localStorage.getItem(tokenKey); if (saved) connect(saved); else tokenPanel.classList.remove('hidden');
    })();
  </script>
</body>
</html>`;
}

export type UiMessage = RecentMessage | PendingPermission;
