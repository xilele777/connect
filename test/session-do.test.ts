import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function post(path: string, body?: unknown): Promise<Response> {
  return env.SESSION.getByName(`test-${path.replaceAll("/", "-")}`).fetch(new Request(`https://session.internal${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPhone(name: string): Promise<WebSocket> {
  const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/ws", {
    headers: { Upgrade: "websocket" },
  }));
  const socket = response.webSocket;
  if (!socket) throw new Error("expected a websocket upgrade");
  socket.accept();
  return socket;
}

describe("SessionDO state machine", () => {
  it("fails open when no phone is connected", async () => {
    const response = await post("/internal/permission", { toolName: "Bash", toolInput: { command: "pwd" }, permissionSuggestions: [] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("sets, consumes, and clears the interrupt flag", async () => {
    const name = "interrupt-state";
    const stub = env.SESSION.getByName(name);
    await stub.fetch(new Request("https://session.internal/internal/interrupt", { method: "POST" }));
    const first = await stub.fetch(new Request("https://session.internal/internal/interrupt/consume", { method: "POST" }));
    const second = await stub.fetch(new Request("https://session.internal/internal/interrupt/consume", { method: "POST" }));
    expect(await first.json()).toEqual({ interrupt: true });
    expect(await second.json()).toEqual({ interrupt: false });
  });

  it("keeps recent assistant replies in a bounded snapshot", async () => {
    const name = "recent-state";
    const stub = env.SESSION.getByName(name);
    await stub.fetch(new Request("https://session.internal/internal/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lastMessage: "first reply" }) }));
    const response = await stub.fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ recent: Array<{ text: string }> }>();
    expect(snapshot.recent.map((item) => item.text)).toEqual(["first reply"]);
  });

  it("enables remote mode with an expiry and reports it in the snapshot", async () => {
    const name = "remote-mode-on";
    const socket = await connectPhone(name);
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    await sleep(20);
    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ remoteMode: boolean; expiresAt: number | null }>();
    expect(snapshot.remoteMode).toBe(true);
    expect(typeof snapshot.expiresAt).toBe("number");
    socket.close();
  });

  it("treats remote mode as off once the ttl has elapsed", async () => {
    const name = "remote-mode-ttl";
    const socket = await connectPhone(name);
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    await sleep(360);
    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ remoteMode: boolean; expiresAt: number | null }>();
    expect(snapshot.remoteMode).toBe(false);
    expect(snapshot.expiresAt).toBeNull();
    socket.close();
  });

  it("reports remote mode as off in a fresh session snapshot", async () => {
    const response = await env.SESSION.getByName("remote-mode-default").fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ remoteMode: boolean; expiresAt: number | null }>();
    expect(snapshot.remoteMode).toBe(false);
    expect(snapshot.expiresAt).toBeNull();
  });

  it("accepts the origin and session id forwarded by the worker", async () => {
    const stub = env.SESSION.getByName("origin-passthrough");
    const response = await stub.fetch(new Request("https://session.internal/internal/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastMessage: "done", origin: "https://worker.test", sessionId: "origin-passthrough" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("still fails open when remote mode is on but no phone ever connects", async () => {
    const name = "remote-mode-fail-open";
    const socket = await connectPhone(name);
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    await sleep(20);
    socket.close();
    await sleep(20);
    const started = Date.now();
    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "Bash", toolInput: { command: "pwd" }, permissionSuggestions: [], origin: "https://worker.test", sessionId: name }),
    }));
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(await response.json()).toEqual({ ok: false });
  });
});
