import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parsePermissionHook,
  parseQuestions,
  parseSessionId,
  parseStopHook,
} from "../src/protocol";

describe("hook protocol parsing", () => {
  it("normalizes a permission hook payload without changing tool input", () => {
    const input = { session_id: "abc", tool_name: "Bash", tool_input: { command: "echo hi" }, permission_suggestions: [{ type: "addRules", rules: ["echo *"] }] };
    expect(parsePermissionHook(input)).toEqual({
      sessionId: "abc",
      payload: { toolName: "Bash", toolInput: input.tool_input, permissionSuggestions: input.permission_suggestions },
    });
  });

  it("keeps stop output as a complete string", () => {
    expect(parseStopHook({ session_id: "abc", last_assistant_message: "done\nwith details" })).toEqual({ sessionId: "abc", lastMessage: "done\nwith details" });
  });

  it("rejects unsafe session names and malformed client messages", () => {
    expect(parseSessionId("../other-session")).toBeNull();
    expect(parseSessionId("session-01")).toBe("session-01");
    expect(parseClientMessage({ type: "decision", id: "1", behavior: "allow", always: true })).toEqual({ type: "decision", id: "1", behavior: "allow", always: true });
    expect(parseClientMessage({ type: "message", text: "   " })).toBeNull();
  });

  it("parses the remote mode toggle and rejects a missing flag", () => {
    expect(parseClientMessage({ type: "remote_mode", enabled: true })).toEqual({ type: "remote_mode", enabled: true });
    expect(parseClientMessage({ type: "remote_mode", enabled: false })).toEqual({ type: "remote_mode", enabled: false });
    expect(parseClientMessage({ type: "remote_mode" })).toBeNull();
    expect(parseClientMessage({ type: "remote_mode", enabled: "yes" })).toBeNull();
  });
});

describe("AskUserQuestion questions parsing", () => {
  it("extracts structured questions with options, headers, and multiSelect", () => {
    const toolInput = {
      questions: [
        {
          question: "How should I format the output?",
          header: "Format",
          options: [
            { label: "Summary", description: "Brief overview" },
            { label: "Detailed", description: "Full explanation" },
          ],
          multiSelect: false,
        },
      ],
    };
    expect(parseQuestions(toolInput)).toEqual([
      { question: "How should I format the output?", header: "Format", options: [{ label: "Summary", description: "Brief overview" }, { label: "Detailed", description: "Full explanation" }], multiSelect: false },
    ]);
  });

  it("defaults multiSelect to false when the flag is missing", () => {
    const toolInput = { questions: [{ question: "Pick one", options: [{ label: "A" }] }] };
    expect(parseQuestions(toolInput)).toEqual([{ question: "Pick one", options: [{ label: "A" }], multiSelect: false }]);
  });

  it("returns null for non-question tool input and malformed shapes", () => {
    expect(parseQuestions({ command: "ls" })).toBeNull();
    expect(parseQuestions(null)).toBeNull();
    expect(parseQuestions({ questions: [] })).toBeNull();
    expect(parseQuestions({ questions: [{ question: "missing options" }] })).toBeNull();
    expect(parseQuestions({ questions: [{ question: "", options: [{ label: "A" }] }] })).toBeNull();
  });

  it("parses a decision that carries phone answers", () => {
    expect(parseClientMessage({ type: "decision", id: "1", behavior: "allow", answers: { "How should I format the output?": "Summary" } })).toEqual({
      type: "decision",
      id: "1",
      behavior: "allow",
      always: false,
      answers: { "How should I format the output?": "Summary" },
    });
  });

  it("rejects a decision that carries malformed answers instead of mis-approving the tool", () => {
    expect(parseClientMessage({ type: "decision", id: "1", behavior: "allow", answers: {} })).toBeNull();
    expect(parseClientMessage({ type: "decision", id: "1", behavior: "allow", answers: { q: 42 } })).toBeNull();
  });
});
