const REQUEST_TIMEOUT_MS = 590_000;

export interface PendingOptions {
  /** Maximum time to wait, in milliseconds. */
  timeoutMs?: number;
  /** Whether a phone is connected when the request starts. */
  isConnected: () => boolean;
  /** Called exactly once after the request settles. */
  onSettled?: () => void;
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

    if (!options.isConnected()) {
      this.active = false;
      this.settle(null);
      return;
    }

    this.active = true;
    this.timer = setTimeout(() => this.settle(null), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
