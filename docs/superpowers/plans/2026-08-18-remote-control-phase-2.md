# 手机远程操控 Claude Code 第二阶段 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给已有的 Worker + Durable Object 骨架补上远程模式开关、分级超时、ntfy 推送与性能基线，并完成正式部署与真实 Claude Code 会话接入。

**Architecture:** 把「挂起等待 + 分级超时」从 `SessionDO` 抽到纯逻辑模块 `src/pending.ts`，把通知抽到 `src/notifier.ts`。远程模式作为一个存在 DO SQLite `session_state` 表里的时间戳，读取时惰性判断是否超过 TTL。`SessionDO` 只保留路由、SQL 状态、WebSocket 收发三件事。

**Tech Stack:** TypeScript 7、Cloudflare Workers + Durable Objects（SQLite 存储 + WebSocket Hibernation）、Wrangler 4、Vitest 4 + `@cloudflare/vitest-pool-workers`、PowerShell 5.1/7（基线脚本与 hook）。

## Global Constraints

以下要求来自 [spec](../specs/2026-08-18-remote-control-phase-2-design.md)，适用于每一个任务，不再在单任务里重复：

- **Fail-open 是硬约束。** 任何失败路径（缺凭据、请求畸形、网络错误、手机离线、超时、推送失败）都必须退化为「空响应 / 返回 null / 不阻塞」，**绝不能返回 allow**。
- **远程模式默认关闭；关闭时行为必须与第一阶段逐字节一致**（手机未连接 → 立即返回 null）。
- **推送正文绝不含 `tool_input` 原文与 Claude 回复文本。** 权限推送正文只有 `tool_name`；Stop 推送正文是固定文案。
- **`NTFY_TOPIC` 只能用 `wrangler secret put` 配置，禁止写进 `wrangler.jsonc` 的 `vars`**，也禁止提交进 git。topic 名本身即凭据。
- **超时总上限 590000 ms**，不得超过 Claude Code hook 的 600 s 上限。两级窗口相加不得超过总上限。
- **三个新超时变量以字符串形式写入 `wrangler.jsonc` 的 `vars`**（沿用现有 `MAX_RECENT_MESSAGES: "50"` 的惯例），读取时解析并做上下界钳制，非法值回落默认。
- **不改动第一阶段已验证的对外协议**：`PermissionRequest` 的 `{hookSpecificOutput: {hookEventName, decision}}`、`Stop` 的 `{decision: "block", reason}`、中断 hook 的退出码 `0/2`，全部保持不变。`test/worker-contract.test.ts` 的 2 项契约测试必须始终全绿。
- **新增的三个 var 只加进 `wrangler.jsonc`，不要加进 `src/env.d.ts`。** `env.d.ts` 只声明 secrets；vars 由 `npm run types` 生成到 `worker-configuration.d.ts`。两处都写会因接口合并时 `string` 与 `string | undefined` 类型不一致而报错。
- **每个任务结束时提交，commit 标题用英文 `type(scope): summary`（≤72 字符、首字母小写、结尾无句号），空一行，正文用中文说明原因与核心变更。**
- **未获用户明确同意，不得执行 `git push`。**

**当前基线（开工前的事实）：** `npm run typecheck` 退出码 0；`npm test` 8 项全绿；`npm run deploy:check` 退出码 0。每个任务的验证步骤都以此为对照。

---

### Task 1: R1a 网络层性能基线

先做这一步的理由：spec 第 10 节把它列为第 1 步，且它是唯一一个**不达标就不该继续**的门槛。若代理链路把 p95 拖到 300 ms 以上，后面的 hook 设计要重做。

前置文档曾断言 `HTTP_PROXY` 会被 hook 子进程继承从而拖慢 `Stop`。这个前提是错的：`PermissionRequest` 与 `Stop` 是 `type: "http"`，由 Claude Code 主进程直接发请求，不 fork 子进程。所以这一步测的是**网络层本身**，主进程是否真的走代理要等 Task 9 的 R1b 实测。

**Files:**
- Create: `scripts/measure-baseline.ps1`

**Interfaces:**
- Consumes: 无
- Produces: 无代码产物。产出是一组实测数字，记录进本文件末尾的「基线记录」小节。

- [ ] **Step 1: 创建 `scripts/` 目录并写测量脚本**

创建 `scripts/measure-baseline.ps1`：

```powershell
#Requires -Version 5.1
<#
.SYNOPSIS
  R1a 网络层基线：测量到 Cloudflare 边缘的往返延迟，对比直连与经代理两种环境。
.DESCRIPTION
  目标端点与 workers.dev 走同一张 Cloudflare 边缘网络，因此不依赖本项目是否已部署。
  判定线：p95 < 300 ms。
#>
[CmdletBinding()]
param(
  [string]$Url = 'https://cloudflare.com/cdn-cgi/trace',
  [int]$Samples = 20,
  [string]$ProxyUrl = 'http://127.0.0.1:7890',
  [int]$ThresholdMs = 300
)

$ErrorActionPreference = 'Stop'
$supportsNoProxy = (Get-Command Invoke-WebRequest).Parameters.ContainsKey('NoProxy')

function Get-Percentile {
  param([double[]]$Values, [double]$Percentile)
  if ($Values.Count -eq 0) { return [double]::NaN }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling($Percentile / 100.0 * $sorted.Count) - 1
  if ($index -lt 0) { $index = 0 }
  if ($index -ge $sorted.Count) { $index = $sorted.Count - 1 }
  return [double]$sorted[$index]
}

function Measure-Endpoint {
  param([string]$Label, [string]$TargetUrl, [int]$Count, [string]$Proxy)

  $timings = New-Object System.Collections.Generic.List[double]
  $failures = 0

  for ($i = 1; $i -le $Count; $i++) {
    $request = @{ Uri = $TargetUrl; Method = 'GET'; TimeoutSec = 10; UseBasicParsing = $true }
    if ($Proxy) {
      $request.Proxy = $Proxy
    } elseif ($supportsNoProxy) {
      $request.NoProxy = $true
    }

    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      Invoke-WebRequest @request | Out-Null
      $watch.Stop()
      $timings.Add($watch.Elapsed.TotalMilliseconds)
    } catch {
      $watch.Stop()
      $failures++
    }
    Write-Progress -Activity $Label -Status "$i / $Count" -PercentComplete ($i * 100 / $Count)
  }
  Write-Progress -Activity $Label -Completed

  [pscustomobject]@{
    Label    = $Label
    Ok       = $timings.Count
    Failures = $failures
    P50Ms    = [Math]::Round((Get-Percentile -Values $timings.ToArray() -Percentile 50), 1)
    P95Ms    = [Math]::Round((Get-Percentile -Values $timings.ToArray() -Percentile 95), 1)
  }
}

$savedHttp = $env:HTTP_PROXY
$savedHttps = $env:HTTPS_PROXY
$results = @()
try {
  $env:HTTP_PROXY = $null
  $env:HTTPS_PROXY = $null
  $results += Measure-Endpoint -Label 'direct' -TargetUrl $Url -Count $Samples -Proxy $null
  $results += Measure-Endpoint -Label "proxy $ProxyUrl" -TargetUrl $Url -Count $Samples -Proxy $ProxyUrl
} finally {
  $env:HTTP_PROXY = $savedHttp
  $env:HTTPS_PROXY = $savedHttps
}

$results | Format-Table -AutoSize

$verdict = 0
foreach ($row in $results) {
  if ($row.Ok -eq 0) {
    Write-Warning "$($row.Label): 全部失败（$($row.Failures) 次），无法给出基线"
    $verdict = 1
    continue
  }
  if ($row.P95Ms -ge $ThresholdMs) {
    Write-Warning "$($row.Label): p95 = $($row.P95Ms) ms，超过判定线 $ThresholdMs ms"
    $verdict = 1
  } else {
    Write-Host "$($row.Label): p95 = $($row.P95Ms) ms，达标" -ForegroundColor Green
  }
}
exit $verdict
```

- [ ] **Step 2: 运行脚本**

```powershell
pwsh -NoProfile -File scripts/measure-baseline.ps1
```

若机器上只有 Windows PowerShell 5.1，用 `powershell -NoProfile -File scripts/measure-baseline.ps1`。

预期：输出两行表格（`direct` 与 `proxy ...`），各含 `Ok` / `Failures` / `P50Ms` / `P95Ms`。

- [ ] **Step 3: 判读结果**

三种情况分别处理：

1. 两组 p95 都 < 300 ms → 达标，继续 Task 2。
2. `proxy` 组 `Ok = 0`（代理没开着）→ 这不是失败，说明当前环境不经代理。把 `direct` 组结果作为基线，继续 Task 2，并在记录里注明代理未启用。
3. 任一实际测出的 p95 ≥ 300 ms → **停下来先解决**，不要进入 Task 2。把数字与环境（是否挂代理、代理软件）报告给用户再决定。

- [ ] **Step 4: 把数字写进本文件末尾的「基线记录」小节**

