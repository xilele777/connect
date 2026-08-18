export interface PendingTimeouts {
  /** Total wait ceiling in milliseconds. */
  requestTimeoutMs: number;
  /** First-stage window for a phone to connect in remote mode. */
  remoteOfflineTimeoutMs: number;
}

export interface PendingOptions {
  timeouts: PendingTimeouts;
  /** Keeps the original immediate fail-open behavior when disabled. */
  remoteMode: boolean;
  /** Checked at construction and once more after the offline window. */
  isConnected: () => boolean;
  /** Called exactly once after the request settles. */
  onSettled?: () => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 590_000;
const DEFAULT_REMOTE_OFFLINE_TIMEOUT_MS = 90_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 590_000;

function readMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

export function readTimeouts(env: Env): PendingTimeouts {
  const requestTimeoutMs = readMs(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  return {
    requestTimeoutMs,
    remoteOfflineTimeoutMs: Math.min(
      requestTimeoutMs,
      readMs(env.REMOTE_OFFLINE_TIMEOUT_MS, DEFAULT_REMOTE_OFFLINE_TIMEOUT_MS),
    ),
  };
}

export class Pending<T> {
  private readonly deferred: Promise<T | null>;
  private readonly onSettled?: () => void;
  private readonly active: boolean;
  private resolveDeferred!: (value: T | null) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(options: PendingOptions) {
    this.onSettled = options.onSettled;
    this.deferred = new Promise<T | null>((resolve) => {
      this.resolveDeferred = resolve;
    });

    const { timeouts, remoteMode, isConnected } = options;
    const connected = isConnected();

    if (!remoteMode && !connected) {
      this.active = false;
      this.settle(null);
      return;
    }
    this.active = true;

    if (remoteMode && !connected) {
      this.timer = setTimeout(() => {
        if (!isConnected()) {
          this.settle(null);
          return;
        }
        const remaining = timeouts.requestTimeoutMs - timeouts.remoteOfflineTimeoutMs;
        if (remaining <= 0) {
          this.settle(null);
          return;
        }
        this.timer = setTimeout(() => this.settle(null), remaining);
      }, timeouts.remoteOfflineTimeoutMs);
      return;
    }

    this.timer = setTimeout(() => this.settle(null), timeouts.requestTimeoutMs);
  }

  get waiting(): boolean {
    return this.active && !this.settled;
  }

  get promise(): Promise<T | null> {
    return this.deferred;
  }

  settle(value: T | null): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolveDeferred(value);
    this.onSettled?.();
  }
}
