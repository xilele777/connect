# 手机远程操控 VS Code 中 Claude Code 会话 — 设计文档

日期：2026-08-18
状态：待实现

## 1. 背景与目标

在 VS Code 的 Claude Code 插件里跑着一个会话，人离开电脑后需要能从手机继续参与：批准权限请求、发送新指令、查看 Claude 的回复、叫停跑偏的任务。

官方的 Remote Control 功能（`/remote-control`）本可直接满足需求，但当前环境同时踩中它的三条禁用规则：

- `ANTHROPIC_BASE_URL` 指向 `https://anyrouter.top`，v2.1.196 起非 `api.anthropic.com` 一律禁用
- 使用 `ANTHROPIC_AUTH_TOKEN`（API key 模式），官方明确不支持，必须是 Pro/Max 订阅经 `/login` 登录
- `DISABLE_TELEMETRY` 与 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 会关闭 Remote Control 依赖的功能开关评估

因此自建。约束是不改动上述配置、不影响日常在电脑前的使用体验。

### 目标

1. 手机上批准或拒绝权限请求，支持「总是允许这类」
2. 手机上向正在运行的会话发送新指令
3. 手机上看到 Claude 的回复与工具活动
4. 手机上叫停正在跑的任务
5. 人在电脑前时，整套机制零感知、零额外延迟

### 非目标

- 不做 Claude 输出的流式逐行同步（MVP 阶段一次性推送完整回复）
- 不做多用户、多设备协同，单人单设备
- 不替代 VS Code 的完整交互（如文件 diff 审阅），只覆盖上述四项基础操作

## 2. 总体架构

```
VS Code (Claude Code)          Cloudflare                    手机浏览器
      │                              │                            │
      ├─ PermissionRequest ─POST──►  │                            │
      │   (同步阻塞 600s)         SessionDO ───WebSocket 推送───► │
      │                            (每会话                        │
      │   ◄──── 返回 decision ───── 一个实例) ◄─── y/n/指令 ───── │
      │                              │                            │
      ├─ Stop ─────────POST──────►   │                            │
      └─ PostToolUse ──POST──────►   │──── ntfy / 企业微信 ─────► 手机通知
         (asyncRewake，不阻塞)       │  活动上报 + 取回中断标志
```

三个组件，边界清晰：

| 组件 | 职责 | 明确不负责 |
|---|---|---|
| Worker + SessionDO | 会话状态机：挂起的待决请求、手机 WebSocket 连接、消息路由、推送触发 | 不做任何权限判断逻辑，不持久化命令内容 |
| hook 配置 | 把事件送出去、把决策带回来 | 不做判断，全部是配置加一个转发脚本 |
| 手机网页客户端 | 显示待决项与对话，接收键入 | 不存状态，重连后从 DO 拉取当前快照 |

一个 Claude Code 会话对应一个 DO 实例，以 hook 输入中的 `session_id` 作为 DO name。选择 Durable Object 的原因：需要有状态的长连接与请求挂起，这正是 DO 的适用场景；WebSocket Hibernation 让空闲长连接不计费 CPU 时间。

## 3. 电脑侧：hook 设计

全部通过 `~/.claude/settings.json` 的 hooks 配置实现，除一个转发脚本外无需本地代码，无常驻进程。

### 3.1 hook 分配

| 功能 | 事件 | 类型 | 阻塞 | 触发频率 |
|---|---|---|---|---|
| 批准命令 | `PermissionRequest` | `http`，`timeout: 600` | 同步 | 仅在需要弹窗时 |
| 发送指令 | `Stop` | `http`，`timeout: 600` | 同步 | 每回合末尾一次 |
| 活动推送 + 中断 | `PostToolUse` | `command`，`asyncRewake: true` | 否 | 每次工具调用 |