替换本文件末尾 `## 基线记录` 下的占位行，填入实际的 p50 / p95 / 失败数与测量日期。

- [ ] **Step 5: 提交**

```bash
git add scripts/measure-baseline.ps1 docs/superpowers/plans/2026-08-18-remote-control-phase-2.md
git commit -m "test(baseline): add R1a network latency measurement script

新增 R1a 网络层基线脚本，对比直连与经代理两种环境下到 Cloudflare 边缘的
往返延迟，输出 p50/p95 与失败计数，判定线 p95 < 300 ms。
脚本不依赖本项目部署，目标端点与 workers.dev 走同一张边缘网络。
实测结果记入实现计划的基线记录小节。"
```

---

### Task 2: 抽取 `pending.ts`（纯重构，不改行为）

这一步**刻意不加任何新功能**。重构阶段测试不应有任何变化，这是判断抽取是否等价的唯一可靠信号。分级超时在 Task 3 才加。

**Files:**
- Create: `src/pending.ts`
- Create: `test/pending.test.ts`
- Modify: `src/session-do.ts`（删除 `PendingPermissionState` / `PendingStopState` / `REQUEST_TIMEOUT_MS`，改写 `waitForPermission` / `waitForStop` / `handleClientMessage`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `class Pending<T>`，构造参数 `{ timeoutMs?: number; isConnected: () => boolean; onSettled?: () => void }`
  - `pending.waiting: boolean` —— `false` 表示已经立即 fail-open，调用方不应广播
  - `pending.promise: Promise<T | null>`
  - `pending.settle(value: T | null): void` —— 幂等，清定时器，最多调用一次 `onSettled`

- [ ] **Step 1: 写失败的测试**

创建 `test/pending.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { Pending } from "../src/pending";

describe("Pending", () => {
  it("fails open immediately when nothing is connected", async () => {
    const request = new Pending<string>({ isConnected: () => false });
    expect(request.waiting).toBe(false);
    expect(await request.promise).toBeNull();
  });

  it("waits while connected and resolves with the settled value", async () => {
    const request = new Pending<string>({ timeoutMs: 5_000, isConnected: () => true });
    expect(request.waiting).toBe(true);
    request.settle("answer");
    expect(await request.promise).toBe("answer");
  });

  it("resolves null once the timeout elapses", async () => {
    const request = new Pending<string>({ timeoutMs: 20, isConnected: () => true });
    expect(await request.promise).toBeNull();
  });

  it("calls onSettled exactly once and ignores repeated settles", async () => {
    let settledCount = 0;
    const request = new Pending<string>({ timeoutMs: 5_000, isConnected: () => true, onSettled: () => { settledCount += 1; } });
    request.settle("first");
    request.settle("second");
    expect(await request.promise).toBe("first");
    expect(settledCount).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- test/pending.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/pending"`。

- [ ] **Step 3: 写 `src/pending.ts`**

```ts
const REQUEST_TIMEOUT_MS = 590_000;

export interface PendingOptions {
  /** 挂起总上限，毫秒。缺省为 590000，即 Claude Code hook 600 s 上限之内。 */
  timeoutMs?: number;
  /** 当前是否有手机连接。构造时同步调用一次。 */
  isConnected: () => boolean;
  /** 无论因何种原因结束，都恰好调用一次，供调用方清理自己的登记表。 */
  onSettled?: () => void;
}

/**
 * 一个挂起中的请求。不知道 WebSocket 与 SQL 的存在，只通过 isConnected 查询连接状态。
 */
export class Pending<T> {
  private readonly deferred: Promise<T | null>;
  private readonly onSettled?: () => void;
  private readonly active: boolean;
  private resolveDeferred!: (value: T | null) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(options: PendingOptions) {
    this.onSettled = options.onSettled;
    this.deferred = new Promise<T | null>((resolve) => { this.resolveDeferred = resolve; });

    if (!options.isConnected()) {
      this.active = false;
      this.settle(null);
      return;
    }
    this.active = true;
    this.timer = setTimeout(() => this.settle(null), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  }

  /** false 表示已经立即 fail-open，调用方不应广播，也不应登记。 */
  get waiting(): boolean {
    return this.active && !this.settled;
  }

  get promise(): Promise<T | null> {
    return this.deferred;
  }

  settle(value: T | null): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolveDeferred(value);
    this.onSettled?.();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm test -- test/pending.test.ts
```

预期：PASS，4 项全绿。

- [ ] **Step 5: 改写 `src/session-do.ts` 使用 `Pending`**

改导入，删掉文件顶部的 `PendingPermissionState` / `PendingStopState` 两个接口和 `REQUEST_TIMEOUT_MS` 常量，换成：

```ts
import { DurableObject } from "cloudflare:workers";
import { Pending } from "./pending";
import {
  asRecord,
  parseClientMessage,
  type ClientMessage,
  type PendingPermission,
  type PermissionDecision,
  type PermissionPayload,
  type RecentMessage,
  type ServerMessage,
  type Snapshot,
} from "./protocol";

interface PendingPermissionState {
  payload: PendingPermission;
  request: Pending<PermissionDecision>;
}
```

字段声明改为：

```ts
  private readonly pendingPermissions = new Map<string, PendingPermissionState>();
  private pendingStop: Pending<string> | null = null;
```

`waitForPermission` 整体替换为：

```ts
  private async waitForPermission(payload: PermissionPayload): Promise<PermissionDecision | null> {
    const pending: PendingPermission = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...payload,
    };
    const request = new Pending<PermissionDecision>({
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { this.pendingPermissions.delete(pending.id); },
    });
    if (!request.waiting) return null;
    this.pendingPermissions.set(pending.id, { payload: pending, request });
    this.broadcast({
      type: "permission",
      id: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      suggestions: pending.permissionSuggestions,
    });
    return request.promise;
  }
```

`waitForStop` 整体替换为：

```ts
  private async waitForStop(): Promise<string | null> {
    this.pendingStop?.settle(null);
    // stored 必须在闭包外先声明：立即 fail-open 时 onSettled 会在 request 还处于
    // TDZ 时被同步调用，闭包里不能引用 request 本身。
    let stored = false;
    const request = new Pending<string>({
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { if (stored) this.pendingStop = null; },
    });
    if (!request.waiting) return null;
    stored = true;
    this.pendingStop = request;
    return request.promise;
  }
```

`handleClientMessage` 里两处清理逻辑改为调用 `settle`：

```ts
  private handleClientMessage(message: ClientMessage, socket: WebSocket): void {
    if (message.type === "decision") {
      const pending = this.pendingPermissions.get(message.id);
      if (!pending) {
        this.send(socket, { type: "error", message: "permission request is no longer pending" });
        return;
      }
      const decision: PermissionDecision = {
        behavior: message.behavior,
        ...(message.always && message.behavior === "allow" ? { updatedPermissions: pending.payload.permissionSuggestions } : {}),
      };
      pending.request.settle(decision);
      return;
    }
    if (message.type === "message") {
      if (!this.pendingStop) {
        this.send(socket, { type: "error", message: "session is not waiting for a message" });
        return;
      }
      this.pendingStop.settle(message.text);
      return;
    }
    void this.setInterrupt().then(() => this.send(socket, { type: "interrupt_ack" }));
  }
```

`snapshot()` 里取 pending 列表的那一行不变（`item.payload` 字段名未改）。

- [ ] **Step 6: 全量验证——重构等价性的唯一信号**

```bash
npm run typecheck && npm test
```

预期：typecheck 退出码 0；测试 **12 项全绿**（原 8 项 + 新增 4 项 `Pending` 单测）。**原有 8 项测试的代码一行都不该改。** 若为了让它们通过而修改了任何一项，说明抽取不等价，回到 Step 5 重做。

- [ ] **Step 7: 提交**

```bash
git add src/pending.ts src/session-do.ts test/pending.test.ts
git commit -m "refactor(session): extract pending request handling into pending.ts

把挂起请求的注册、超时与 resolve 从 SessionDO 抽到独立的 Pending 类。
该类不感知 WebSocket 与 SQL，只通过 isConnected 回调查询连接状态，
并用 onSettled 回调让调用方清理自己的登记表。
纯重构，行为与原实现等价，原有 8 项测试未作任何修改即保持全绿。"
```

---

### Task 3: 分级超时

给 `Pending` 加上远程模式感知的两级窗口，并把三个超时值改为 `vars` 可配置。此时 `SessionDO` 还没有远程模式状态，先传字面量 `false`，Task 4 再接上真实状态。

spec 第 3.3 节的四行表格是本任务的验收标准：

| 远程模式 | 手机已连接 | 行为 |
|---|---|---|
| 关 | 否 | 立即返回 null |
| 关 | 是 | 挂起至多 `requestTimeoutMs` |
| 开 | 否 | 等 `remoteOfflineTimeoutMs`；到期时若已连上则续等 `requestTimeoutMs - remoteOfflineTimeoutMs`，否则返回 null |
| 开 | 是 | 挂起至多 `requestTimeoutMs` |

