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

  it("renders AskUserQuestion cards with clickable options that answer directly", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain("item.questions && item.questions.length");
    expect(html).toContain("Claude 在询问");
    expect(html).toContain("q.question");
    expect(html).toContain("decide(item.id, 'allow', { [q.question]: opt.label })");
  });

  it("supports multi-select questions with a submit button", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain("cb.type = 'checkbox'");
    expect(html).toContain("提交答案");
    expect(html).toContain("answers[q.question] = picked.join(', ')");
  });

  it("provides a free-text other answer for both single and multi select questions", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain("placeholder = '其他（自定义回答）'");
    expect(html).toContain("请输入自定义回答");
    expect(html).toContain("qel.querySelector('.other input')?.value");
  });

  it("still renders allow/deny cards for ordinary permission requests", () => {
    const html = renderConsole("demo-session");
    expect(html).toContain("总是允许这类");
    expect(html).toContain("decide(item.id, mode)");
  });
});
