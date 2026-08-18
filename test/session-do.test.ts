import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function post(path: string, body?: unknown): Promise<Response> {
  return env.SESSION.getByName(`test-${path.replaceAll("/", "-")}`).fetch(new Request(`https://session.internal${path}`, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
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
});
