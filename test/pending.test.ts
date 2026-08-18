import { describe, expect, it } from "vitest";
import { Pending } from "../src/pending";

describe("Pending", () => {
  it("fails open immediately when nothing is connected", async () => {
    const request = new Pending<string>({ isConnected: () => false });
    expect(request.waiting).toBe(false);
    expect(await request.promise).toBeNull();
  });

  it("waits while connected and resolves with the settled value", async () => {
    const request = new Pending<string>({ timeoutMs: 5_000, isConnected: () => true });
    expect(request.waiting).toBe(true);
    request.settle("answer");
    expect(await request.promise).toBe("answer");
  });

  it("resolves null once the timeout elapses", async () => {
    const request = new Pending<string>({ timeoutMs: 20, isConnected: () => true });
    expect(await request.promise).toBeNull();
  });

  it("calls onSettled exactly once and ignores repeated settles", async () => {
    let settledCount = 0;
    const request = new Pending<string>({
      timeoutMs: 5_000,
      isConnected: () => true,
      onSettled: () => { settledCount += 1; },
    });
    request.settle("first");
    request.settle("second");
    expect(await request.promise).toBe("first");
    expect(settledCount).toBe(1);
  });
});
