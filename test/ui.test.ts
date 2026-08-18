import { describe, expect, it } from "vitest";
import { renderConsole } from "../src/ui";

describe("console markup", () => {
  it("renders a remote mode toggle wired to the remote_mode message", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain('id="remote-toggle"');
    expect(html).toContain("remote_mode");
  });

  it("never emits an unescaped session id", () => {
    expect(renderConsole('a"<b')).not.toContain('a"<b');
  });

  it("renders an error banner wired to the error message type", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain('id="error-banner"');
    expect(html).toContain("data.type === 'error'");
  });

  it("warns when the user tries to compose while the socket is closed", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain("readyState !== WebSocket.OPEN");
    expect(html).toContain("未连接到会话");
  });
});
