# 手机远程操控 Claude Code — 第二阶段设计

日期：2026-08-18
状态：待实现
前置：[2026-08-18-remote-claude-control-design.md](2026-08-18-remote-claude-control-design.md)

## 1. 背景与范围

第一阶段已交付可运行的云侧骨架：Worker 路由、SessionDO 状态机、权限批准全链路、Stop 指令注入、软中断、WebSocket 重连快照、双 token 鉴权。对应前置文档实现顺序中的第 1、2、3、5 步。

本阶段收尾剩余四项，即前置文档的第 0、4、6 步：

1. R1 性能基线测量（前置文档第 9 节的唯一未验证风险）
2. 通知适配器（前置文档第 4.4 节）
3. 正式部署到 Cloudflare
4. 真实 Claude Code 会话接入

其中引入一项前置文档未预见的新机制：**远程模式开关**。理由见第 3 节。

### 非目标

- 不做企业微信通知实现。接口留好，渠道确定后再补
- 不做多渠道并发推送或推送重试
- 不改动第一阶段已验证的权限、Stop、中断三条链路的对外协议

## 2. R1 性能基线

前置文档把基线测量列为实现顺序第 0 步，实际被跳过。本阶段补做，并拆成两半——**端到端那一半必须等部署之后**，因为空 `Stop` hook 需要一个公网 URL。

### 2.1 前置文档 R1 表述的修正

前置文档第 10.4 条写「`HTTP_PROXY` 会被 hook 子进程继承」，并据此推断 `Stop` hook 可能被代理拖慢。该推断的前提不成立：`PermissionRequest` 与 `Stop` 配置为 `type: "http"`，由 Claude Code 主进程直接发起请求，**不 fork 子进程**。真正继承环境变量的只有 `PostToolUse` 那个 PowerShell command hook，而它是 `asyncRewake` 异步执行，不阻塞主流程。

R1 因此重新表述为：**Claude Code 主进程发出的 http hook 请求，是否会走 `HTTP_PROXY` 代理链路。** Node.js 不会自动读取该环境变量，但 Claude Code 可能自行装配了 undici 的 ProxyAgent。这一点无法从文档推断，只能实测。

### 2.2 R1a：网络层基线（现在做）

`scripts/measure-baseline.ps1`，不依赖部署，不需要人工操作：

- 目标端点 `https://cloudflare.com/cdn-cgi/trace`，与 workers.dev 走同一张 Cloudflare 边缘网络
- 两种环境各采样 20 次：直连（清空 `HTTP_PROXY`/`HTTPS_PROXY`）与经代理（`HTTP_PROXY=127.0.0.1:7890`）
- 输出两组 p50 / p95，以及代理不可用时的失败计数
- 判定线：p95 < 300 ms

超标或代理路径完全失败，则先解决再进入第 3 节。

### 2.3 R1b：端到端验证（部署后做）

把 `Stop` hook 指向已部署的 Worker，跑一轮真实会话：

- 首选用 `claude --debug` 读取 hook 执行耗时
- 若 debug 输出不含耗时，退化为 A/B 对比：同一提示词分别在「装 hook」与「不装 hook」下各跑 3 轮，比较回合结束到下一次可输入的间隔

判定线同样是单次往返 300 ms。超标的退路按成本排序：为 Claude Code 进程设 `NO_PROXY=<worker 域名>` → 改用 command hook 加 `curl --noproxy '*'` → 给 `Stop` hook 加哨兵文件开关，按需启用远程。

## 3. 远程模式

### 3.1 为什么需要它

第一阶段的 [`waitForPermission`](../../../src/session-do.ts) 在手机 WebSocket 未连接时立即返回 null，走 fail-open。这与通知的目的直接冲突：推送存在的意义正是「手机没在看 → 叫你去看」，若手机离线就立刻放弃，推送永远不会在最需要的时刻发出。

但反过来把离线也改成挂起等待，会破坏前置文档第 1 节的首要目标「人在电脑前时零感知」——每个权限请求都要先卡一段时间才弹出本地对话框。

因此引入显式开关：**远程模式默认关闭，关闭时行为与第一阶段完全一致**。

### 3.2 状态与过期

状态存 DO 的 `session_state` 表，`remote_mode` 的值为开启时刻的毫秒时间戳，`'0'` 表示关闭。

过期采用**惰性判断**：每次读取时比较 `Date.now() - enabledAt` 是否超过 TTL（默认 8 小时），超过即视为关闭。不使用 DO alarm——少一个活动部件，且过期本身不需要副作用。

8 小时上限的作用是兜住「忘记关闭」：即使忘了关，隔夜回到电脑前也已自动恢复零感知行为。

### 3.3 分级超时

挂起策略对权限请求与 Stop 请求统一：

| 远程模式 | 手机已连接 | 行为 |
|---|---|---|
| 关 | 否 | 立即返回 null（第一阶段现有行为，零感知） |
| 关 | 是 | 挂起至多 590 s |
| 开 | 否 | 推送 → 等 90 s；期间连上则续等 500 s，否则 fail-open |
| 开 | 是 | 推送 → 挂起至多 590 s |