**Files:**
- Modify: `src/pending.ts`（`PendingOptions` 换形，新增 `PendingTimeouts` 与 `readTimeouts`）
- Modify: `test/pending.test.ts`（改写既有 4 项，补 3 项）
- Modify: `src/session-do.ts`（两处 `new Pending` 传入新参数）
- Modify: `wrangler.jsonc`（新增 3 个 var）
- Modify: `vitest.config.ts`（注入测试用小值）

**Interfaces:**
- Consumes: Task 2 的 `Pending`
- Produces:
  - `interface PendingTimeouts { requestTimeoutMs: number; remoteOfflineTimeoutMs: number }`
  - `PendingOptions` 变为 `{ timeouts: PendingTimeouts; remoteMode: boolean; isConnected: () => boolean; onSettled?: () => void }`（`timeoutMs` 被移除）
  - `function readTimeouts(env: Env): PendingTimeouts`

- [ ] **Step 1: 先加三个 var 并重新生成类型**

`wrangler.jsonc` 的 `vars` 段改为：

```jsonc
  "vars": {
    "MAX_RECENT_MESSAGES": "50",
    "REQUEST_TIMEOUT_MS": "590000",
    "REMOTE_OFFLINE_TIMEOUT_MS": "90000",
    "REMOTE_MODE_TTL_MS": "28800000"
  },
```

然后：

```bash
npm run types
```

预期：`worker-configuration.d.ts` 被重新生成，其中的 `Env` 含这三个 `string` 字段。**不要**把它们加进 `src/env.d.ts`。

- [ ] **Step 2: 在 `vitest.config.ts` 注入测试用小值**

`miniflare.bindings` 改为：

```ts
        bindings: {
          COMPUTER_TOKEN: "test-computer-token",
          PHONE_TOKEN: "test-phone-token",
          // 测试注入小值：不这样做，90 秒与 8 小时两个分支根本无法覆盖。
          REQUEST_TIMEOUT_MS: "200",
          REMOTE_OFFLINE_TIMEOUT_MS: "40",
          REMOTE_MODE_TTL_MS: "300",
        },
```

注意 `REMOTE_MODE_TTL_MS: "300"` 的后果：DO 测试里一旦开启远程模式，300 ms 后就会自动过期。写 DO 测试时不要在开启与断言之间插入长时间的 await。

- [ ] **Step 3: 改写 `test/pending.test.ts` 为失败的测试**

整体替换文件内容：

```ts
import { describe, expect, it } from "vitest";
import { Pending, readTimeouts, type PendingTimeouts } from "../src/pending";

const TIMEOUTS: PendingTimeouts = { requestTimeoutMs: 200, remoteOfflineTimeoutMs: 40 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Pending tiered timeout", () => {
  it("fails open immediately when remote mode is off and nothing is connected", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: false, isConnected: () => false });
    expect(request.waiting).toBe(false);
    expect(await request.promise).toBeNull();
  });

  it("waits for the full window when remote mode is on and a phone is connected", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: true, isConnected: () => true });
    expect(request.waiting).toBe(true);
    await sleep(60);
    expect(request.waiting).toBe(true);
    request.settle("answer");
    expect(await request.promise).toBe("answer");
  });

  it("gives up after the offline window when remote mode is on and no phone connects", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: true, isConnected: () => false });
    expect(request.waiting).toBe(true);
    expect(await request.promise).toBeNull();
  });

  it("extends to the full window when a phone connects inside the offline window", async () => {
    let connected = false;
    setTimeout(() => { connected = true; }, 10);
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: true, isConnected: () => connected });
    await sleep(70);
    expect(request.waiting).toBe(true);
    request.settle("late answer");
    expect(await request.promise).toBe("late answer");
  });

  it("waits the full window then fails open when remote mode is off and a phone is connected", async () => {
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: false, isConnected: () => true });
    expect(request.waiting).toBe(true);
    expect(await request.promise).toBeNull();
  });

  it("clears its timer on settle and never resolves twice", async () => {
    let settledCount = 0;
    const request = new Pending<string>({ timeouts: TIMEOUTS, remoteMode: false, isConnected: () => true, onSettled: () => { settledCount += 1; } });
    request.settle("first");
    request.settle("second");
    await sleep(TIMEOUTS.requestTimeoutMs + 30);
    expect(await request.promise).toBe("first");
    expect(settledCount).toBe(1);
  });
});

describe("readTimeouts", () => {
  it("falls back to defaults for missing, blank and non-numeric values", () => {
    expect(readTimeouts({} as Env)).toEqual({ requestTimeoutMs: 590_000, remoteOfflineTimeoutMs: 90_000 });
    expect(readTimeouts({ REQUEST_TIMEOUT_MS: "  ", REMOTE_OFFLINE_TIMEOUT_MS: "abc" } as unknown as Env))
      .toEqual({ requestTimeoutMs: 590_000, remoteOfflineTimeoutMs: 90_000 });
  });

  it("clamps out-of-range values and keeps the offline window inside the total", () => {
    expect(readTimeouts({ REQUEST_TIMEOUT_MS: "99999999", REMOTE_OFFLINE_TIMEOUT_MS: "0" } as unknown as Env))
      .toEqual({ requestTimeoutMs: 590_000, remoteOfflineTimeoutMs: 10 });
    expect(readTimeouts({ REQUEST_TIMEOUT_MS: "100", REMOTE_OFFLINE_TIMEOUT_MS: "5000" } as unknown as Env))
      .toEqual({ requestTimeoutMs: 100, remoteOfflineTimeoutMs: 100 });
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

```bash
npm test -- test/pending.test.ts
```

预期：FAIL，报 `readTimeouts` 不是导出成员、以及 `PendingOptions` 缺少 `timeouts` / `remoteMode`。

- [ ] **Step 5: 改写 `src/pending.ts`**

整体替换文件内容：

```ts
export interface PendingTimeouts {
  /** 挂起总上限，毫秒。两级窗口相加不超过这个值。 */
  requestTimeoutMs: number;
  /** 远程模式下等待手机连入的第一级窗口，毫秒。 */
  remoteOfflineTimeoutMs: number;
}

