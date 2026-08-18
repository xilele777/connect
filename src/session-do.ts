import { DurableObject } from "cloudflare:workers";
import { Pending, readTimeouts } from "./pending";
import {
  asRecord,
  parseClientMessage,
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
  private readonly pendingPermissions = new Map<string, PendingPermissionState>();
  private pendingStop: Pending<string> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
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
        const payload = await this.readPayload(request);
        if (!payload) return jsonResponse({ ok: false }, 400);
        const decision = await this.waitForPermission(payload);
        return decision ? jsonResponse(decision) : jsonResponse({ ok: false });
      }
      if (request.method === "POST" && path === "/internal/stop") {
        const body = await request.json<unknown>();
        const record = asRecord(body);
        if (!record || typeof record.lastMessage !== "string") return jsonResponse({ ok: false }, 400);
        const message = record.lastMessage;
        await this.recordMessage(message);
        const text = await this.waitForStop();
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
        behavior: message.behavior,
        ...(message.always && message.behavior === "allow" ? { updatedPermissions: pending.payload.permissionSuggestions } : {}),
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
    void this.setInterrupt().then(() => this.send(socket, { type: "interrupt_ack" }));
  }

  private async readPayload(request: Request): Promise<PermissionPayload | null> {
    const body = await request.json<unknown>();
    const record = asRecord(body);
    if (!record || typeof record.toolName !== "string" || !Array.isArray(record.permissionSuggestions)) return null;
    return {
      toolName: record.toolName,
      toolInput: record.toolInput ?? null,
      permissionSuggestions: record.permissionSuggestions,
    };
  }

  private async waitForPermission(payload: PermissionPayload): Promise<PermissionDecision | null> {
    const pending: PendingPermission = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...payload,
    };
    const request = new Pending<PermissionDecision>({
      timeouts: readTimeouts(this.env),
      remoteMode: false,
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { this.pendingPermissions.delete(pending.id); },
    });
    if (!request.waiting) return null;
    this.pendingPermissions.set(pending.id, { payload: pending, request });
    this.broadcast({ type: "permission", id: pending.id, toolName: pending.toolName, toolInput: pending.toolInput, suggestions: pending.permissionSuggestions });
    return request.promise;
  }

  private async waitForStop(): Promise<string | null> {
    this.pendingStop?.settle(null);
    let stored = false;
    const request = new Pending<string>({
      timeouts: readTimeouts(this.env),
      remoteMode: false,
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { if (stored) this.pendingStop = null; },
    });
    if (!request.waiting) return null;
    stored = true;
    this.pendingStop = request;
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
    return { pending, recent };
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
