import { describe, expect, it } from "vitest";
import {
  NtfyNotifier,
  NullNotifier,
  consoleUrl,
  createNotifier,
  permissionNotification,
  stopNotification,
} from "../src/notifier";

function recorder() {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: String(init.body) });
    return new Response("", { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("NtfyNotifier", () => {
  it("publishes a JSON body carrying topic, title, message and click", async () => {
    const { calls, fetchImpl } = recorder();
    await new NtfyNotifier("secret-topic", fetchImpl).notify({
      title: "Claude 等待批准",
      body: "Bash",
      clickUrl: "https://worker.test/s/demo-session",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.sh/");
    expect(JSON.parse(calls[0].body)).toEqual({
      topic: "secret-topic",
      title: "Claude 等待批准",
      message: "Bash",
      click: "https://worker.test/s/demo-session",
      priority: 4,
    });
  });

  it("swallows fetch failures instead of blocking the caller", async () => {
    const failing = async (): Promise<Response> => { throw new Error("network down"); };
    await expect(new NtfyNotifier("secret-topic", failing).notify({ title: "t", body: "b", clickUrl: "https://worker.test/s/x" })).resolves.toBeUndefined();
  });

  it("does not throw on a non-2xx response", async () => {
    const rejected = async (): Promise<Response> => new Response("nope", { status: 500 });
    await expect(new NtfyNotifier("secret-topic", rejected).notify({ title: "t", body: "b", clickUrl: "https://worker.test/s/x" })).resolves.toBeUndefined();
  });
});

describe("createNotifier", () => {
  it("returns a NullNotifier that sends nothing when NTFY_TOPIC is absent", async () => {
    const notifier = createNotifier({} as Env);
    expect(notifier).toBeInstanceOf(NullNotifier);
    await expect(notifier.notify({ title: "t", body: "b", clickUrl: "https://worker.test/s/x" })).resolves.toBeUndefined();
  });

  it("returns an NtfyNotifier when NTFY_TOPIC is configured", () => {
    expect(createNotifier({ NTFY_TOPIC: "secret-topic" } as Env)).toBeInstanceOf(NtfyNotifier);
  });
});

describe("notification content", () => {
  it("carries only the tool name for a permission request", () => {
    expect(permissionNotification("Bash", "https://worker.test/s/demo")).toEqual({
      title: "Claude 等待批准",
      body: "Bash",
      clickUrl: "https://worker.test/s/demo",
    });
  });

  it("uses fixed copy for a stop request so no reply text leaks", () => {
    expect(stopNotification("https://worker.test/s/demo")).toEqual({
      title: "Claude 已完成，等待指令",
      body: "点开控制台发送下一条指令",
      clickUrl: "https://worker.test/s/demo",
    });
  });

  it("builds the console url from the inbound origin and encodes the session id", () => {
    expect(consoleUrl("https://worker.test", "demo-session")).toBe("https://worker.test/s/demo-session");
    expect(consoleUrl("https://worker.test", "a b")).toBe("https://worker.test/s/a%20b");
  });
});
