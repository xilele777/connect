interface Env {
  /** Secrets are provisioned with `wrangler secret put`; they are intentionally absent from wrangler vars. */
  COMPUTER_TOKEN?: string;
  PHONE_TOKEN?: string;
  NTFY_TOPIC?: string;
}