两级窗口合计 590 s，仍在 hook 的 600 s 上限内。90 s 到期时只做一次 `getWebSockets().length` 检查来决定续等还是放弃，不需要在 WebSocket 连接时注册任何回调——实现更简单，语义等价。

这样即使忘记关闭远程模式，坐在电脑前的代价也只是每个权限请求多等 90 s，而非十分钟。

### 3.4 协议扩展

手机 → 云新增：

```json
{ "type": "remote_mode", "enabled": true }
```

云 → 手机新增，并在 `snapshot` 中携带同样两个字段：

```json
{ "type": "remote_mode", "enabled": true, "expiresAt": 1755500000000 }
```

`expiresAt` 在关闭状态下为 `null`。手机控制台顶部增加一个开关按钮，显示当前状态与剩余有效时间。

## 4. 通知适配器

### 4.1 接口

`src/notifier.ts`：

```ts
interface Notification { title: string; body: string; clickUrl: string }
interface Notifier { notify(n: Notification): Promise<void> }

class NtfyNotifier implements Notifier   // 默认实现
class NullNotifier implements Notifier   // NTFY_TOPIC 未配置时的空实现
function createNotifier(env: Env): Notifier
```

企业微信实现留到渠道确定后再加，届时只需新增一个类与 `createNotifier` 的一个分支。

### 4.2 ntfy 请求形式

使用 ntfy 的 **JSON publish** 形式，而非 header 形式：

```http
POST https://ntfy.sh/
Content-Type: application/json

{ "topic": "<NTFY_TOPIC>", "title": "...", "message": "...", "click": "https://<worker>/s/<sessionId>", "priority": 4 }
```

选 JSON body 是因为标题与正文含中文，而 HTTP header 传非 ASCII 字符需要 RFC 2047 编码，容易出错且不同客户端表现不一。JSON body 全程 UTF-8，无此问题。

`click` 里的公网地址不能由 DO 自行推导——DO 收到的 `request.url` 是内部地址 `https://session.internal`。改由 Worker 在转发时从入站请求取 `new URL(request.url).origin`，随 `/internal/permission` 与 `/internal/stop` 的请求体一并传入。这样本地 `wrangler dev` 与生产环境自适应，无需额外配置一个易过期的域名常量。

### 4.3 触发规则与内容

**远程模式开启时一律推送**，不区分手机是否已连接。远程模式的语义就是「我不在电脑前」，此时漏推的代价远大于多推；且手机浏览器切后台后 WebSocket 常已断开，「已连接」并不等于「正在看」。

推送内容遵守前置文档第 4.4 与第 6 节的最小化原则：

| 场景 | 标题 | 正文 |
|---|---|---|
| 权限请求挂起 | `Claude 等待批准` | 仅 `tool_name`，如 `Bash` |
| Stop 挂起 | `Claude 已完成，等待指令` | 固定文案，不含回复内容 |

`tool_input` 原文与 Claude 的回复文本**都不进推送**，必须点开受 token 保护的页面才能看到。ntfy.sh 公共实例上通知为明文，这条约束不可放松。

`Stop` 每回合末尾触发一次，因此远程模式下每个回合都会推一条。这正是需要的——远程模式下每个回合结束都在等你回应。且 `Stop` 只在 Claude 真正停下等待输入时触发，不随工具调用次数增长，不会刷屏。

`NTFY_TOPIC` 用 `wrangler secret put` 配置而非写进 `vars`——topic 名本身即凭据，任何人知道它就能读到你的全部通知。

### 4.4 失败处理

推送在 DO 内挂起请求时发出，全程 `try/catch` 吞掉异常并 `console.warn`，绝不阻塞或影响挂起流程。ntfy.sh 不可达时，系统退化为「远程模式开着但收不到提醒」，权限请求仍在 DO 内正常等待手机连接。

前置文档第 4.4 节写「推送由 Worker 发出」，实际改为在 DO 内发出：挂起时刻只有 DO 知道，从 Worker 发需要额外的回调路径，无收益。

## 5. 部署

目标是 `*.workers.dev` 免费子域（账号已有，暂无自有域名）。

```powershell
npm run types
npm run typecheck
npm test
npm run deploy:check
wrangler secret put COMPUTER_TOKEN
wrangler secret put PHONE_TOKEN
wrangler secret put NTFY_TOPIC
npm run deploy
```

部署后第一件事是**用手机移动网络（非 Wi-Fi）实测 workers.dev 可达性**。这是整套机制的单点：页面打不开，推送链接就形同虚设，远程模式随之失效。

不通时的退路按成本排序：

1. 换用 Cloudflare 提供的其他免费入口
2. 注册一个域名接入 Cloudflare，绑自定义域（可达性最优，成本是年费）
3. 换推送渠道为企业微信——**这只解决收不到通知，解决不了页面打不开**，属治标

## 6. 真实会话接入

按 README 配置 `~/.claude/settings.json`，把三个 hook 指向已部署的 Worker，逐条验证：

