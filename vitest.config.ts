import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          COMPUTER_TOKEN: "test-computer-token",
          PHONE_TOKEN: "test-phone-token",
        },
      },
    }),
  ],
});
