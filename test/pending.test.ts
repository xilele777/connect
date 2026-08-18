import { describe, expect, it } from "vitest";
import { Pending, readTimeouts, type PendingTimeouts } from "../src/pending";

const TIMEOUTS: PendingTimeouts = { requestTimeoutMs: 200, remoteOfflineTimeoutMs: 40 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Pending tiered timeout", () => {
  it("fails open immediately when remote mode is off and nothing is connected", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: false, isConnected: () => false });
    expect(request.waiting).toBe(false);
    expect(await request.promise).toBeNull();
  });

  it("waits for the full window when remote mode is on and a phone is connected", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: true, isConnected: () => true });
    expect(request.waiting).toBe(true);
    await sleep(60);
    expect(request.waiting).toBe(true);
    request.settle("answer");
    expect(await request.promise).toBe("answer");
  });

  it("gives up after the offline window when remote mode is on and no phone connects", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: true, isConnected: () => false });
    expect(request.waiting).toBe(true);
    expect(await request.promise).toBeNull();
  });

  it("extends to the full window when a phone connects inside the offline window", async () => {
    let connected = false;
    setTimeout(() => { connected = true; }, 10);
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: true, isConnected: () => connected });
    await sleep(70);
    expect(request.waiting).toBe(true);
    request.settle("late answer");
    expect(await request.promise).toBe("late answer");
  });

  it("waits the full window then fails open when remote mode is off and a phone is connected", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: false, isConnected: () => true });
    expect(request.waiting).toBe(true);
    expect(await request.promise).toBeNull();
  });

  it("clears its timer on settle and never resolves twice", async () => {
    let settledCount = 0;
    const request = new Pending<string>({
      timeouts: TIMEOUTS,
      remoteMode: false,
      isConnected: () => true,
      onSettled: () => { settledCount += 1; },
    });
    request.settle("first");
    request.settle("second");
    await sleep(TIMEOUTS.requestTimeoutMs + 30);
    expect(await request.promise).toBe("first");
    expect(settledCount).toBe(1);
  });
});

describe("readTimeouts", () => {
  it("falls back to defaults for missing, blank and non-numeric values", () => {
    expect(readTimeouts({} as Env)).toEqual({ requestTimeoutMs: 590_000, remoteOfflineTimeoutMs: 90_000 });
    expect(readTimeouts({ REQUEST_TIMEOUT_MS: "  ", REMOTE_OFFLINE_TIMEOUT_MS: "abc" } as unknown as Env))
      .toEqual({ requestTimeoutMs: 590_000, remoteOfflineTimeoutMs: 90_000 });
  });

  it("clamps out-of-range values and keeps the offline window inside the total", () => {
    expect(readTimeouts({ REQUEST_TIMEOUT_MS: "99999999", REMOTE_OFFLINE_TIMEOUT_MS: "0" } as unknown as Env))
      .toEqual({ requestTimeoutMs: 590_000, remoteOfflineTimeoutMs: 10 });
    expect(readTimeouts({ REQUEST_TIMEOUT_MS: "100", REMOTE_OFFLINE_TIMEOUT_MS: "5000" } as unknown as Env))
      .toEqual({ requestTimeoutMs: 100, remoteOfflineTimeoutMs: 100 });
  });
});