1. 权限批准 / 拒绝 / 总是允许这类
2. Stop 指令注入与完整回复展示
3. 软中断（Bash 调用后生效）
4. 断线重连后快照补齐
5. 远程模式开启 → 收到 ntfy 推送 → 点击进入页面 → 完成决策的完整闭环
6. 远程模式关闭时手机离线，确认本地弹窗行为与未装此系统时一致

同时完成 2.3 节的 R1b 测量。

## 7. 代码组织

`session-do.ts` 当前 248 行，已同时承担建表、WebSocket 收发、请求挂起、状态机四件事。本阶段要加入远程模式、分级超时与推送触发，直接堆入会推到约 350 行，且分级超时的分支只能透过 DO 间接测试。

因此把「挂起等待 + 分级超时」抽到独立模块：

| 文件 | 状态 | 职责 |
|---|---|---|
| `src/pending.ts` | 新增 | 挂起请求的注册、分级超时、resolve 与取消。不知道 WebSocket 与 SQL 的存在，只接收一个「当前是否有连接」的查询函数 |
| `src/notifier.ts` | 新增 | 通知接口与 ntfy 实现 |
| `scripts/measure-baseline.ps1` | 新增 | R1a 测量 |
| `src/session-do.ts` | 修改 | 路由、SQL 状态、WebSocket 收发、远程模式读写；挂起逻辑委托给 `pending.ts` |
| `src/protocol.ts` | 修改 | `remote_mode` 消息类型，`Snapshot` 增加两个字段 |
| `src/ui.ts` | 修改 | 远程模式开关与剩余时间显示 |
| `wrangler.jsonc` | 修改 | 三个超时相关 var |
| `README.md` | 修改 | ntfy 配置、远程模式说明、部署步骤补 `NTFY_TOPIC` |

超时值改为 `vars` 可配置，测试注入小值：

| 变量 | 默认 | 用途 |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | `590000` | 挂起总上限 |
| `REMOTE_OFFLINE_TIMEOUT_MS` | `90000` | 远程模式下等待手机连入的窗口 |
| `REMOTE_MODE_TTL_MS` | `28800000` | 远程模式自动失效时长（8 小时） |

不做成可配置的话，90 秒与 8 小时这两个分支在测试中根本无法覆盖。三者按现有 `MAX_RECENT_MESSAGES` 的惯例以字符串形式写入 `vars`，读取时解析并做上下界钳制，非法值回落到默认。

## 8. 测试策略

沿用第一阶段的三层结构，新增：

**`pending.ts` 单测**（纯逻辑，无需 DO）
- 远程模式关 + 无连接 → 立即返回 null
- 远程模式关 + 有连接 → 挂起至总上限
- 远程模式开 + 无连接 → 短窗口到期后返回 null
- 远程模式开 + 无连接 → 短窗口内连上，续等至总上限
- 决策到达时清除定时器，不重复 resolve

**`notifier.ts` 单测**
- `NtfyNotifier` 发出的 JSON body 字段与 topic 正确
- 正文不含 `tool_input` 与回复原文
- fetch 抛错时 `notify` 不抛出
- `NTFY_TOPIC` 缺失时 `createNotifier` 返回 `NullNotifier`，不发任何请求

**DO 单测**
- 远程模式开启后写入时间戳，读取返回 enabled 与 expiresAt
- 超过 TTL 后读取返回关闭
- `snapshot` 含 `remoteMode` 与 `expiresAt`

**契约测试**：保持第一阶段 8 项全绿，确认 hook 输出 schema 未因本阶段改动而变化。

## 9. 对前置文档的修订

本阶段实施后，前置文档以下条目需要按此文档理解：

1. 第 4.4 节「推送由 Worker 发出」→ 改为在 SessionDO 内发出（见 4.4）
2. 第 7 节「手机未连接 → DO 立即返回空 body」→ 仅在远程模式关闭时成立（见 3.3）
3. 第 9 节 R1 与第 10.4 条关于 `HTTP_PROXY` 影响 `Stop` hook 的表述 → 前提有误，重新表述见 2.1
4. 第 11 节实现顺序第 0 步 → 拆为 R1a（部署前）与 R1b（部署后）

安全设计（第 6 节）与错误处理原则（第 7 节「所有故障模式退化为没装这套系统」）不变，远程模式的 fail-open 语义与之一致。

## 10. 实现顺序

1. **R1a 网络基线**——超标则先解决，不进入后续
2. **`pending.ts` 抽取**——先做纯重构，保持现有 8 项测试全绿，再加分级超时
3. **远程模式**——DO 状态、协议、UI 开关
4. **通知适配器**——`notifier.ts` 与 DO 内触发
5. **部署**——secrets、`wrangler deploy`、手机移动网络可达性实测
6. **真实会话接入与 R1b**——六条链路逐一验证

第 2 步刻意分成「先重构后加功能」两小步：重构阶段测试不应有任何变化，这是判断抽取是否等价的唯一可靠信号。
