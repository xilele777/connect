# Claude Remote Control

> 用手机浏览器远程操控电脑上的 Claude Code 会话。

一个基于 **Cloudflare Workers + Durable Object** 的远程控制桥。它把 Claude Code 的权限请求、回合结束消息和任务中断，通过一个加密的 WebSocket 转发到你的手机浏览器——你可以在不碰电脑的情况下批准命令、回答选择题、发送继续指令，甚至强制中断正在运行的任务。

**当前能力**：权限决策（允许 / 拒绝 / 总是允许）、`AskUserQuestion` 选择题远程作答（单选 / 多选 / 自定义输入）、回合结束消息注入、软中断轮询、WebSocket 断线重连快照、ntfy 推送通知，以及一个手机端控制台。

---

## 特性

- **📱 手机控制台**：浏览器打开即用，无需安装 App。token 通过 WebSocket subprotocol 鉴权，绝不进入 URL。
- **✅ 权限请求远程批准**：手机端直接批准 / 拒绝 / 「总是允许这类」，Claude Code 端无需任何操作。
- **❓ 选择题远程作答**：当 Claude 使用 `AskUserQuestion` 弹出选项时，手机端渲染真正的选择题卡片，单选点选即提交、多选可勾选、还支持自定义输入兜底。答案通过 `updatedInput` 回传，电脑端不弹窗。
- **✋ 软中断**：手机端「停止当前任务」通过 `PostToolUse` 命令 hook 轮询生效，结束当前 Bash 工具运行。
- **⚡ 零延迟免打扰**：远程模式默认关闭。关闭时手机未连接，hook 立即返回，与没有配置完全一致。
- **🔔 ntfy 推送**：远程模式下，挂起的权限请求和回合结束都会推送通知到手机，点通知直达控制台。
- **🔒 安全设计**：fail-open 硬约束（任何失败都返回空响应，绝不误放行命令）；推送正文不含 `tool_input` 与回复原文；token 通过变量插值注入，不进 `settings.json`。
- **🌐 断线容错**：WebSocket 断开自动重连，重连后拉取会话快照，挂起的请求不会丢失。

## 工作原理

```text
┌──────────────────┐  ① hook 请求   ┌─────────────────────────────────┐
│ 电脑 · Claude Code │───────────────▶│ Cloudflare Worker             │
│ PermissionRequest │                │  /hook/* 路由 + 鉴权           │
│ Stop · PostToolUse│                │  SessionDO（Durable Object）  │
└─────────┬─────────┘                │   - 挂起权限 / 回合结束        │
          │                          │   - SQLite 状态               │
          │ ⑤ hook 返回决策           │   - ntfy 推送（远程模式）④     │
          └──────────────────────────┴───────┬─────────────┬────────┘
                                              │ ② 广播请求   │ ④ 推送
                                              ▼             ▼
                                       ┌──────────────┐  ┌──────────┐
                                       │ 手机浏览器    │  │ ntfy.sh  │
                                       │ WebSocket ③ │  └──────────┘
                                       │ 作答 · 决策   │
                                       └──────────────┘
```

1. Claude Code 触发 `PermissionRequest` / `Stop` hook，经 HTTP 转发到 Worker。
2. Worker 校验 `COMPUTER_TOKEN`，把请求交给对应会话的 `SessionDO`。
3. `SessionDO` 将请求**挂起**并广播给已连接的手机端；手机端作答后，决策经 WebSocket 送回。
4. 远程模式下同步推送 ntfy 通知。
5. hook 拿到决策结果返回给 Claude Code，继续执行。

**fail-open 是硬约束**：鉴权失败、请求畸形、网络异常、手机离线、超过超时——以上所有路径都返回空 / 非阻塞的 hook 响应，只意味着「本地正常弹窗」，**绝不会**因此放行一条命令。

## 目录结构

