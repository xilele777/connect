import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parsePermissionHook,
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
});