活动推送与中断检查合并为同一个 hook：一次 POST 既上报刚完成的工具调用，又在响应里取回中断标志。`asyncRewake` 隐含 `async`，因此后台执行不阻塞。合并省掉一次进程启动与一次网络往返。

`PermissionRequest` 与 `Stop` 是仅有的两个同步 hook。它们触发的时刻本来就要停下来等人（等你点弹窗、等你打字），因此一次约 200ms 的网络往返占比为零。推送与中断都在后台执行，不阻塞。

刻意不使用同步 `PreToolUse` 做中断检查：它每次工具调用都触发，同步化会给正常使用叠加 `200ms × N` 的延迟。

### 3.2 权限批准

`PermissionRequest` hook 收到 `tool_name`、`tool_input`、`permission_suggestions`，POST 给 Worker，挂起等待。手机返回后 hook 输出：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

选择「总是允许这类」时，把输入里收到的 `permission_suggestions` 条目原样回填进 `decision.updatedPermissions`，等价于在弹窗中点击 Always allow。

### 3.3 指令注入

`Stop` hook 输入含 `last_assistant_message`（Claude 本回合的完整回复文本）。推给手机显示，同时挂起等待输入。收到文本后输出：

```json
{ "decision": "block", "reason": "<手机端输入的文本>" }
```

Claude 将 `reason` 作为继续工作的理由，效果等同于用户发了一条新消息。

### 3.4 中断

`PostToolUse` 上挂一个 `asyncRewake: true` 的 command hook，后台上报工具活动并在响应中取回中断标志：

- 无中断：`exit 0`，无任何影响
- 有中断：`exit 2`，stderr 写入「用户从手机请求停止当前任务」，Claude Code 唤醒 Claude 并把该文本作为 system reminder 传入，Claude 主动停止

这是软中断而非强制终止。换来的是正常使用时零延迟。延迟为「到下一次工具调用」，通常在数秒内。

### 3.5 认证

HTTP hook 支持 `headers` 与 `allowedEnvVars`，token 从环境变量读取，不落入 settings.json 明文：

```json
{
  "type": "http",
  "url": "https://<worker>/hook/permission",
  "timeout": 600,
  "headers": { "Authorization": "Bearer $CLAUDE_CONNECT_TOKEN" },
  "allowedEnvVars": ["CLAUDE_CONNECT_TOKEN"]
}
```

## 4. 云侧：Worker 与 SessionDO

### 4.1 路由

| 路径 | 方法 | 调用方 | 说明 |
|---|---|---|---|
| `/hook/permission` | POST | 电脑 | 挂起直至手机决策或超时 |
| `/hook/stop` | POST | 电脑 | 挂起直至手机输入或超时 |
| `/hook/activity` | POST | 电脑 | 立即返回。广播工具活动，响应体带回中断标志 |
| `/s/<sessionId>` | GET | 手机 | 返回单页 HTML 控制台 |
| `/ws/<sessionId>` | GET | 手机 | WebSocket 升级 |

Worker 只做鉴权与路由，按 `session_id` 定位 DO 实例，全部状态在 DO 内。

手机侧 token 不放进 URL：`/s/<sessionId>` 本身不带凭据，页面首次打开时要求输入一次 token 并存入 `localStorage`，后续 WebSocket 握手携带。这样推送通知里的链接即便泄露也无法直接接管会话。

### 4.2 SessionDO 状态

```
pendingPermissions: Map<requestId, { resolve, payload, createdAt }>
pendingStop:        { resolve, payload } | null
interruptFlag:      boolean
sockets:            Set<WebSocket>     // 手机连接，用 Hibernation API
recentActivity:     RingBuffer<Event>  // 供重连时补齐，容量固定
```

`recentActivity` 是有界环形缓冲，防止长会话内存增长。

### 4.3 协议

云 → 手机：