export interface PendingOptions {
  timeouts: PendingTimeouts;
  /** 远程模式是否开启。关闭时保持第一阶段的零感知行为。 */
  remoteMode: boolean;
  /** 当前是否有手机连接。构造时调用一次，第一级窗口到期时再调用一次。 */
  isConnected: () => boolean;
  /** 无论因何种原因结束，都恰好调用一次，供调用方清理自己的登记表。 */
  onSettled?: () => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 590_000;
const DEFAULT_REMOTE_OFFLINE_TIMEOUT_MS = 90_000;
/** 下界取 10 ms 而非秒级，否则测试无法注入小值覆盖两级窗口分支。 */
const MIN_TIMEOUT_MS = 10;
/** 上界即 Claude Code hook 600 s 上限内的安全值。 */
const MAX_TIMEOUT_MS = 590_000;

function readMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

export function readTimeouts(env: Env): PendingTimeouts {
  const requestTimeoutMs = readMs(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
  return {
    requestTimeoutMs,
    remoteOfflineTimeoutMs: Math.min(requestTimeoutMs, readMs(env.REMOTE_OFFLINE_TIMEOUT_MS, DEFAULT_REMOTE_OFFLINE_TIMEOUT_MS)),
  };
}

/**
 * 一个挂起中的请求。不知道 WebSocket 与 SQL 的存在，只通过 isConnected 查询连接状态。
 */
export class Pending<T> {
  private readonly deferred: Promise<T | null>;
  private readonly onSettled?: () => void;
  private readonly active: boolean;
  private resolveDeferred!: (value: T | null) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(options: PendingOptions) {
    this.onSettled = options.onSettled;
    this.deferred = new Promise<T | null>((resolve) => { this.resolveDeferred = resolve; });

    const { timeouts, remoteMode, isConnected } = options;
    const connected = isConnected();

    if (!remoteMode && !connected) {
      this.active = false;
      this.settle(null);
      return;
    }
    this.active = true;

    if (remoteMode && !connected) {
      this.timer = setTimeout(() => {
        // 第一级窗口到期时只查一次连接状态，不需要在 WebSocket 连接时注册回调。
        if (!isConnected()) { this.settle(null); return; }
        const remaining = timeouts.requestTimeoutMs - timeouts.remoteOfflineTimeoutMs;
        if (remaining <= 0) { this.settle(null); return; }
        this.timer = setTimeout(() => this.settle(null), remaining);
      }, timeouts.remoteOfflineTimeoutMs);
      return;
    }

    this.timer = setTimeout(() => this.settle(null), timeouts.requestTimeoutMs);
  }

  /** false 表示已经立即 fail-open，调用方不应广播，也不应登记。 */
  get waiting(): boolean {
    return this.active && !this.settled;
  }

  get promise(): Promise<T | null> {
    return this.deferred;
  }

  settle(value: T | null): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolveDeferred(value);
    this.onSettled?.();
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npm test -- test/pending.test.ts
```

预期：PASS，8 项全绿。

- [ ] **Step 7: 更新 `session-do.ts` 的两处调用**

顶部导入改为 `import { Pending, readTimeouts } from "./pending";`。

`waitForPermission` 里的 `new Pending<PermissionDecision>({...})` 补两个字段：

```ts
    const request = new Pending<PermissionDecision>({
      timeouts: readTimeouts(this.env),
      remoteMode: false, // Task 4 接入真实的远程模式状态
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { this.pendingPermissions.delete(pending.id); },
    });
```

`waitForStop` 里同样：

```ts
    const request = new Pending<string>({
      timeouts: readTimeouts(this.env),
      remoteMode: false, // Task 4 接入真实的远程模式状态
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { if (stored) this.pendingStop = null; },
    });
```

- [ ] **Step 8: 全量验证**

```bash
npm run typecheck && npm test
```

预期：typecheck 退出码 0；测试 16 项全绿（原 8 项 + `Pending` 8 项）。

- [ ] **Step 9: 提交**

```bash
git add src/pending.ts test/pending.test.ts src/session-do.ts wrangler.jsonc vitest.config.ts worker-configuration.d.ts
git commit -m "feat(pending): add remote-mode aware tiered timeout

给挂起请求加入两级超时：远程模式开启且手机未连接时先等一个短窗口，
到期时若手机已连上则续等到总上限，否则 fail-open。远程模式关闭时行为
与第一阶段完全一致。三个超时值改为 vars 可配置并做上下界钳制，
否则短窗口与 TTL 分支在测试中无法覆盖。
本次 SessionDO 仍传 remoteMode: false，真实状态在下一步接入。"
```

若 `worker-configuration.d.ts` 已被 `.gitignore` 排除，从 `git add` 列表里去掉它。

---

### Task 4: 远程模式状态、协议与接线

远程模式的状态存 DO 的 `session_state` 表，值是开启时刻的毫秒时间戳，`'0'` 表示关闭。过期采用惰性判断：每次读取时比较 `Date.now() - enabledAt` 是否超过 TTL，超过即视为关闭。不使用 DO alarm——少一个活动部件，且过期本身不需要副作用。

**Files:**
- Modify: `src/protocol.ts`（`Snapshot` 加两个字段，两个消息类型各加一个变体，`parseClientMessage` 加一个分支）
- Modify: `src/session-do.ts`（`readRemoteMode` / `writeRemoteMode` / `remoteModeTtlMs`，接进 `handleClientMessage`、`snapshot`、两处 `Pending`）
- Modify: `test/protocol.test.ts`（补 `remote_mode` 解析）
- Modify: `test/session-do.test.ts`（补 3 项 DO 测试）

**Interfaces:**
- Consumes: Task 3 的 `Pending` 与 `readTimeouts`
- Produces:
  - `ServerMessage` 新增 `{ type: "remote_mode"; enabled: boolean; expiresAt: number | null }`
  - `ClientMessage` 新增 `{ type: "remote_mode"; enabled: boolean }`
  - `Snapshot` 新增 `remoteMode: boolean` 与 `expiresAt: number | null`

- [ ] **Step 1: 写失败的协议测试**

在 `test/protocol.test.ts` 的 `describe` 块内追加：

```ts
  it("parses the remote mode toggle and rejects a missing flag", () => {
    expect(parseClientMessage({ type: "remote_mode", enabled: true })).toEqual({ type: "remote_mode", enabled: true });
    expect(parseClientMessage({ type: "remote_mode", enabled: false })).toEqual({ type: "remote_mode", enabled: false });
    expect(parseClientMessage({ type: "remote_mode" })).toBeNull();
    expect(parseClientMessage({ type: "remote_mode", enabled: "yes" })).toBeNull();
  });
```

- [ ] **Step 2: 写失败的 DO 测试**

在 `test/session-do.test.ts` 顶部把 `env` 之外再引入 WebSocket 辅助，整体在 `describe` 块内追加三项。先在文件顶部加一个辅助函数：

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectPhone(name: string): Promise<WebSocket> {
  const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/ws", {
    headers: { Upgrade: "websocket" },
  }));
  const socket = response.webSocket;
  if (!socket) throw new Error("expected a websocket upgrade");
  socket.accept();
  return socket;
}
```

然后追加：

```ts
  it("enables remote mode with an expiry and reports it in the snapshot", async () => {
    const name = "remote-mode-on";
    const socket = await connectPhone(name);
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    await sleep(20);
    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ remoteMode: boolean; expiresAt: number | null }>();
    expect(snapshot.remoteMode).toBe(true);
    expect(typeof snapshot.expiresAt).toBe("number");
    socket.close();
  });

  it("treats remote mode as off once the ttl has elapsed", async () => {
    const name = "remote-mode-ttl";
    const socket = await connectPhone(name);
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    // vitest.config.ts 把 REMOTE_MODE_TTL_MS 注入为 300 ms
    await sleep(360);
    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ remoteMode: boolean; expiresAt: number | null }>();
    expect(snapshot.remoteMode).toBe(false);
    expect(snapshot.expiresAt).toBeNull();
    socket.close();
  });

  it("reports remote mode as off in a fresh session snapshot", async () => {
    const response = await env.SESSION.getByName("remote-mode-default").fetch(new Request("https://session.internal/internal/snapshot"));
    const snapshot = await response.json<{ remoteMode: boolean; expiresAt: number | null }>();
    expect(snapshot.remoteMode).toBe(false);
    expect(snapshot.expiresAt).toBeNull();
  });
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npm test
```

预期：FAIL。协议测试报 `parseClientMessage` 对 `remote_mode` 返回 `null`；DO 测试报 `snapshot.remoteMode` 是 `undefined`。

- [ ] **Step 4: 改 `src/protocol.ts`**

`Snapshot` 改为：

```ts
export interface Snapshot {
  pending: PendingPermission[];
  recent: RecentMessage[];
  /** 远程模式是否开启。关闭时 expiresAt 为 null。 */
  remoteMode: boolean;
  expiresAt: number | null;
}
```

`ServerMessage` 改为（`snapshot` 变体改用交叉类型，保证与 `Snapshot` 同步）：

```ts
export type ServerMessage =
  | { type: "permission"; id: string; toolName: string; toolInput: unknown; suggestions: unknown[] }
  | { type: "idle"; lastMessage: string; createdAt: number }
  | ({ type: "snapshot" } & Snapshot)
  | { type: "remote_mode"; enabled: boolean; expiresAt: number | null }
  | { type: "interrupt_ack" }
  | { type: "error"; message: string };
```

`ClientMessage` 改为：

```ts
export type ClientMessage =
  | { type: "decision"; id: string; behavior: PermissionBehavior; always?: boolean }
  | { type: "message"; text: string }
  | { type: "remote_mode"; enabled: boolean }
  | { type: "interrupt" };
```

`parseClientMessage` 在 `message` 分支之后、`interrupt` 那一行之前插入：

```ts
  if (record.type === "remote_mode" && typeof record.enabled === "boolean") {
    return { type: "remote_mode", enabled: record.enabled };
  }
```

- [ ] **Step 5: 改 `src/session-do.ts`**

在 `maxRecentMessages()` 后面加两个私有方法与一个 TTL 读取：

```ts
  private remoteModeTtlMs(): number {
    const configured = Number(this.env.REMOTE_MODE_TTL_MS);
    return Number.isFinite(configured) && configured > 0
      ? Math.min(86_400_000, Math.max(100, Math.floor(configured)))
      : 28_800_000;
  }

  /** 惰性过期：只在读取时比较时间戳，不用 DO alarm。 */
  private readRemoteMode(): { enabled: boolean; expiresAt: number | null } {
    const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM session_state WHERE key = 'remote_mode'").toArray()[0];
    const enabledAt = Number(row?.value ?? "0");
    if (!Number.isFinite(enabledAt) || enabledAt <= 0) return { enabled: false, expiresAt: null };
    const expiresAt = enabledAt + this.remoteModeTtlMs();
    return Date.now() < expiresAt ? { enabled: true, expiresAt } : { enabled: false, expiresAt: null };
  }

  private writeRemoteMode(enabled: boolean): { enabled: boolean; expiresAt: number | null } {
    this.ctx.storage.sql.exec(
      "INSERT INTO session_state (key, value) VALUES ('remote_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      enabled ? String(Date.now()) : "0",
    );
    return this.readRemoteMode();
  }
```

`handleClientMessage` 在 `message` 分支之后、最后那行 `void this.setInterrupt()...` 之前插入：

```ts
    if (message.type === "remote_mode") {
      const state = this.writeRemoteMode(message.enabled);
      this.broadcast({ type: "remote_mode", enabled: state.enabled, expiresAt: state.expiresAt });
      return;
    }
```

`snapshot()` 改为：

```ts
  private async snapshot(): Promise<Snapshot> {
    const rows = this.ctx.storage.sql.exec<{ id: number; text: string; created_at: number }>("SELECT id, text, created_at FROM recent_messages ORDER BY id DESC LIMIT ?", this.maxRecentMessages()).toArray();
    const recent: RecentMessage[] = rows.reverse().map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }));
    const pending = [...this.pendingPermissions.values()].map((item) => item.payload);
    const remote = this.readRemoteMode();
    return { pending, recent, remoteMode: remote.enabled, expiresAt: remote.expiresAt };
  }
```

两处 `new Pending` 的 `remoteMode: false,` 换成真实状态。`waitForPermission` 开头加一行 `const remote = this.readRemoteMode();`，`waitForStop` 同样，然后 `remoteMode: remote.enabled,`。

- [ ] **Step 6: 运行测试确认通过**

```bash
npm run typecheck && npm test
```

预期：typecheck 退出码 0；测试 20 项全绿（原 8 + `Pending` 8 + 协议 1 + DO 3）。

- [ ] **Step 7: 提交**

```bash
git add src/protocol.ts src/session-do.ts test/protocol.test.ts test/session-do.test.ts
git commit -m "feat(session): add remote mode state with lazy ttl expiry

远程模式状态存 session_state 表，值为开启时刻的时间戳，0 表示关闭。
过期采用惰性判断，读取时比较是否超过 TTL，不引入 DO alarm。
协议新增双向的 remote_mode 消息，snapshot 携带 remoteMode 与 expiresAt。
挂起请求接入真实的远程模式状态，关闭时行为与第一阶段一致。
8 小时上限用于兜住忘记关闭的情况，隔夜自动恢复零感知行为。"
```

---

### Task 5: 手机控制台的远程模式开关

**Files:**
- Modify: `src/ui.ts`
- Create: `test/ui.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `remote_mode` 双向消息与 snapshot 两字段
- Produces: 无新的模块接口。产出是页面上 id 为 `remote-toggle` 的按钮。

- [ ] **Step 1: 写失败的测试**

创建 `test/ui.test.ts`：

```ts
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
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- test/ui.test.ts
```

预期：FAIL，第一项报找不到 `id="remote-toggle"`。

- [ ] **Step 3: 改 `src/ui.ts`**

在 `<style>` 段里 `.status.online::before` 那行后面追加一条样式：

```css
    #remote-toggle { min-height: 34px; padding: 6px 11px; font-size: 13px; white-space: nowrap; }
```

`<header>` 那一行整体替换为（把开关放进右上角，与连接状态并排）：

```html
    <header><div><h1>Claude Remote Control</h1><div class="session">会话 ${safeSessionId}</div></div><div><div id="status" class="status">未连接</div><div class="actions"><button id="remote-toggle" type="button">远程模式 关</button></div></div></header>
```

脚本里，在 `let pending = [];` 后面加状态与渲染函数：

```js
      let remoteMode = { enabled: false, expiresAt: null };
      const remoteToggle = document.getElementById('remote-toggle');
      function renderRemoteMode() {
        if (!remoteMode.enabled) { remoteToggle.textContent = '远程模式 关'; remoteToggle.classList.remove('primary'); return; }
        const minutes = Math.max(0, Math.round((remoteMode.expiresAt - Date.now()) / 60000));
        remoteToggle.textContent = '远程模式 开 · 剩余 ' + minutes + ' 分钟';
        remoteToggle.classList.add('primary');
      }
```

`render()` 函数末尾（`recent.forEach(...)` 那一行之后、函数收尾的 `}` 之前）加一行 `renderRemoteMode();`。

`socket.onmessage` 的处理链里，在 `data.type === 'snapshot'` 分支内把远程模式一并取出，并新增一个 `remote_mode` 分支。整行替换为：

```js
        socket.onmessage = (event) => { try { const data = JSON.parse(event.data); if (data.type === 'snapshot') { pending = data.pending || []; recent = data.recent || []; remoteMode = { enabled: data.remoteMode === true, expiresAt: data.expiresAt ?? null }; render(); } else if (data.type === 'permission') { pending = pending.concat([data]); render(); } else if (data.type === 'idle') { recent = recent.concat([{ text: data.lastMessage, createdAt: data.createdAt }]).slice(-50); render(); } else if (data.type === 'remote_mode') { remoteMode = { enabled: data.enabled === true, expiresAt: data.expiresAt ?? null }; renderRemoteMode(); } } catch (_) {} };
```

在 `interrupt` 按钮的监听器后面加开关的监听器与倒计时刷新：

```js
      remoteToggle.addEventListener('click', () => { if (!socket || socket.readyState !== WebSocket.OPEN) return; socket.send(JSON.stringify({ type: 'remote_mode', enabled: !remoteMode.enabled })); });
      setInterval(renderRemoteMode, 30000);
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run typecheck && npm test
```

预期：typecheck 退出码 0；测试 22 项全绿。

- [ ] **Step 5: 本地手工验证**

> **动手前先看一眼本地 `.dev.vars` 里的 `NTFY_TOPIC`。** `createNotifier` 只判断这个值是否为空，不判断它是不是占位符。若它还是 `.dev.vars.example` 里的 `replace-with-a-private-random-topic`，本地开启远程模式就会真的往这个人人可猜的公共 topic 推送。要么换成一个随机串，要么把这一行整个删掉（删掉后走 `NullNotifier`，不发任何请求）。

```bash
npm run dev -- --port 8788
```

浏览器打开 `http://127.0.0.1:8788/s/demo-session`，输入 `.dev.vars` 里的手机 token，然后逐条确认：

1. 右上角出现「远程模式 关」按钮
2. 点一下变成「远程模式 开 · 剩余 480 分钟」（本地 `wrangler dev` 用 `wrangler.jsonc` 的 8 小时默认值，不是测试注入的 300 ms）
3. 刷新页面后仍显示「开」并带剩余时间——证明状态存在 DO 里而不是页面里
4. 再点一下变回「关」

验证完 `Ctrl+C` 停掉 dev server。

- [ ] **Step 6: 提交**

```bash
git add src/ui.ts test/ui.test.ts
git commit -m "feat(ui): add remote mode toggle to the phone console

控制台右上角增加远程模式开关，显示当前状态与剩余有效分钟数。
状态来自 snapshot 与 remote_mode 广播，刷新页面后不丢失。
同时补上控制台渲染的最小冒烟测试，覆盖开关存在与会话 id 转义。"
```

---

### Task 6: 通知适配器

只做模块本身与纯单测，不接进 DO。接线在 Task 7。

推送内容的两个构造函数刻意做成纯函数并且**签名里根本收不到 `tool_input` 与回复文本**——这比在网络层断言「正文不含敏感内容」更强，因为它让违规无法被写出来。

**Files:**
- Create: `src/notifier.ts`
- Create: `test/notifier.test.ts`
- Modify: `src/env.d.ts`（`NTFY_TOPIC` 已存在，确认无需改动）

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface Notification { title: string; body: string; clickUrl: string }`
  - `interface Notifier { notify(n: Notification): Promise<void> }`
  - `class NtfyNotifier implements Notifier`，构造参数 `(topic: string, fetchImpl?: FetchLike)`
  - `class NullNotifier implements Notifier`
  - `function createNotifier(env: Env): Notifier`
  - `function permissionNotification(toolName: string, clickUrl: string): Notification`
  - `function stopNotification(clickUrl: string): Notification`
  - `function consoleUrl(origin: string, sessionId: string): string`

- [ ] **Step 1: 写失败的测试**

创建 `test/notifier.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  NtfyNotifier,
  NullNotifier,
  consoleUrl,
  createNotifier,
  permissionNotification,
  stopNotification,
} from "../src/notifier";

function recorder() {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, body: String(init.body) });
    return new Response("", { status: 200 });
  };
  return { calls, fetchImpl };
}

