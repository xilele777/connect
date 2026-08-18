export interface Notification {
  title: string;
  body: string;
  clickUrl: string;
}

export interface Notifier {
  notify(notification: Notification): Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const NTFY_ENDPOINT = "https://ntfy.sh/";

/** ntfy JSON publish form avoids non-ASCII HTTP header encoding concerns. */
export class NtfyNotifier implements Notifier {
  private readonly topic: string;
  private readonly fetchImpl: FetchLike;

  constructor(topic: string, fetchImpl: FetchLike = (url, init) => fetch(url, init)) {
    this.topic = topic;
    this.fetchImpl = fetchImpl;
  }

  async notify(notification: Notification): Promise<void> {
    try {
      const response = await this.fetchImpl(NTFY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: this.topic,
          title: notification.title,
          message: notification.body,
          click: notification.clickUrl,
          priority: 4,
        }),
      });
      if (!response.ok) {
        console.warn(JSON.stringify({ event: "notify_rejected", status: response.status }));
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: "notify_failed", error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

export class NullNotifier implements Notifier {
  async notify(): Promise<void> {
    // NTFY_TOPIC 未配置时不发任何请求。
  }
}

export function createNotifier(env: Env): Notifier {
  return env.NTFY_TOPIC ? new NtfyNotifier(env.NTFY_TOPIC) : new NullNotifier();
}

/** 权限请求推送只接收工具名，tool_input 原文没有进入这里的途径。 */
export function permissionNotification(toolName: string, clickUrl: string): Notification {
  const isQuestion = toolName === "AskUserQuestion";
  return { title: isQuestion ? "Claude 在询问问题" : "Claude 等待批准", body: toolName, clickUrl };
}

/** Stop 推送正文固定，Claude 回复文本没有进入这里的途径。 */
export function stopNotification(clickUrl: string): Notification {
  return { title: "Claude 已完成，等待指令", body: "点开控制台发送下一条指令", clickUrl };
}

/** origin comes from the inbound Worker request; DO request URLs are internal. */
export function consoleUrl(origin: string, sessionId: string): string {
  return `${origin}/s/${encodeURIComponent(sessionId)}`;
}
