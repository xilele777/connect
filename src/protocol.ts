export type PermissionBehavior = "allow" | "deny";

export interface PermissionPayload {
  toolName: string;
  toolInput: unknown;
  permissionSuggestions: unknown[];
}

export interface PendingPermission extends PermissionPayload {
  id: string;
  createdAt: number;
}

export interface PermissionDecision {
  behavior: PermissionBehavior;
  updatedPermissions?: unknown[];
}

export interface RecentMessage {
  id: number;
  text: string;
  createdAt: number;
}

export interface Snapshot {
  pending: PendingPermission[];
  recent: RecentMessage[];
}

export type ServerMessage =
  | { type: "permission"; id: string; toolName: string; toolInput: unknown; suggestions: unknown[] }
  | { type: "idle"; lastMessage: string; createdAt: number }
  | { type: "snapshot"; pending: PendingPermission[]; recent: RecentMessage[] }
  | { type: "interrupt_ack" }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "decision"; id: string; behavior: PermissionBehavior; always?: boolean }
  | { type: "message"; text: string }
  | { type: "interrupt" };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parsePermissionHook(value: unknown): { sessionId: string; payload: PermissionPayload } | null {
  const record = asRecord(value);
  if (!record || typeof record.session_id !== "string" || !record.session_id) return null;

  const toolName = typeof record.tool_name === "string" ? record.tool_name : "unknown";
  const suggestions = Array.isArray(record.permission_suggestions) ? record.permission_suggestions : [];
  return {
    sessionId: record.session_id,
    payload: {
      toolName,
      toolInput: record.tool_input ?? null,
      permissionSuggestions: suggestions,
    },
  };
}

export function parseStopHook(value: unknown): { sessionId: string; lastMessage: string } | null {
  const record = asRecord(value);
  if (!record || typeof record.session_id !== "string" || !record.session_id) return null;
  return {
    sessionId: record.session_id,
    lastMessage: typeof record.last_assistant_message === "string" ? record.last_assistant_message : "",
  };
}

export function parseSessionId(value: string): string | null {
  const sessionId = value.trim();
  return /^[A-Za-z0-9._:-]{1,200}$/.test(sessionId) ? sessionId : null;
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return null;

  if (record.type === "decision" && typeof record.id === "string" && (record.behavior === "allow" || record.behavior === "deny")) {
    return {
      type: "decision",
      id: record.id,
      behavior: record.behavior,
      always: record.always === true,
    };
  }
  if (record.type === "message" && typeof record.text === "string" && record.text.trim()) {
    return { type: "message", text: record.text };
  }
  return record.type === "interrupt" ? { type: "interrupt" } : null;
}
