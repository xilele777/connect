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
});
