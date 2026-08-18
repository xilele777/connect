import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Worker hook contract", () => {
  it("returns an empty non-blocking response on missing computer auth", async () => {
    const response = await SELF.fetch("https://remote.test/hook/permission", {
      method: "POST",
      body: JSON.stringify({ session_id: "contract", tool_name: "Bash", tool_input: { command: "ls" }, permission_suggestions: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns an empty non-blocking response for malformed hook input", async () => {
    const response = await SELF.fetch("https://remote.test/hook/stop", {
      method: "POST",
      headers: { Authorization: "Bearer test-computer-token" },
      body: JSON.stringify({ session_id: "../escape" }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