describe("NtfyNotifier", () => {
  it("publishes a JSON body carrying topic, title, message and click", async () => {
    const { calls, fetchImpl } = recorder();
    await new NtfyNotifier("secret-topic", fetchImpl).notify({
      title: "Claude 等待批准",
      body: "Bash",
      clickUrl: "https://worker.test/s/demo-session",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.sh/");
    expect(JSON.parse(calls[0].body)).toEqual({
      topic: "secret-topic",
      title: "Claude 等待批准",
      message: "Bash",
      click: "https://worker.test/s/demo-session",
      priority: 4,
    });
  });

  it("swallows fetch failures instead of blocking the caller", async () => {
    const failing = async (): Promise<Response> => { throw new Error("network down"); };
    await expect(new NtfyNotifier("secret-topic", failing).notify({ title: "t", body: "b", clickUrl: "https://worker.test/s/x" })).resolves.toBeUndefined();
  });

  it("does not throw on a non-2xx response", async () => {
    const rejected = async (): Promise<Response> => new Response("nope", { status: 500 });
    await expect(new NtfyNotifier("secret-topic", rejected).notify({ title: "t", body: "b", clickUrl: "https://worker.test/s/x" })).resolves.toBeUndefined();
  });
});

describe("createNotifier", () => {
  it("returns a NullNotifier that sends nothing when NTFY_TOPIC is absent", async () => {
    const notifier = createNotifier({} as Env);
    expect(notifier).toBeInstanceOf(NullNotifier);
    await expect(notifier.notify({ title: "t", body: "b", clickUrl: "https://worker.test/s/x" })).resolves.toBeUndefined();
  });

  it("returns an NtfyNotifier when NTFY_TOPIC is configured", () => {
    expect(createNotifier({ NTFY_TOPIC: "secret-topic" } as Env)).toBeInstanceOf(NtfyNotifier);
  });
});

describe("notification content", () => {
  it("carries only the tool name for a permission request", () => {
    expect(permissionNotification("Bash", "https://worker.test/s/demo")).toEqual({
      title: "Claude 等待批准",
      body: "Bash",
      clickUrl: "https://worker.test/s/demo",
    });
  });

  it("uses fixed copy for a stop request so no reply text leaks", () => {
    expect(stopNotification("https://worker.test/s/demo")).toEqual({
      title: "Claude 已完成，等待指令",
      body: "点开控制台发送下一条指令",
      clickUrl: "https://worker.test/s/demo",
    });
  });

  it("builds the console url from the inbound origin and encodes the session id", () => {
    expect(consoleUrl("https://worker.test", "demo-session")).toBe("https://worker.test/s/demo-session");
    expect(consoleUrl("https://worker.test", "a b")).toBe("https://worker.test/s/a%20b");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm test -- test/notifier.test.ts
```

预期：FAIL，报 `Failed to resolve import "../src/notifier"`。

- [ ] **Step 3: 写 `src/notifier.ts`**

```ts
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

/** ntfy 的 JSON publish 形式。不用 header 形式：标题与正文含中文，HTTP header 传非 ASCII 需要 RFC 2047 编码。 */
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
      // 推送失败必须退化为「收不到提醒」，绝不能影响挂起流程。
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

/**
 * 权限请求推送。签名只收 toolName，tool_input 原文没有进入这里的途径。
 */
export function permissionNotification(toolName: string, clickUrl: string): Notification {
  return { title: "Claude 等待批准", body: toolName, clickUrl };
}

/**
 * Stop 推送。正文是固定文案，Claude 的回复文本没有进入这里的途径。
 */
export function stopNotification(clickUrl: string): Notification {
  return { title: "Claude 已完成，等待指令", body: "点开控制台发送下一条指令", clickUrl };
}

/** origin 由 Worker 从入站请求取得后传入；DO 自己的 request.url 是内部地址，推导不出公网地址。 */
export function consoleUrl(origin: string, sessionId: string): string {
  return `${origin}/s/${encodeURIComponent(sessionId)}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run typecheck && npm test
```

预期：typecheck 退出码 0；测试 30 项全绿（22 + notifier 8）。**这一步不应有任何真实网络请求**——所有 `NtfyNotifier` 测试都注入了假的 fetch，`createNotifier` 测试走 `NullNotifier`。

- [ ] **Step 5: 提交**

```bash
git add src/notifier.ts test/notifier.test.ts
git commit -m "feat(notifier): add ntfy push adapter with null fallback

新增通知适配器。ntfy 采用 JSON publish 形式而非 header 形式，
因为标题与正文含中文，HTTP header 传非 ASCII 需要 RFC 2047 编码。
NTFY_TOPIC 未配置时返回 NullNotifier，不发任何请求。
推送内容由两个纯函数构造，签名上就收不到 tool_input 与回复原文，
从源头保证敏感内容不进推送。fetch 抛错与非 2xx 都只记日志不抛出。"
```

---

### Task 7: 把推送接进 DO，并让 Worker 传入公网 origin

DO 收到的 `request.url` 是内部地址 `https://session.internal`，推导不出公网地址。由 Worker 在转发时从入站请求取 `new URL(request.url).origin`，与 `sessionId` 一起写进 `/internal/permission` 和 `/internal/stop` 的请求体。

> 与 spec 第 4.2 节的一点差异：spec 只提到传 `origin`。这里额外传 `sessionId`，因为 Worker 本来就已经解析出了它，而 DO 侧靠 `ctx.id.name` 取会话名是一个无法在测试里可靠验证的运行时假设。多传一个字段换掉这个假设，是划算的。

推送在 DO 内挂起请求时发出（挂起时刻只有 DO 知道，从 Worker 发需要额外的回调路径，无收益），全程不阻塞挂起流程。**远程模式开启时一律推送**，不区分手机是否已连接——远程模式的语义就是「我不在电脑前」，且手机浏览器切后台后 WebSocket 常已断开，「已连接」并不等于「正在看」。

**Files:**
- Modify: `src/index.ts`（两处 `stub.fetch` 的 body 加 `origin` 与 `sessionId`）
- Modify: `src/session-do.ts`（构造 notifier、解析新字段、两处触发推送）
- Modify: `test/session-do.test.ts`（补 2 项）

**Interfaces:**
- Consumes: Task 6 的 `createNotifier` / `permissionNotification` / `stopNotification` / `consoleUrl`，Task 4 的 `readRemoteMode`
- Produces: `/internal/permission` 与 `/internal/stop` 的请求体新增两个可选字段 `origin: string` 与 `sessionId: string`

- [ ] **Step 1: 先尝试用 fetchMock 覆盖推送发出这一环**

推送本身缺自动化覆盖：DO 内部自己构造 notifier，测试环境未配 `NTFY_TOPIC` 就走 `NullNotifier`，断不到。先花一小步试试 `cloudflare:test` 的 `fetchMock` 能否拦截 **DO 内部发起**的出站请求。**这是一次有上限的尝试，不是必须成功的步骤。**

在 `vitest.config.ts` 的 `miniflare.bindings` 里临时加 `NTFY_TOPIC: "test-topic"`，然后新建 `test/notify-wiring.test.ts`：

```ts
import { env, fetchMock } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("push wiring", () => {
  it("publishes to ntfy when a permission request suspends in remote mode", async () => {
    const name = "push-wiring";
    const bodies: string[] = [];
    fetchMock.get("https://ntfy.sh").intercept({ path: "/", method: "POST", body: (raw) => { bodies.push(raw); return true; } }).reply(200, "");

    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/ws", { headers: { Upgrade: "websocket" } }));
    const socket = response.webSocket!;
    socket.accept();
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "Bash", toolInput: { command: "rm -rf /" }, permissionSuggestions: [], origin: "https://worker.test", sessionId: name }),
    }));

    expect(bodies).toHaveLength(1);
    const published = JSON.parse(bodies[0]);
    expect(published.title).toBe("Claude 等待批准");
    expect(published.message).toBe("Bash");
    expect(published.click).toBe("https://worker.test/s/push-wiring");
    // 最要紧的一条：tool_input 绝不能出现在推送里
    expect(bodies[0]).not.toContain("rm -rf");
  });
});
```

跑 `npm test -- test/notify-wiring.test.ts`。两种结果：

- **拦截成功**（断言通过或只差细节）→ 留下这个测试，它覆盖了推送发出、内容正确、`tool_input` 不泄漏三件事。把 `NTFY_TOPIC: "test-topic"` 正式留在 `vitest.config.ts`，并在 Step 5 的计数里加上这一项。
- **拦截不到 DO 内部发起的 fetch**（`bodies` 为空，或报 net connect 被禁而测试挂掉）→ **删掉这个测试文件，并撤销 `vitest.config.ts` 里的 `NTFY_TOPIC`**，改走下面的 Step 2 守护测试。不要在这上面反复试超过两次，也不要为它改生产代码留接缝。

无论哪种结果，都在实现报告里写清楚实际发生了什么。

- [ ] **Step 2: 写守护测试**

> **这两项是守护测试，不是红绿循环。** 它们在改代码前后都应该通过，作用是锁住「新增的请求体字段不会把请求打成 400」和「接线之后远程模式的 fail-open 语义没被破坏」这两条。推送内容的正确性由 Task 6 对纯函数 `permissionNotification` / `stopNotification` / `consoleUrl` 的单测保证，端到端闭环由 Task 9 Step 6 人工验证；Step 1 若成功则额外多一层自动化覆盖。

在 `test/session-do.test.ts` 追加：

```ts
  it("accepts the origin and session id forwarded by the worker", async () => {
    const stub = env.SESSION.getByName("origin-passthrough");
    const response = await stub.fetch(new Request("https://session.internal/internal/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lastMessage: "done", origin: "https://worker.test", sessionId: "origin-passthrough" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("still fails open when remote mode is on but no phone ever connects", async () => {
    const name = "remote-mode-fail-open";
    const socket = await connectPhone(name);
    socket.send(JSON.stringify({ type: "remote_mode", enabled: true }));
    await sleep(20);
    socket.close();
    await sleep(20);
    const started = Date.now();
    const response = await env.SESSION.getByName(name).fetch(new Request("https://session.internal/internal/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolName: "Bash", toolInput: { command: "pwd" }, permissionSuggestions: [], origin: "https://worker.test", sessionId: name }),
    }));
    // vitest.config.ts 注入 REMOTE_OFFLINE_TIMEOUT_MS = 40ms，所以这里等的是短窗口而不是立即返回
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(await response.json()).toEqual({ ok: false });
  });
```

第二项测试同时验证了三件事：远程模式开着时确实进入了挂起、走的是短窗口而不是总上限、短窗口到期后仍然 fail-open。

- [ ] **Step 3: 运行测试确认当前行为**

```bash
npm test -- test/session-do.test.ts
```

预期：两项都 PASS。若第二项失败，最可能的原因是 `socket.close()` 之后 DO 里仍留着 hibernated socket，导致 `getWebSockets().length` 没归零、走了「已连接」分支。把两处 `await sleep(20)` 加大到 100 ms 再看。

- [ ] **Step 4: 改 `src/index.ts` 传入 origin 与 sessionId**

`permissionHook` 里的 `stub.fetch` body 改为：

```ts
      body: JSON.stringify({
        toolName: parsed.payload.toolName,
        toolInput: parsed.payload.toolInput,
        permissionSuggestions: parsed.payload.permissionSuggestions,
        origin: new URL(request.url).origin,
        sessionId: parsed.sessionId,
      }),
```

`stopHook` 里的 body 改为：

```ts
      body: JSON.stringify({
        lastMessage: parsed.lastMessage,
        origin: new URL(request.url).origin,
        sessionId: parsed.sessionId,
      }),
```

- [ ] **Step 5: 改 `src/session-do.ts` 触发推送**

顶部加导入：

```ts
import { consoleUrl, createNotifier, permissionNotification, stopNotification, type Notifier } from "./notifier";
```

加字段并在构造函数里赋值（用构造参数 `env` 而不是 `this.env`，避免字段初始化时序问题）：

```ts
  private readonly notifier: Notifier;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.notifier = createNotifier(env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS recent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }
```

把 `readPayload` 替换为同时解析 clickUrl 的版本，并把 origin / sessionId 的解析抽成一个私有方法，避免在 `/internal/stop` 分支里重复同一段：

```ts
  private clickUrlFrom(record: Record<string, unknown>): string {
    return consoleUrl(
      typeof record.origin === "string" ? record.origin : "",
      typeof record.sessionId === "string" ? record.sessionId : "",
    );
  }

  private async readPermissionRequest(request: Request): Promise<{ payload: PermissionPayload; clickUrl: string } | null> {
    const body = await request.json<unknown>();
    const record = asRecord(body);
    if (!record || typeof record.toolName !== "string" || !Array.isArray(record.permissionSuggestions)) return null;
    return {
      payload: {
        toolName: record.toolName,
        toolInput: record.toolInput ?? null,
        permissionSuggestions: record.permissionSuggestions,
      },
      clickUrl: this.clickUrlFrom(record),
    };
  }
```

`fetch` 里的两个分支改为：

```ts
      if (request.method === "POST" && path === "/internal/permission") {
        const parsed = await this.readPermissionRequest(request);
        if (!parsed) return jsonResponse({ ok: false }, 400);
        const decision = await this.waitForPermission(parsed.payload, parsed.clickUrl);
        return decision ? jsonResponse(decision) : jsonResponse({ ok: false });
      }
      if (request.method === "POST" && path === "/internal/stop") {
        const body = await request.json<unknown>();
        const record = asRecord(body);
        if (!record || typeof record.lastMessage !== "string") return jsonResponse({ ok: false }, 400);
        const clickUrl = this.clickUrlFrom(record);
        await this.recordMessage(record.lastMessage);
        const text = await this.waitForStop(clickUrl);
        return text ? jsonResponse({ text }) : jsonResponse({ ok: false });
      }
```

`waitForPermission` 加参数并在挂起后推送：

```ts
  private async waitForPermission(payload: PermissionPayload, clickUrl: string): Promise<PermissionDecision | null> {
    const remote = this.readRemoteMode();
    const pending: PendingPermission = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...payload,
    };
    const request = new Pending<PermissionDecision>({
      timeouts: readTimeouts(this.env),
      remoteMode: remote.enabled,
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { this.pendingPermissions.delete(pending.id); },
    });
    if (!request.waiting) return null;
    this.pendingPermissions.set(pending.id, { payload: pending, request });
    this.broadcast({
      type: "permission",
      id: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
      suggestions: pending.permissionSuggestions,
    });
    // 远程模式开启时一律推送：手机切后台后 WebSocket 常已断开，「已连接」不等于「正在看」。
    if (remote.enabled) void this.notifier.notify(permissionNotification(pending.toolName, clickUrl));
    return request.promise;
  }
```

`waitForStop` 同样：

```ts
  private async waitForStop(clickUrl: string): Promise<string | null> {
    const remote = this.readRemoteMode();
    this.pendingStop?.settle(null);
    let stored = false;
    const request = new Pending<string>({
      timeouts: readTimeouts(this.env),
      remoteMode: remote.enabled,
      isConnected: () => this.ctx.getWebSockets().length > 0,
      onSettled: () => { if (stored) this.pendingStop = null; },
    });
    if (!request.waiting) return null;
    stored = true;
    this.pendingStop = request;
    if (remote.enabled) void this.notifier.notify(stopNotification(clickUrl));
    return request.promise;
  }
```

- [ ] **Step 6: 运行测试确认通过**

```bash
npm run typecheck && npm test
```

预期：typecheck 退出码 0；测试 32 项全绿（Step 1 的 fetchMock 尝试若成功则为 33 项）。

- [ ] **Step 7: 确认部署产物仍能构建**

```bash
npm run deploy:check
```

预期：退出码 0。

- [ ] **Step 8: 提交**

```bash
git add src/index.ts src/session-do.ts test/session-do.test.ts
git commit -m "feat(session): send ntfy push when a request suspends in remote mode

远程模式开启且请求进入挂起时发出推送。推送在 DO 内发出而非 Worker，
因为挂起时刻只有 DO 知道，从 Worker 发需要额外的回调路径。
DO 的 request.url 是内部地址，推导不出公网链接，改由 Worker 从入站
请求取 origin 并连同 sessionId 一起写进内部请求体。
推送全程不阻塞挂起流程，失败只记日志，退化为收不到提醒。"
```

---

### Task 8: 文档与正式部署

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-18-remote-claude-control-design.md`（顶部加一行指向第二阶段文档的修订说明）

`.dev.vars.example` 已经含 `NTFY_TOPIC`，无需改动。

**Interfaces:**
- Consumes: Task 1–7 的全部产出
- Produces: 一个可公网访问的 `https://<worker>.workers.dev`

- [ ] **Step 1: 部署前全量验证**

```bash
npm run types && npm run typecheck && npm test && npm run deploy:check
```

预期：四条命令全部退出码 0，测试 32 项全绿。任一失败就停下来修，不要带着红灯部署。

- [ ] **Step 2: 更新 `README.md`**

在「Claude Code hooks」小节与「Deploy」小节之间插入一节：

````markdown
## Remote mode

Remote mode is **off by default**, and while it is off the system behaves exactly as it did before: if no phone is connected, hook requests return immediately and you get the normal local prompt with zero added latency.

Turn it on from the toggle in the top-right of the phone console when you are away from the computer. While it is on:

- Every suspended permission request and every end-of-turn `Stop` sends an ntfy push.
- If no phone is connected, the request waits `REMOTE_OFFLINE_TIMEOUT_MS` (90 s by default) for one to connect. If one does, it waits up to the 590 s total; if not, it fails open.
- The mode expires on its own after `REMOTE_MODE_TTL_MS` (8 hours by default), so forgetting to switch it off costs you at most one night.

Pushes deliberately carry no `tool_input` and no reply text — only the tool name, or fixed copy for `Stop`. You have to open the token-protected console to see anything else.

### ntfy setup

Install the [ntfy](https://ntfy.sh/) app, subscribe to a topic that nobody else could guess, then:

```powershell
wrangler secret put NTFY_TOPIC
```

The topic name is itself a credential: anyone who knows it can read every notification you send. Never put it in `wrangler.jsonc`.

### Tunables

These live in `wrangler.jsonc` under `vars` and are all strings:

| Var | Default | Purpose |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | `590000` | Total suspension ceiling, inside the hook's 600 s limit |
| `REMOTE_OFFLINE_TIMEOUT_MS` | `90000` | How long a remote-mode request waits for a phone to connect |
| `REMOTE_MODE_TTL_MS` | `28800000` | How long remote mode stays on before expiring by itself |
````

把「Deploy」小节的命令块改为：

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

- [ ] **Step 3: 在第一阶段设计文档顶部加修订指引**

编辑 `docs/superpowers/specs/2026-08-18-remote-claude-control-design.md`，在标题行下面插入：

```markdown
> **修订：** 第 4.4、7、9、10.4、11 节的部分内容已被 [第二阶段设计](2026-08-18-remote-control-phase-2-design.md) 第 9 节修订，以后者为准。
```

- [ ] **Step 4: 提交文档**

```bash
git add README.md docs/superpowers/specs/2026-08-18-remote-claude-control-design.md
git commit -m "docs: document remote mode, ntfy setup and timeout tunables

README 补充远程模式的语义、分级超时与自动过期说明，以及 ntfy 配置步骤。
强调 NTFY_TOPIC 必须用 secret 配置，topic 名本身即凭据。
部署步骤补上 NTFY_TOPIC。第一阶段设计文档顶部加指向第二阶段文档的
修订说明，避免后续按已被推翻的前提理解。"
```

- [ ] **Step 5: 配置三个 secret**

```powershell
wrangler secret put COMPUTER_TOKEN
wrangler secret put PHONE_TOKEN
wrangler secret put NTFY_TOPIC
```

电脑 token 与手机 token 各生成一个足够长的随机值（**不要**复用 `.dev.vars` 里的本地测试值）：

```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

ntfy topic 同理，用随机串而不是可猜的词。这三个值都不要写进任何文件。

- [ ] **Step 6: 部署**

```bash
npm run deploy
```

预期：输出部署成功与 `https://claude-remote-control.<subdomain>.workers.dev` 地址。记下这个地址。

- [ ] **Step 7: 用手机移动网络实测可达性——这是整套机制的单点**

**必须关掉 Wi-Fi，用移动数据**，在手机浏览器打开 `https://<worker>.workers.dev/s/demo-session`。

预期：出现 token 输入页；输入 `PHONE_TOKEN` 后进入控制台，右上角显示「远程模式 关」。

打不开的话按成本排序处理，**不要跳过这一步继续 Task 9**：

1. 换用 Cloudflare 提供的其他免费入口
2. 注册一个域名接入 Cloudflare，绑自定义域（可达性最优，成本是年费）
3. 换推送渠道为企业微信——**这只解决收不到通知，解决不了页面打不开**，属治标

- [ ] **Step 8: 把部署地址记进本文件末尾的「部署记录」小节**

---

### Task 9: 真实会话接入与 R1b 端到端测量

这一步全部是人工验证，没有自动化测试可写。逐条走，任何一条不通就停下来定位。

**Files:**
- Modify: `~/.claude/settings.json`（用户全局配置，不在本仓库内）
- Modify: 本文件末尾的「基线记录」小节

**Interfaces:**
- Consumes: Task 8 部署出来的 Worker 地址
- Produces: 六条链路的验证结论与 R1b 实测数字

- [ ] **Step 1: 配置环境变量与 hooks**

在跑 Claude Code 的电脑会话里设置：

```powershell
$env:CLAUDE_REMOTE_CONTROL_URL = 'https://<worker>.workers.dev'
$env:CLAUDE_REMOTE_CONTROL_TOKEN = '<Task 8 里生成的 computer token>'
```

按 README 的 JSON 片段改 `~/.claude/settings.json`，把三处 `https://your-worker.example.workers.dev` 换成实际地址，`PostToolUse` 的 `command` 换成本仓库 `hooks/remote-interrupt.ps1` 的绝对路径。保留 `settings.json` 里已有的其他 hook。

- [ ] **Step 2: 验证链路 1——权限批准 / 拒绝 / 总是允许这类**

手机连上控制台，**先不开远程模式**。在电脑上让 Claude 执行一条需要批准的 Bash 命令。

预期：手机上出现权限卡片，显示工具名与 `tool_input`；分别验证三个按钮：

1. 「允许」→ 命令执行
2. 「拒绝」→ 命令不执行
3. 「总是允许这类」→ 命令执行，且同类命令后续不再询问

- [ ] **Step 3: 验证链路 2——Stop 指令注入与完整回复展示**

让 Claude 结束一个回合。

预期：手机「对话」区出现 Claude 的**完整**回复（不是截断的）；在输入框发一条指令，电脑端 Claude 接着这条指令继续。

- [ ] **Step 4: 验证链路 3——软中断**

让 Claude 跑一个会连续调用多次 Bash 的任务，中途在手机上点「停止当前任务」。

预期：**下一次 Bash 调用之后**生效（这是设计如此，不是即时中断）。

- [ ] **Step 5: 验证链路 4——断线重连后快照补齐**

手机上把页面切后台或关掉 Wi-Fi 十几秒，期间让电脑端产生一个权限请求与一条回复，再恢复。

预期：重连后待处理权限与最近回复都在，不需要手动刷新。

- [ ] **Step 6: 验证链路 5——远程模式完整闭环**

手机上打开远程模式，然后**离开电脑**（把手机页面切到后台，模拟真实场景）。在电脑上触发一个权限请求。

预期，按顺序：

1. 手机收到 ntfy 推送，标题「Claude 等待批准」，正文只有工具名
2. **推送里看不到 `tool_input`**——这一条要专门确认
3. 点击推送 → 浏览器打开控制台页面 → 权限卡片在那里
4. 点「允许」→ 电脑端命令执行

再让 Claude 结束一个回合，确认收到标题「Claude 已完成，等待指令」的推送，且**推送里看不到回复内容**。

- [ ] **Step 7: 验证链路 6——远程模式关闭时的零感知**

在手机上关掉远程模式，然后**关掉手机页面**（确保没有 WebSocket 连接）。在电脑上触发一个权限请求。

预期：电脑端**立刻**弹出本地权限对话框，与没装这套系统时一致，没有可感知的延迟。这是整个远程模式设计要守住的底线。

- [ ] **Step 8: R1b 端到端测量**

首选用 debug 模式读 hook 执行耗时：

```powershell
claude --debug
```

跑一个多回合任务，在输出里找 `Stop` hook 的执行耗时。

若 debug 输出不含耗时，退化为 A/B 对比：同一提示词分别在「装 hook」与「不装 hook」下各跑 3 轮，比较回合结束到下一次可输入的间隔。

判定线：单次往返 300 ms。超标的退路按成本排序：

1. 为 Claude Code 进程设 `NO_PROXY=<worker 域名>`
2. 改用 command hook 加 `curl --noproxy '*'`
3. 给 `Stop` hook 加哨兵文件开关，按需启用远程

- [ ] **Step 9: 把结论写进本文件末尾的两个记录小节并提交**

```bash
git add docs/superpowers/plans/2026-08-18-remote-control-phase-2.md
git commit -m "docs(plan): record deployment and end-to-end baseline results

记录 Task 8 的部署地址与手机移动网络可达性结论，以及 Task 9 的六条
链路验证结果与 R1b 端到端往返耗时实测数字。"
```

---

## 基线记录

> Task 1 与 Task 9 Step 9 填写。

**R1a 网络层（Task 1）**

| 环境 | 成功数 | 失败数 | p50 (ms) | p95 (ms) | 达标 |
|---|---|---|---|---|---|
| direct | 20 | 0 | 307.3 | 358.8 | 否 |
| proxy `http://127.0.0.1:7890` | 20 | 0 | 412.8 | 949.2 | 否 |

测量日期：2026-08-18

环境：`pwsh 7.6.5`（支持 `Invoke-WebRequest -NoProxy`，未走降级路径）。
代理确实在运行（20/20 成功），环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 均为 `http://127.0.0.1:7890`。
Cloudflare 边缘 `colo=HKG`、`loc=CN`，出口为 IPv6。

复测一次（同脚本、同参数）结果一致，非偶发抖动：
direct p50 306.7 / p95 384.9；proxy p50 410.4 / p95 819.4，失败数均为 0。

**两组 p95 均 ≥ 300 ms 判定线，按 Task 1 Step 3 情况 3 处理，待用户决定后再进入 Task 2。**

补充诊断（不改变上表记录值，仅供判读）：脚本每个样本都由独立的 `Invoke-WebRequest`
调用发出，不复用连接，因此约 300 ms 中的大部分是 TCP + TLS 握手开销，而非链路 RTT。
同一 `HttpClient` 连续请求实测：首次 334.6 ms，其后稳定在 95～108 ms；
裸 TCP 连接耗时 79～103 ms，即到 HKG 边缘的单程链路 RTT 约 100 ms。
代理链路则在此基础上再叠加 ~100 ms p50 与显著更长的尾延迟（p95 819～949 ms）。
结论：判定是否真正超标，取决于 hook 实际是否复用连接，需由 Task 9 的 R1b 端到端实测确认。

**R1b 端到端（Task 9）**

- 测量方式（`claude --debug` 或 A/B 对比）：待填
- `Stop` hook 单次往返耗时：待填
- 是否走代理：待填
- 结论：待填

## 部署记录

> Task 8 Step 8 填写。

- Worker 地址：`https://claude-remote-control.2519175810.workers.dev`
- 手机移动网络可达性：待用移动数据实测
- 部署日期：2026-08-18