```text
connect/
├─ src/
│  ├─ index.ts            # Worker 入口：hook 路由、WebSocket 升级与鉴权
│  ├─ session-do.ts       # SessionDO：挂起/决策状态机、SQLite 状态、WS 广播
│  ├─ protocol.ts         # 前后端消息协议解析与校验（含 AskUserQuestion 问题解析）
│  ├─ pending.ts          # 分级超时等待（立即返回 / 离线等待 / 总超时）
│  ├─ notifier.ts         # ntfy 推送适配（未配置 token 时自动降级为空实现）
│  ├─ security.ts         # 常量时间比较、base64url、token 提取
│  └─ ui.ts               # 手机端控制台 HTML（纯内联，单文件无依赖）
├─ hooks/
│  └─ remote-interrupt.ps1    # PostToolUse 命令 hook：软中断轮询
├─ scripts/
│  ├─ get-session.ps1         # 打印当前会话 ID 与手机控制台 URL
│  └─ measure-baseline.ps1    # 网络层延迟基线测量（直连 vs 代理）
├─ test/                      # vitest 测试（协议、状态机、UI、契约）
├─ wrangler.jsonc             # Worker 与 Durable Object 配置
└─ package.json
```

## 快速开始（本地开发）

### 前置要求

- [Node.js](https://nodejs.org/) 20+（建议 LTS）
- [npm](https://www.npmjs.com/)
- 一个 [Cloudflare 账户](https://dash.cloudflare.com/)（部署时需要）

### 安装与启动

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars   # 然后替换三个本地 token 值
npm run dev -- --port 8787
```

打开 `http://127.0.0.1:8787/s/<session_id>`（在手机浏览器），输入 `PHONE_TOKEN` 即可连接。浏览器会把 token 存在 `localStorage`，通过 WebSocket subprotocol 发送，**从不出现在 URL 里**。

> `session_id` 从哪来？见下文「连接当前会话」。

## 连接 Claude Code

要让运行 Claude Code 的电脑与本项目对接，需要两步：配置环境变量 + 在 hooks 中注册。

### 1. 环境变量

在运行 Claude Code 的终端（或 VSCode 扩展环境）中设置：

```powershell
$env:CLAUDE_REMOTE_CONTROL_URL = 'https://your-worker.example.workers.dev'
$env:CLAUDE_REMOTE_CONTROL_TOKEN = '<computer token>'
```

这两个变量会被 `PostToolUse` 命令 hook 直接读取；HTTP hook 则借助 `allowedEnvVars` 做**变量插值**，让 `settings.json` 里不出现明文 token。

### 2. 配置 hooks

编辑 `~/.claude/settings.json`，在保留现有 hooks 的前提下追加以下配置：

```json
{
  "hooks": {
    "PermissionRequest": [{
      "hooks": [{
        "type": "http",
        "url": "https://your-worker.example.workers.dev/hook/permission",
        "timeout": 600,
        "headers": { "Authorization": "Bearer $CLAUDE_REMOTE_CONTROL_TOKEN" },
        "allowedEnvVars": ["CLAUDE_REMOTE_CONTROL_TOKEN"]
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "http",
        "url": "https://your-worker.example.workers.dev/hook/stop",
        "timeout": 600,
        "headers": { "Authorization": "Bearer $CLAUDE_REMOTE_CONTROL_TOKEN" },
        "allowedEnvVars": ["CLAUDE_REMOTE_CONTROL_TOKEN"]
      }]
    }],
    "PostToolUse": [{
      "matcher": "Bash(*)",
      "hooks": [{
        "type": "command",
        "shell": "powershell",
        "command": "& 'C:\\path\\to\\connect\\hooks\\remote-interrupt.ps1'",
        "asyncRewake": true
      }]
    }]
  }
}
```

- 两个 HTTP hook（`PermissionRequest`、`Stop`）同步运行，`timeout` 需大于 worker 端 `REQUEST_TIMEOUT_MS`（默认 590s）。
- `PostToolUse` 命令 hook 异步运行，只在 Bash 工具执行后触发，用于软中断轮询。
- token 通过 `allowedEnvVars` 插值注入 `Authorization` 头，**token 不会写进 `settings.json`**。

## 手机端使用

### 连接当前会话

Claude Code 的每个会话 ID 都不同，且随新会话变化（新的 VSCode 窗口、`/clear` 都会换）。运行：

```powershell
pwsh -NoProfile -File scripts/get-session.ps1
```

脚本按当前工作目录推导项目目录，取最近修改的会话文件，打印出 `Session ID` 和手机控制台 `URL`。在手机打开该 URL，输入 `PHONE_TOKEN` 即连接。

### 权限决策

Claude 需要授权时，手机端卡片会显示工具名与完整 `tool_input`：

- **允许**：放行本次调用。
- **总是允许这类**：放行并把权限建议写入规则（`updatedPermissions`）。
- **拒绝**：拒绝调用，Claude 会收到拒绝消息自行调整。

### 回答 AskUserQuestion 选择题

当 Claude 用 `AskUserQuestion` 弹出选项时（官方列为「需要用户交互的工具」，任何权限模式都不自动放行），手机端渲染**选择题卡片**：

- **单选**：点选项**立即提交**，无需额外操作。
- **多选**：勾选多项后点「提交答案」。
- **自定义输入**：每个问题下方有「其他（自定义回答）」输入框，用于选项都不满意时自由作答。

作答结果通过 `updatedInput` 回传给 Claude Code，它直接采纳答案继续执行——**电脑端不会弹窗**。所有交互都保留「拒绝」按钮兜底。

### 继续指令

手机端顶部的「继续指令」输入框，只在**回合结束、`Stop` hook 挂起的窗口内**生效。三个会被静默丢弃的场景：Claude 还在工作中、远程模式关闭且手机未连接、手机页面切后台导致 WebSocket 断连。

正确用法：先开右上角「远程模式」，等回合结束（出现 `running stop hooks` 提示或收到推送）再发送。

### 软中断

「停止当前任务」按钮会通过 `PostToolUse` 命令 hook 轮询 `/hook/interrupt`。检测到中断标志时，hook 以退出码 2 终止当前 Bash 工具的运行，Claude 随即收到中断反馈。

### 远程模式

远程模式**默认关闭**。关闭时整个系统行为与配置前完全一致：手机未连接 → hook 立即返回 → 正常本地弹窗，**零额外延迟**。

离开电脑前，在手机控制台右上角打开「远程模式」开关：

- 每个挂起的权限请求和回合结束消息都会发送 ntfy 推送。
- 没有手机连接时，请求会等待 `REMOTE_OFFLINE_TIMEOUT_MS`（默认 90 秒）让手机连上；连上后最多等满 `REQUEST_TIMEOUT_MS`（总 590 秒）；始终没连上 → fail-open。
- 模式到期自动关闭（默认 8 小时），忘了关最多也就耗掉一个晚上。

## 推送通知（ntfy）

远程模式依赖 ntfy 通知你「有请求在等你」。安装 [ntfy](https://ntfy.sh/) 手机 App，订阅一个别人猜不到的 topic，然后：

```powershell
wrangler secret put NTFY_TOPIC
```

> ⚠️ **topic 名本身就是凭据**：任何知道 topic 的人都能读到你推送的每一条通知。**绝不**把它写进 `wrangler.jsonc`，只能用 `wrangler secret put` 注入。

推送正文刻意保持最小化：权限推送只含工具名（`AskUserQuestion` 用固定文案「Claude 在询问问题」），回合结束推送是固定文案。**`tool_input` 与回复原文都没有进入推送的途径**——想看详情，点通知打开 token 保护的控制台。

> 注意：ntfy.sh 免费 tier 有速率限制（429）。推送偶尔会晚到或被丢弃，不影响核心控制功能。

## 可调参数

参数都在 `wrangler.jsonc` 的 `vars` 中，均为字符串：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | `590000` | 挂起请求的总超时上限（须在 hook `timeout` 600s 之内） |
| `REMOTE_OFFLINE_TIMEOUT_MS` | `90000` | 远程模式下，等待手机连接的第一段窗口 |
| `REMOTE_MODE_TTL_MS` | `28800000` | 远程模式自动过期时长（8 小时） |
| `MAX_RECENT_MESSAGES` | `50` | 会话快照保留的最近回复条数（上限 200） |

## 部署

完整流程（本机验证 → 写入三个 secret → 部署）：

```powershell
npm run types      # 重新生成 wrangler 类型
npm run typecheck  # TypeScript 类型检查
npm test           # 运行全部测试
npm run deploy:check   # wrangler deploy --dry-run 预检
wrangler secret put COMPUTER_TOKEN
wrangler secret put PHONE_TOKEN
wrangler secret put NTFY_TOPIC
npm run deploy
```

三个 secret 的用途：

| Secret | 用途 |
|---|---|
| `COMPUTER_TOKEN` | 电脑端 hook 请求的鉴权（`Authorization: Bearer`） |
| `PHONE_TOKEN` | 手机端 WebSocket 连接鉴权（subprotocol） |
| `NTFY_TOPIC` | ntfy 推送 topic（topic 名即凭据） |

## 安全设计

- **fail-open 硬约束**：缺凭据、畸形输入、网络错误、手机离线、超时——全部返回空 / 非阻塞 hook 响应，**绝不返回 allow**。安全隐患的代价是「回到本地弹窗」，而不是「放行危险命令」。
- **凭据不进配置文件**：`COMPUTER_TOKEN` / `PHONE_TOKEN` / `NTFY_TOPIC` 仅通过 `wrangler secret put` 注入；电脑端 token 靠 `allowedEnvVars` 变量插值进 HTTP hook 头。
- **隐私最小化推送**：推送正文不含 `tool_input`，不含回复原文。
- **Token 校验**：凭据比对用常量时间比较（`timingSafeEqual`）防时序侧信道；手机 token 经 subprotocol 传输，不在 URL、不在 GET 参数。

## 测试

```powershell
npm test            # 一次运行
npm run test:watch  # 监听模式
```

测试覆盖：hook / 客户端消息协议解析、SessionDO 状态机（挂起、决策、远程模式、TTL 过期）、手机端控制台渲染、fail-open 契约。

## 常用脚本

| 脚本 | 说明 |
|---|---|
| `pwsh -NoProfile -File scripts/get-session.ps1` | 打印当前会话的 `Session ID` 与手机控制台 URL |
| `pwsh -NoProfile -File scripts/measure-baseline.ps1` | 测量到 Cloudflare 边缘的往返延迟（直连 vs 代理），判定线 p95 < 300ms |

## 常见问题

**手机端点了按钮，电脑端却没反应？**
大概率是手机页面的 WebSocket 已断连（切后台太久 / 重新部署过）。确认右上角状态为「已连接」，必要时刷新页面。挂起的请求不会丢失，重连后仍在。

**为什么本地还是会弹窗？**
离线、远程模式关闭、超时都会走 fail-open 让本地正常弹窗；这是设计使然。开着远程模式且手机在线时，决策才由手机决定。

**部署后手机上看到的还是旧界面？**
控制台 HTML 是静态送达，下拉刷新可能命中缓存。**完全关闭标签页重新打开**即可拿到最新版本。

**`npm run dev` 报 `stdin is not a tty`？**
Git Bash 下 `node` 常被 alias 成 `winpty node.exe`，非交互 stdin 会报错。用完整 node 路径（如 `C:\Program Files\nodejs\node.exe`）启动即可。

## License

本项目采用 [MIT License](LICENSE)。