```json
{ "type": "permission", "id": "...", "toolName": "Bash",
  "toolInput": {...}, "suggestions": [...] }
{ "type": "idle", "lastMessage": "..." }
{ "type": "activity", "toolName": "Edit", "summary": "..." }
{ "type": "snapshot", "pending": [...], "recent": [...] }
```

手机 → 云：

```json
{ "type": "decision", "id": "...", "behavior": "allow", "always": false }
{ "type": "message", "text": "..." }
{ "type": "interrupt" }
```

### 4.4 通知适配器

DO 在挂起一个请求时触发推送。抽象为单一接口，实现可替换：

```
interface Notifier { notify(title, body, clickUrl): Promise<void> }
├── NtfyNotifier   → POST https://ntfy.sh/<私密topic>   （默认）
└── WeComNotifier  → 企业微信群机器人 webhook           （国内兜底）
```

推送由 Worker 发出，不经过用户的网络，因此不需要任何自有服务器。

ntfy.sh 公共实例上通知内容为明文，因此**推送正文只含最小信息**（如「Claude 等待批准一个 Bash 命令」），完整命令内容不进推送，需点击链接进入受 token 保护的网页查看。topic 名使用长随机字符串，其本身即凭据。

若 ntfy.sh 在国内网络不可达，切换到企业微信群机器人（直连、免费、无量限），仅需更换配置，主逻辑不动。

## 5. 手机侧：网页客户端

Worker 直接托管的单文件 HTML，手机浏览器打开即用，无需在 Termux 中安装任何依赖。命令行操作可用 `curl` 调同一套 API 作为备份。

界面三区：待决权限请求（含完整 `tool_input`）、对话与工具活动流、输入框与中断按钮。

连接采用 WebSocket，进入页面时先请求一次 `snapshot` 补齐当前状态，因此浏览器切后台导致断连后重新打开即可恢复，不依赖长连接存活。

## 6. 安全设计

这条通道等价于远程任意命令执行权，安全优先级高于功能。

- **双向 token**：电脑侧与手机侧使用独立 token，可分别吊销。电脑侧经 `allowedEnvVars` 从环境变量注入
- **fail-open 到本地，绝不 fail-open 到 allow**：任何异常路径（手机离线、超时、DO 错误、token 不匹配）一律返回 2xx 空 body，效果是「不干预」，VS Code 照常弹出本地权限对话框。任何情况下都不会自动批准
- **不持久化命令内容**：DO 内的命令文本仅在内存中存活至决策完成，不写入存储
- **不做展示美化**：手机端完整显示 `tool_name` 与 `tool_input` 原文，不截断、不摘要。你批准的必须是你看见的那条
- **推送最小化**：见 4.4

## 7. 错误处理

| 情况 | 行为 |
|---|---|
| 手机未连接 | DO 立即返回空 body，VS Code 正常弹窗 |
| 手机连接但 600s 未响应 | hook 超时被取消，视为不干预，VS Code 弹窗 |
| Worker/DO 不可达 | HTTP hook 连接失败属 non-blocking error，会话继续，走本地弹窗 |
| 输出 JSON 不合 schema | Claude Code 静默丢弃该字段，等同不干预。由契约测试防范 |
| WebSocket 断连 | 手机重连后请求 snapshot 补齐；挂起的请求仍在 DO 内等待 |

核心原则：这套系统的所有故障模式都退化为「没装这套系统」，不改变本地行为。

## 8. 测试策略

- **DO 状态机单测**（`@cloudflare/vitest-pool-workers`）：请求挂起与 resolve、超时、手机离线立即返回、并发多个待决请求互不串扰、中断标志置位与清除
- **契约测试**：用真实 hook 输入样本 POST 到 Worker，断言响应体严格符合 Claude Code 的 hook 输出 schema。这一层出错症状极隐蔽——不合格的字段会被静默丢弃，表现为「hook 好像没生效」
- **端到端**：`wrangler dev` 起本地实例，settings.json 指向 localhost，跑真实 Claude Code 会话验证四条流程，通过后再切公网

