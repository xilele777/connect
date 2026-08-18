import { renderConsole } from "./ui";
import {
  parsePermissionHook,
  parseSessionId,
  parseStopHook,
} from "./protocol";
import { authorized, base64Url, timingSafeEqual, websocketToken } from "./security";
import { SessionDO } from "./session-do";

export { SessionDO };

const INTERNAL_ORIGIN = "https://session.internal";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/hook/permission") {
        return await permissionHook(request, env);
      }
      if (request.method === "POST" && url.pathname === "/hook/stop") {
        return await stopHook(request, env);
      }
      if (request.method === "POST" && url.pathname === "/hook/interrupt") {
        return await interruptHook(request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/ws/")) {
        return await websocketRoute(request, env, url.pathname.slice(4));
      }
      if (request.method === "GET" && url.pathname.startsWith("/s/")) {
        const sessionId = parseSessionId(decodeURIComponent(url.pathname.slice(3)));
        return sessionId ? htmlResponse(renderConsole(sessionId)) : new Response("Not found", { status: 404 });
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(JSON.stringify({ event: "worker_error", error: error instanceof Error ? error.message : String(error) }));
      return emptyHookResponse();
    }
  },
};

async function permissionHook(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env.COMPUTER_TOKEN)) return emptyHookResponse();
  const input = await readJson(request);
  const parsed = parsePermissionHook(input);
  if (!parsed) return emptyHookResponse();
  const stub = env.SESSION.getByName(parsed.sessionId);
  try {
    const response = await stub.fetch(new Request(`${INTERNAL_ORIGIN}/internal/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: parsed.payload.toolName, toolInput: parsed.payload.toolInput, permissionSuggestions: parsed.payload.permissionSuggestions }),
    }));
    if (!response.ok) return emptyHookResponse();
    const decision = await response.json<unknown>();
    if (!isPermissionDecision(decision)) return emptyHookResponse();
    return Response.json({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return emptyHookResponse();
  }
}

async function stopHook(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env.COMPUTER_TOKEN)) return emptyHookResponse();
  const input = await readJson(request);
  const parsed = parseStopHook(input);
  if (!parsed) return emptyHookResponse();
  const stub = env.SESSION.getByName(parsed.sessionId);
  try {
    const response = await stub.fetch(new Request(`${INTERNAL_ORIGIN}/internal/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastMessage: parsed.lastMessage }),
    }));
    if (!response.ok) return emptyHookResponse();
    const result = await response.json<unknown>();
    if (!isStopDecision(result)) return emptyHookResponse();
    return Response.json({ decision: "block", reason: result.text }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return emptyHookResponse();
  }
}

async function interruptHook(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env.COMPUTER_TOKEN)) return Response.json({ interrupt: false });
  const input = await readJson(request);
  const sessionIdValue = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).session_id
    : null;
  const sessionId = parseSessionId(typeof sessionIdValue === "string" ? sessionIdValue : "");
  if (!sessionId) return Response.json({ interrupt: false });
  const stub = env.SESSION.getByName(sessionId);
  try {
    const response = await stub.fetch(new Request(`${INTERNAL_ORIGIN}/internal/interrupt/consume`, { method: "POST" }));
    if (!response.ok) return Response.json({ interrupt: false });
    const result = await response.json<unknown>();
    return isInterruptResult(result) ? Response.json(result) : Response.json({ interrupt: false });
  } catch {
    return Response.json({ interrupt: false });
  }
}

async function websocketRoute(request: Request, env: Env, encodedPath: string): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
  const sessionId = parseSessionId(decodeURIComponent(encodedPath));
  const token = websocketToken(request);
  if (!sessionId || !token || !authorizedWebSocketToken(token, env.PHONE_TOKEN)) return new Response("Unauthorized", { status: 401 });
  const stub = env.SESSION.getByName(sessionId);
  return stub.fetch(request);
}

function authorizedWebSocketToken(receivedEncoded: string, expected: string | undefined): boolean {
  return expected !== undefined && timingSafeEqual(receivedEncoded, base64Url(expected));
}

async function readJson(request: Request): Promise<unknown | null> {
  try { return await request.json<unknown>(); } catch { return null; }
}

function isPermissionDecision(value: unknown): value is { behavior: "allow" | "deny"; updatedPermissions?: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (record.behavior === "allow" || record.behavior === "deny") && (record.updatedPermissions === undefined || Array.isArray(record.updatedPermissions));
}

function isStopDecision(value: unknown): value is { text: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).text === "string");
}

function isInterruptResult(value: unknown): value is { interrupt: boolean } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).interrupt === "boolean");
}

function emptyHookResponse(): Response {
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
