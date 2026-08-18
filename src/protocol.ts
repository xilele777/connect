export type PermissionBehavior = "allow" | "deny";

export interface QuestionOption {
  label: string;
  description?: string;
}

/** Shape of an AskUserQuestion entry as Claude Code sends it in tool_input.questions. */
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface PermissionPayload {
  toolName: string;
  toolInput: unknown;
  permissionSuggestions: unknown[];
}

export interface PendingPermission extends PermissionPayload {
  id: string;
  createdAt: number;
  /** Structured questions when toolName is AskUserQuestion; absent otherwise. */
  questions?: Question[];
}

export interface PermissionDecision {
  behavior: PermissionBehavior;
  updatedPermissions?: unknown[];
  /** Present when a phone answers an AskUserQuestion; Claude Code then skips the local prompt. */
  updatedInput?: unknown;
}

export interface RecentMessage {
  id: number;
  text: string;
  createdAt: number;
}

export interface Snapshot {
  pending: PendingPermission[];
  recent: RecentMessage[];
  /** Whether remote mode is enabled; expiresAt is null when disabled. */
  remoteMode: boolean;
  expiresAt: number | null;
}

export type ServerMessage =
  | { type: "permission"; id: string; toolName: string; toolInput: unknown; suggestions: unknown[]; questions?: Question[] }
  | { type: "idle"; lastMessage: string; createdAt: number }
  | ({ type: "snapshot" } & Snapshot)
  | { type: "remote_mode"; enabled: boolean; expiresAt: number | null }
  | { type: "interrupt_ack" }
  | { type: "error"; message: string };

export type ClientMessage =
  | { type: "decision"; id: string; behavior: PermissionBehavior; always?: boolean; answers?: Record<string, string> }
  | { type: "message"; text: string }
  | { type: "remote_mode"; enabled: boolean }
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

/** Extracts and validates the questions array from an AskUserQuestion tool_input. */
export function parseQuestions(toolInput: unknown): Question[] | null {
  const record = asRecord(toolInput);
  if (!record || !Array.isArray(record.questions) || record.questions.length === 0) return null;

  const questions: Question[] = [];
  for (const item of record.questions) {
    const q = asRecord(item);
    if (!q || typeof q.question !== "string" || !q.question) return null;
    if (!Array.isArray(q.options) || q.options.length === 0) return null;
    const options: QuestionOption[] = [];
    for (const opt of q.options) {
      const o = asRecord(opt);
      if (!o || typeof o.label !== "string" || !o.label) return null;
      options.push({ label: o.label, description: typeof o.description === "string" ? o.description : undefined });
    }
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options,
      multiSelect: q.multiSelect === true,
    });
  }
  return questions;
}

function parseAnswers(value: unknown): Record<string, string> | null {
  const record = asRecord(value);
  if (!record) return null;
  const answers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.length === 0) return null;
    answers[key] = entry;
  }
  return Object.keys(answers).length > 0 ? answers : null;
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
    let answers: Record<string, string> | null = null;
    if (record.answers !== undefined) {
      answers = parseAnswers(record.answers);
      // 携带了 answers 却解析失败说明客户端协议损坏，拒绝整条消息而非误放行工具。
      if (!answers) return null;
    }
    return {
      type: "decision",
      id: record.id,
      behavior: record.behavior,
      always: record.always === true,
      ...(answers ? { answers } : {}),
    };
  }
  if (record.type === "message" && typeof record.text === "string" && record.text.trim()) {
    return { type: "message", text: record.text };
  }
  if (record.type === "remote_mode" && typeof record.enabled === "boolean") {
    return { type: "remote_mode", enabled: record.enabled };
  }
  return record.type === "interrupt" ? { type: "interrupt" } : null;
}