## 9. 性能预算

设计目标是「人在电脑前时零感知」。逐项核算：

| hook | 阻塞 | 频率 | 手机离线时代价 |
|---|---|---|---|
| `PermissionRequest` | 同步 | 仅弹窗时 | 零。该时刻本就在等待人工响应 |
| `Stop` | 同步 | 每回合末尾一次 | 一次往返，叠加在回合结束时刻 |
| `PostToolUse` | 否 | 每次工具调用 | 不阻塞主流程，但每次 fork 一个进程 |

关键的架构决策是不把中断做成同步 `PreToolUse`。那样会给每次工具调用叠加一次网络往返，一个回合数十次调用即累计数秒，是唯一会实质性拖垮体验的设计。改用 `PostToolUse` + `asyncRewake` 后，同步路径只剩下两个「本来就要等人」的时刻。

余下两个待验证风险：

**R1：`Stop` 的每回合往返延迟未知。** hook 子进程继承 `HTTP_PROXY=127.0.0.1:7890`，出站请求可能被路由进代理链路，实际往返可能远高于直连 Cloudflare 边缘的预期值。200ms 无感，1~2 秒则每回合可感知。

缓解：实现第一步先做基线测量（见 11）。若超标，依次尝试 `NO_PROXY` 绕过代理、改用 command hook 加 `curl --noproxy`；仍不达标则为 `Stop` hook 增加本地开关（哨兵文件存在时直接跳过），按需启用远程。

**R2：`PostToolUse` 每次工具调用 fork 进程。** 不阻塞 Claude，但 Windows 上进程启动成本不低，高频工具调用会累积系统资源占用。

缓解：用 hook 的 `if` 字段限定为 `Bash`、`Edit`、`Write`，跳过 `Read`、`Grep`、`Glob` 等高频只读工具。这些工具的活动对手机端观察价值也低。

## 10. 已知约束

以下均为核实过的官方文档约束，非推测：

1. **`Stop` hook 连续阻塞上限 8 次**。Claude Code 在 8 次连续 block 后强制结束回合。中间 Claude 实际执行工作会重置计数，正常来回对话不会触及，纯连续对话需注意
2. **600 秒空闲窗口**。`Stop` hook 最长阻塞 600 秒，超时后会话真正结束，此后无法从手机唤醒。使用模式是「Claude 完成 → 手机收到通知 → 10 分钟内回复继续」，而非任意时刻唤醒久置会话
3. **中断是软停**。`asyncRewake` 通过 system reminder 告知 Claude 停止，而非强制终止进程
4. **`HTTP_PROXY=127.0.0.1:7890` 会被 hook 子进程继承**，hook 的出站请求可能被路由进代理，代理未运行时全线失败。这是实现阶段第一个要实测的点，必要时通过 `NO_PROXY` 或改用 command hook 加 `curl --noproxy` 规避
5. **Windows 上 command hook 默认使用 Git Bash**，路径与引号需注意；`args` 形式（exec form）无法直接执行 `.cmd`/`.bat` shim
6. **既有的声音通知 hook 并行运行**，不冲突。官方文档明确所有匹配的 hook 并行执行，且该 hook 不返回 decision，不影响权限决策

## 11. 实现顺序

0. **性能基线测量**（前置，决定后续是否需要退路）：在接入任何逻辑前，先挂一个只做 POST 并立即返回的空 `Stop` hook，测量三种情形下的回合结束耗时——未装 hook、装了且直连、装了且经代理。确认单次往返落在可接受区间（目标 < 300ms）后再继续；超标则先解决 R1
1. Worker 骨架与 SessionDO 状态机，配套单测
2. `PermissionRequest` 全链路打通（含手机网页最小版），本地 `wrangler dev` 验证
3. `Stop` 指令注入
4. 活动推送与 Notifier
5. 中断
6. 切公网，实测国内网络可达性与推送渠道
