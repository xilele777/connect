import { DurableObject } from "cloudflare:workers";
import { consoleUrl, createNotifier, permissionNotification, stopNotification, type Notifier } from "./notifier";
import { Pending, readTimeouts } from "./pending";
import {
  asRecord,
  parseClientMessage,
  parseQuestions,
  type ClientMessage,
  type PendingPermission,
  type PermissionDecision,
  type PermissionPayload,
  type RecentMessage,
  type ServerMessage,
  type Snapshot,
} from "./protocol";

interface PendingPermissionState {
  payload: PendingPermission;
  request: Pending<PermissionDecision>;
}

export class SessionDO extends DurableObject<Env> {
  private readonly notifier: Notifier;
  private readonly pendingPermissions = new Map<string, PendingPermissionState>();
  private pendingStop: Pending<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.notifier = createNotifier(env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS recent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.openSocket(request);
    }

    const path = new URL(request.url).pathname;
    try {
      if (request.method === "POST" && path === "/internal/permission") {
        const parsed = await this.readPermissionRequest(request);
        if (!parsed) return jsonResponse({ ok: false }, 400);
        const decision = await this.waitForPermission(parsed.payload, parsed.clickUrl);
        return decision ? jsonResponse(decision) : jsonResponse({ ok: false });
      }
      if (request.method === "POST" && path === "/internal/stop") {
        const body = await request.json<unknown>();
        const record = asRecord(body);
        if (!record || typeof record.lastMessage !== "string") return jsonResponse({ ok: false }, 400);
        const clickUrl = this.clickUrlFrom(record);
        await this.recordMessage(record.lastMessage);
        const text = await this.waitForStop(clickUrl);
        return text ? jsonResponse({ text }) : jsonResponse({ ok: false });
      }
      if (request.method === "POST" && path === "/internal/interrupt") {
        await this.setInterrupt();
        return jsonResponse({ ok: true });
      }
      if (request.method === "POST" && path === "/internal/interrupt/consume") {
        return jsonResponse({ interrupt: await this.consumeInterrupt() });
      }
      if (request.method === "GET" && path === "/internal/snapshot") {
        return jsonResponse(await this.snapshot());
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "session_error", error: error instanceof Error ? error.message : String(error) }));
      return jsonResponse({ ok: false }, 500);
    }
    return new Response("Not found", { status: 404 });
  }

  private openSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    void this.sendSnapshot(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "claude-remote-control" },
    });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message) as unknown;
    } catch {
      this.send(socket, { type: "error", message: "invalid JSON" });
      return;
    }
    const clientMessage = parseClientMessage(parsed);
    if (!clientMessage) {
      this.send(socket, { type: "error", message: "invalid message" });
      return;
    }
    this.handleClientMessage(clientMessage, socket);
  }

  webSocketClose(): void {
    // Pending requests intentionally remain alive so a phone reconnect can answer them.
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    console.warn(JSON.stringify({ event: "websocket_error", error: String(error) }));
    try { socket.close(1011, "socket error"); } catch { /* already closed */ }
  }

  private handleClientMessage(message: ClientMessage, socket: WebSocket): void {
    if (message.type === "decision") {
      const pending = this.pendingPermissions.get(message.id);
      if (!pending) {
        this.send(socket, { type: "error", message: "permission request is no longer pending" });
        return;
      }
      const decision: PermissionDecision = {
        behavior: message.answers ? "allow" : message.behavior,
        ...(message.always && message.behavior === "allow" ? { updatedPermissions: pending.payload.permissionSuggestions } : {}),
        ...(message.answers ? { updatedInput: buildUpdatedInput(pending.payload, message.answers) } : {}),
      };
      pending.request.settle(decision);
      return;
    }
    if (message.type === "message") {
      if (!this.pendingStop) {
        this.send(socket, { type: "error", message: "session is not waiting for a message" });
        return;
      }
      this.pendingStop.settle(message.text);
      return;
    }
    if (message.type === "remote_mode") {
      const state = this.writeRemoteMode(message.enabled);
      this.broadcast({ type: "remote_mode", enabled: state.enabled, expiresAt: state.expiresAt });
      return;
    }
    void this.setInterrupt().then(() => this.send(socket, { type: "interrupt_ack" }));
  }

  private clickUrlFrom(record: Record<string, unknown>): string {
    return consoleUrl(
      typeof record.origin === "string" ? record.origin : "",
      typeof record.sessionId === "string" ? record.sessionId : "",
    );
  }

  private async readPermissionRequest(request: Request): Promise<{ payload: PermissionPayload; clickUrl: string } | null> {
    const body = await request.json<unknown>();
    const record = asRecord(body);
    if (!record || typeof record.toolName !== "string" || !Array.isArray(record.permissionSuggestions)) return null;
    return {
      payload: {
        toolName: record.toolName,
        toolInput: record.toolInput ?? null,
        permissionSuggestions: record.permissionSuggestions,
      },
      clickUrl: this.clickUrlFrom(record),
    };
  }

  private async waitForPermission(payload: PermissionPayload, clickUrl: string): Promise<PermissionDecision | null> {
    const remote = this.readRemoteMode();
    const questions = parseQuestions(payload.toolInput);
    const pending: PendingPermission = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...payload,
      ...(questions ? { questions } : {}),
    };
    const request = new Pending<PermissionDecision>({
      timeouts: readTimeouts(this.env),
      remoteMode: remote.enabled,
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { this.pendingPermissions.delete(pending.id); },
    });
    if (!request.waiting) return null;
    this.pendingPermissions.set(pending.id, { payload: pending, request });
    this.broadcast({
      type: "permission",
      id: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      suggestions: pending.permissionSuggestions,
      ...(pending.questions ? { questions: pending.questions } : {}),
    });
    if (remote.enabled) void this.notifier.notify(permissionNotification(pending.toolName, clickUrl));
    return request.promise;
  }

  private async waitForStop(clickUrl: string): Promise<string | null> {
    const remote = this.readRemoteMode();
    this.pendingStop?.settle(null);
    let stored = false;
    const request = new Pending<string>({
      timeouts: readTimeouts(this.env),
      remoteMode: remote.enabled,
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { if (stored) this.pendingStop = null; },
    });
    if (!request.waiting) return null;
    stored = true;
    this.pendingStop = request;
    if (remote.enabled) void this.notifier.notify(stopNotification(clickUrl));
    return request.promise;
  }

  private async recordMessage(text: string): Promise<void> {
    if (!text) return;
    const createdAt = Date.now();
    this.ctx.storage.sql.exec("INSERT INTO recent_messages (text, created_at) VALUES (?, ?)", text, createdAt);
    const maxMessages = this.maxRecentMessages();
    this.ctx.storage.sql.exec("DELETE FROM recent_messages WHERE id NOT IN (SELECT id FROM recent_messages ORDER BY id DESC LIMIT ?)", maxMessages);
    this.broadcast({ type: "idle", lastMessage: text, createdAt });
  }

  private async snapshot(): Promise<Snapshot> {
    const rows = this.ctx.storage.sql.exec<{ id: number; text: string; created_at: number }>("SELECT id, text, created_at FROM recent_messages ORDER BY id DESC LIMIT ?", this.maxRecentMessages()).toArray();
    const recent: RecentMessage[] = rows.reverse().map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }));
    const pending = [...this.pendingPermissions.values()].map((item) => item.payload);
    const remote = this.readRemoteMode();
    return { pending, recent, remoteMode: remote.enabled, expiresAt: remote.expiresAt };
  }

  private async sendSnapshot(socket: WebSocket): Promise<void> {
    this.send(socket, { type: "snapshot", ...(await this.snapshot()) });
  }

  private broadcast(message: ServerMessage): void {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, message);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try { socket.send(JSON.stringify(message)); } catch { /* disconnected socket */ }
  }

  private maxRecentMessages(): number {
    const configured = Number(this.env.MAX_RECENT_MESSAGES);
    return Number.isFinite(configured) ? Math.min(200, Math.max(1, Math.floor(configured))) : 50;
  }

  private remoteModeTtlMs(): number {
    const configured = Number(this.env.REMOTE_MODE_TTL_MS);
    return Number.isFinite(configured) && configured > 0
      ? Math.min(86_400_000, Math.max(100, Math.floor(configured)))
      : 28_800_000;
  }

  /** Lazy expiry: compare the timestamp when reading instead of scheduling a DO alarm. */
  private readRemoteMode(): { enabled: boolean; expiresAt: number | null } {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM session_state WHERE key = 'remote_mode'").toArray()[0];
    const enabledAt = Number(row?.value ?? "0");
    if (!Number.isFinite(enabledAt) || enabledAt <= 0) return { enabled: false, expiresAt: null };
    const expiresAt = enabledAt + this.remoteModeTtlMs();
    return Date.now() < expiresAt ? { enabled: true, expiresAt } : { enabled: false, expiresAt: null };
  }

  private writeRemoteMode(enabled: boolean): { enabled: boolean; expiresAt: number | null } {
    this.ctx.storage.sql.exec(
      "INSERT INTO session_state (key, value) VALUES ('remote_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      enabled ? String(Date.now()) : "0",
    );
    return this.readRemoteMode();
  }

  private async setInterrupt(): Promise<void> {
    this.ctx.storage.sql.exec("INSERT INTO session_state (key, value) VALUES ('interrupt', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  }

  private async consumeInterrupt(): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM session_state WHERE key = 'interrupt'").toArray()[0];
    if (row?.value !== "1") return false;
    this.ctx.storage.sql.exec("UPDATE session_state SET value = '0' WHERE key = 'interrupt'");
    return true;
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

/** Echoes the original questions back and attaches the phone's picks so Claude Code skips its local prompt. */
function buildUpdatedInput(payload: PendingPermission, answers: Record<string, string>): unknown {
  const record = asRecord(payload.toolInput);
  const questions = Array.isArray(record?.questions) ? record.questions : undefined;
  return questions ? { questions, answers } : { answers };
}
