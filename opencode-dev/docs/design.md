# opentride × Tripilot（Webview）整合设计文档

> 状态：2026-01 起进入“opencode 全量化”迁移。
> - Opentride 目标：以 opencode 源码为主干（全功能、可持续升级）。
> - Tripilot 目标：替换 opencode 的 `sdks/vscode` UI，提供更强、更美观的 Webview 体验。
> - 连接方式：扩展侧内置最小 bridge（opencode server API/SSE → Tripilot Webview 消息协议），不把 token 明文暴露给 UI。

验收文档（每完成一个 phase 必须跑一次）：
- [Phase 1](acceptance/phase-1.md)
- [Phase 2](acceptance/phase-2.md)
- [Phase 3](acceptance/phase-3.md)

本文件是“设计定案 + 实施契约”，覆盖：
- 目标/非目标
- 边界与职责（Tripilot UI vs opentride runtime）
- 进程模型（本机子进程）
- 登录与 token 落盘（脱离 VS Code/GitHub 体系）
- 工具/终端执行流（工具由 opentride 执行，Tripilot 只展示与回写 permission）
- 传输协议：先 HTTP+SSE 跑通，平滑过渡到 stdio JSON-RPC
- packages/protocol：JSON Schema（draft-07）字段级契约（严格区分 request/response/event）
- 仓库结构与迁移策略（包括 VSCodium 目标）
- 实施步骤与里程碑

---

## 1. 背景

现状：Tripilot 是一个 VS Code 扩展 + Webview Chat UI，内部已经具备：
- UI ↔ extension 的消息协议与工具调用 UI（例如 tool begin/end、edit approval/review 等）：[src/extension.ts](../../src/extension.ts)、[media/main.js](../../media/main.js)
- MCP client（多 transport）：[src/mcpClient.ts](../../src/mcpClient.ts)

范围与目录约束（避免搞乱）：
- **UI 对齐目标**：仅对齐 Opentride 的 VS Code 插件（目录：`Opentride/sdks/vscode`）与 VS Code GitHub Copilot Chat 的 UI/交互表现。
- **不要误改**：工作区顶层的 `Tripilot/` 目录可能包含另一份 UI 实验代码/历史代码，它不是本阶段“对齐 Copilot UI”的交付载体。
- **下层依赖**：本阶段下层 runtime 仍以 opencode/opentride 为主（事件、diff、tool 状态等），UI 只做展示与回写审批，不重做 agent loop。

opentride 的定位：从 opencode 架构 fork 并保持可持续同步上游；提供 agent runtime（多模型、MCP、权限、工具执行、认证与凭据管理）。

本工程要达成：
- Tripilot 只负责 UI/交互，不再承担 agent runtime 或工具执行。
- opentride 作为本机子进程执行所有工具与终端控制，Tripilot 仅消费输出并提供审批 UI。
- VSCodium 目标：主路径完全走 opentride/opencode 的模型与工具能力，不依赖 vscode.lm / Copilot 内部存储；是否接入 `vscode.authentication` 仅用于“账号 UI”，可选。

---

## 2. 目标与非目标

### 2.1 目标

1) 保留 Tripilot Webview UI（不迁移 VS Code 原生 Chat UI）。

2) 架构分层：
- UI 层（Tripilot）负责：
  - Chat 展示与交互
  - 状态条、工具执行展示、终端输出展示
  - permission 请求的 UI 呈现与用户决策回写
- Runtime 层（opentride）负责：
  - agentic loop
  - 工具执行（文件与终端，后续扩展）
  - 权限策略与审计
  - 登录、多 provider、多模型
  - MCP 管理与工具注入

3) 传输：
- 先跑通 HTTP + SSE
- 设计必须可平滑迁移到 stdio JSON-RPC

4) 凭据落盘：
- 模型供应商凭据（OpenAI 等）由 opencode/opentride 负责落盘与刷新，Tripilot 只查询状态
- 我们自建用户体系的会话/令牌由 Auth Server + opentride 负责管理，VS Code Accounts UI 仅作为入口

5) 第一阶段只打通两类工具：
- fs.* 文件工具
- terminal.* 终端工具

### 2.2 非目标（阶段 1）

- 不迁移/复用 vscode-copilot-chat 的原生 UI。
- Tripilot 扩展内不实现 MCP/OAuth/权限引擎（这些都在 opentride）。
- 不要求一次性迁移 Tripilot 当前所有 provider/模型实现；阶段 1 只要 UI 能接上 opentride。

---

## 3. 仓库结构（定案）

opentride 是新仓根目录（当前工作区先在 opentride/ 下搭建骨架）。

```
opentride/
  packages/
    protocol/              # JSON Schema 唯一契约源（draft-07）
    glue/                  # 传输与协议映射（HTTP+SSE ↔ JSON-RPC 可替换）
    runtime/               # 本机子进程：agent runtime + tools + auth/token + mcp
  sdks/
    vscode/                # Tripilot VS Code 扩展（webview UI），后续把现有 Tripilot 代码迁入
  reference/               # 上游快照/资料（不进 git）
  docs/
    design.md              # 本文
```

关键约束：
- reference/ 必须被 .gitignore 忽略。
- 迁移后 Tripilot UI 归位到 Opentride/sdks/vscode（opencode 扩展目录）。迁移前 Tripilot 仍可能存在于工作区顶层作为开发源。

---

## 4. 进程模型（本机子进程）

### 4.1 启动方式

Tripilot 扩展（sdks/vscode）在用户打开 UI 或执行命令时：
1) 以子进程启动 opentride（CLI），传入随机端口或使用本地 socket。
2) 通过 hello 握手协商协议版本与能力。
3) 建立事件流订阅：HTTP SSE（阶段 1）。

与 opencode 现有 VS Code 扩展的基线一致：通过本机端口启动并用 HTTP 控制面。
参考上游扩展：
- [reference/opencode-dev/sdks/vscode/src/extension.ts](../../reference/opencode-dev/sdks/vscode/src/extension.ts)

### 4.2 退出与恢复

opentride 子进程生命周期由扩展管理：
- UI 打开时确保运行；UI 关闭可选择保持或回收
- 崩溃/断线：扩展重启子进程并恢复 session（依赖 sessionId 与本地持久化）

---

## 5. 登录与凭据（两套体系并存、不冲突）

### 5.1 两套“登录/认证”分别解决什么问题

我们需要同时满足两类需求，它们是**两个用户体系**，不应混在一起：

1) **应用账号（我们自建 Auth Server + 用户系统）**
 目的：把 VSCodium/VS Code 当成“我们的用户软件”，管理我们自己的用户（例如用户名 test / 密码 test）。
 UI：用户通过 VS Code 左下角 Accounts/头像菜单完成登录/登出（与截图所示体验一致）。
 技术：实现一个自定义 Authentication Provider（id=`tristaciss`，显示名 Tristaciss），让 Accounts 菜单展示“Sign in”。
- 说明：该账号用于我们自己的“应用级能力”（例如偏好设置、配额、团队空间、云端能力等），不等同于任何模型供应商账号。

- 目的：让用户使用自己在 OpenAI/Anthropic/… 的账号或 API key（通常是 token/key），以便使用“用户自己的订阅/额度”。
- 入口：CLI 通过 `opencode auth login` 选择 provider 并完成登录/授权。
- 共享：只要本机完成了 `opencode auth login`，Tripilot 在 VS Code 中就应当可用（读取同一份 opencode/opentride 凭据状态）。
- 说明：这套凭据**不需要**出现在 VS Code Accounts 菜单里（也不应该当作“应用账号”来管理）。

结论：
- VS Code Accounts 登录 ≠ opencode provider 登录。
- 两者不冲突：可以只做 provider 登录就让 Tripilot 可用；也可以同时登录应用账号以启用更多“我们自己的产品能力”。

### 5.2 应用账号登录入口（Accounts UI，推荐）

扩展在 VS Code Accounts 菜单提供入口（自定义 Provider）：
- OpenTride: Sign in
- OpenTride: Sign out

实现方式建议（与自建 Auth Server 对接）：
- 优先：OIDC Authorization Code + PKCE（系统浏览器 + 回调）
- 备选：Device Code（无回调环境）

注意：这里的 OIDC 是“我们自己的应用账号”的 OIDC，不是 OpenAI 等 provider 的 OIDC。

### 5.3 模型供应商登录入口（CLI，必须支持）

opencode 侧：
- `opencode auth login`：选择 provider 并完成授权/配置。
- `opencode auth status`：查看当前 provider 凭据。

Tripilot 侧：
- 不把 provider 登录塞进 VS Code Accounts 菜单。
- 只需要通过 opentride/runtime 查询 provider 凭据状态；发现已登录即可开始模型调用。

### 5.4 凭据落盘与共享

应用账号（我们自建用户体系）的会话/令牌：
- 由 opentride/runtime 存储在用户目录（不进仓），扩展只查询状态，不读取明文。

模型供应商凭据（opencode auth login 的结果）：
- 存储位置遵循 opencode 的约定（由 opencode 实现决定）。
- Tripilot 通过 opentride/runtime 读取“是否已登录/有哪些 provider”，从而做到“CLI 登录一次，VS Code 直接可用”。

---

## 6. 工具与终端：执行流（工具由 opentride 执行）

核心决策：
- 文件与终端控制不在 Tripilot 重写。
- opentride 作为执行者拥有：读写文件、打 patch、启动 shell、捕获输出、终端会话管理。
- Tripilot 仅做：
  - 显示工具 begin/end
  - 展示 stdout/stderr
  - 处理 permission.request 并回写 permission.reply

### 6.1 文件工具（阶段 1）

工具名固定：
- fs.readFile
- fs.writeFile
- fs.applyPatch
- fs.list
- fs.rename
- fs.delete

原则：
- 默认 pathBase="workspaceRelative"，避免 OS 差异。
- opentride 执行所有文件操作前，若策略需要，必须发 permission.request。

### 6.2 终端工具（阶段 1）

工具名固定：
- terminal.run
- terminal.attach
- terminal.stdin
- terminal.kill

输出流通过事件 terminal.event 推给 UI。

---

## 7. 传输协议：HTTP+SSE → stdio JSON-RPC

### 7.1 设计原则

- packages/protocol 的 Envelope + payload schema 是唯一事实来源。
- HTTP+SSE 与 JSON-RPC 只负责“外壳映射”：id/requestId/streamId/kind/type。
- payload 不因 transport 改动。

### 7.1.1 ACP（Agent Client Protocol，强烈推荐）

定案：**Opentride VS Code 插件的长期主路径应实现 ACP client**，让 opencode/opentride 作为“标准 IDE agent 后端”通过 ACP 提供：
- session 生命周期（new/load/fork/resume/list）
- 流式 message chunk（text/reasoning）
- tool call 状态（pending/running/completed/error）与 diff 回放
- 权限请求（permission.asked）并支持 once/always/reject 的队列化决策

原因：这些能力在 opencode 的 ACP 实现里已经比较完整，VS Code 扩展前端只要对接 ACP，就更容易获得接近 Copilot Chat 的 UI 体验（工具卡片、diff、权限按钮、reasoning/thinking 语义）。

仓库现状（证据）：
- opencode 已提供 ACP server 命令：`opencode acp`，入口见 `packages/opencode/src/cli/cmd/acp.ts`。
- opencode ACP 文档见：`packages/web/src/content/docs/acp.mdx`。

对 VS Code 扩展的要求（实现策略）：
- `sdks/vscode` 新增一个 ACP transport：以子进程方式启动 `opencode acp`，用 stdio 跑 JSON-RPC（NDJSON stream）。
- 保留现有 webview UI 协议（`chatSetStatus`/`chatToolInvocation*`/`editReview*`），把 ACP 的事件/响应映射为这些 UI 消息。
- HTTP+SSE 作为阶段 1 的过渡/回退路径（便于调试与兼容），但 UI 语义应以 ACP 能力为对齐基准。

ACP → Tripilot Webview 的映射建议（概念级，不绑定具体字段名）：
- message chunk:
  - text → `chatAssistantDelta`
  - reasoning →（未来）thinking box / `chatProgress`（短句）或单独 `chatReasoningDelta`
- tool call:
  - pending/running → `chatToolInvocationBegin`（并 `chatSetStatus(thinking)`）
  - completed/error → `chatToolInvocationEnd`
- diff:
  - diff 事件/回放 → `editReviewRequest` + `editPreviewData`（Files changed）
- permissions:
  - permission.asked → webview 内审批卡片（once/always/reject），并在聊天记录里可回看

迁移里程碑（推荐顺序）：
1) `sdks/vscode` 先实现 ACP client 的“只读链路”：能连上、能流式显示 text/tool 状态。
2) 再接入 diff 回放（Files changed bar + preview/openDiff/openAllDiffs）。
3) 最后把 permission 队列/URL approval 全迁移到 webview（不再弹 VS Code modal）。

### 7.2 HTTP+SSE 形态（阶段 1）

建议：
- POST /rpc：发送 request（Envelope.kind=request）
- GET /events：SSE 推送 event/notification（Envelope.kind=event/notification）

SSE 约束：
- 每条 SSE data 是完整 Envelope JSON。
- 断线续传使用 id 或 seq 去重。

### 7.3 stdio JSON-RPC 形态（后续）

映射规则：
- JSON-RPC request.method ↔ Envelope.type（kind=request）
- JSON-RPC response.id ↔ Envelope.requestId（kind=response）
- JSON-RPC response 原生没有 method，所以 response 的 Envelope.type 必须由服务端从原 request 回填。
- JSON-RPC notification.method ↔ Envelope.type（kind=event/notification）

---

## 8. packages/protocol：JSON Schema 契约（字段级）

### 8.1 全局硬约束

- ToolCall.status 固定：pending | running | completed | error | canceled
- 工具命名空间固定：fs.* / terminal.*
- 严格区分：request/response/event（通过 kind const）
- type 判别：通过 type const
- response 成功/失败严格二选一：payload.result 或 payload.error

### 8.2 Schema 文件树（v1）

见目录：packages/protocol/schemas/v1/。

文件清单：
- defs.json、envelope.json、index.json
- requests：hello、session.create/get/close、run.start/cancel、permission.reply
- responses：同名 type 且 kind=response
- events：session.updated、run.started、chat.delta/completed、tool.state、permission.request/resolved、terminal.event、run.completed/failed/cancelled

### 8.3 错误策略

- response：失败用 payload.error（推荐）
- event：失败用专门事件（run.failed 或 tool.state(status=error)），并在 payload 内携带 Error
- Envelope 顶层 error 仅保留给“无法形成正常 response”的极端情况

---

## 9. VSCodium 目标与约束

主路径必须不依赖 VS Code 专有或微软/GitHub 体系：
- 不依赖 vscode.lm
- 不依赖 vscode.authentication
- 不读取 VS Code 内部数据库/缓存作为关键路径

Tripilot 在 VSCodium 中：
- UI 能用（webview）
- 通过子进程与 opentride 通信
- 登录走 opentride（支持 copilot/openai 等 provider，自身完成 OAuth/device flow 并落盘）

---

## 10. 实施步骤（Start implementation 从这里开始）

### 阶段 1：协议与最小链路（目标：能对话 + 能看到工具/终端输出）

1) packages/protocol：落地 JSON Schema v1（本仓已开始实现）。
2) packages/runtime：提供 /rpc + /events SSE 最小服务：
   - requests：hello/session/run/permission
   - events：chat.delta/chat.completed/tool.state/terminal.event
3) sdks/vscode：子进程管理 + SSE 订阅 + 映射到 Tripilot UI 消息。

### 阶段 2：文件工具闭环

- runtime 执行 fs.* 并在需要时发 permission.request
- UI 展示并回写 permission.reply

### 阶段 3：终端工具闭环

- terminal.run 输出通过 terminal.event 推送
- UI 展示 stdout/stderr 与 exit code

---

## 11. 里程碑与验收

M1：UI 能与 runtime 对话（hello + run.start + chat.delta/chat.completed）。
M2：fs.readFile/fs.writeFile/fs.applyPatch 成功执行且有 permission UI。
M3：terminal.run 能看到实时 stdout/stderr，退出码正确。

---

## 12. 附：Tripilot 现有 UI 协议映射要点

Tripilot Webview 当前支持：
- chatAssistantStart/Delta/End
- chatToolInvocationBegin/End
- chatSetStatus
- editApprovalRequest/editReviewRequest 等

这些消息定义在 [src/extension.ts](../../src/extension.ts) 顶部类型中，运行态 UI 在 [media/main.js](../../media/main.js)。

阶段 1 仅需把：
- chat.delta → chatAssistantDelta
- tool.state → chatToolInvocationBegin/End（按 status 推进）
- terminal.event → UI 输出展示区（先实现简单日志块即可）
- permission.request → 弹出确认 modal，并通过 permission.reply 回写

### 12.1 复刻 Copilot Chat 的“进度/状态提示”语义（定案）

目标：Tripilot（webview）在一次请求的生命周期里，呈现与 VS Code GitHub Copilot Chat 一致的“用户可感知进度”，包括：
- 顶部/底部的短状态（如 Working/Thinking）
- inline 的进度行（例如工具运行、重试、读取文件、生成 edits）
- 工具调用摘要（默认折叠，可展开查看 input/output 摘要）
- edits/files changed 的 review bar（预览/保留/撤销）

官方参考（语义来源，UI 细节以 Copilot Chat 为准）：
- Use tools in chat: https://code.visualstudio.com/docs/editor/artificial-intelligence#_use-tools-in-chat
- Review AI-generated code edits: https://code.visualstudio.com/docs/editor/artificial-intelligence#_review-ai-generated-code-edits
- Manage context for AI: https://code.visualstudio.com/docs/editor/artificial-intelligence#_manage-context-for-ai
- Planning in chat: https://code.visualstudio.com/docs/editor/artificial-intelligence#_planning-in-chat

### 12.2 状态机（Status Badge）

UI 状态（Tripilot Webview）：
- idle：无请求进行中
- working：用户刚发出请求/刚进入 run.start（还没有任何“推理/工具/输出”的可见信号）
- thinking：正在推理或等待下一步（可能夹杂 tool 调用、retry 等）
- running-tools：正在运行工具（可选；若 UI 已有 tool 行，也可统一用 thinking）
- error：本次请求失败并结束

触发建议：
- 用户点击发送：立即进入 working（让 UI “有反应”）
- 一旦出现任一进度信号（assistant delta / tool running / progress 行 / retry）：切到 thinking
- session.idle 或 chat.completed：回到 idle
- session.error：进入 error（并收尾 streaming）

扩展 → webview 消息：
- `chatSetStatus({ status, detail })`

当前实现对齐：
- 扩展侧已实现并使用 `chatSetStatus`（idle/working/thinking/running-tools/error），并在用户发送时先置为 working。

#### 12.2.1 Stop generating（停止生成，定案）

目标：对齐 Copilot Chat 的“停止”按钮语义。

契约：
- webview → extension：`{ type: "cancel" }`
- extension 行为（best-effort）：
  - 立即 abort 当前 transport（HTTP+SSE：断开/取消请求；ACP：取消当前 prompt/工具流）
  - 发送 `chatAssistantEnd` 收尾当前流式输出（即使当前 assistant 文本不完整）
  - 发送 `chatSetStatus({ status: "idle" })`

约束（定案）：
- 停止生成不会生成新的 checkpoint。
- 若 stop 发生在 tool 运行中：UI 以工具行/进度行为准，允许存在“已开始但未完成”的历史记录；后续 turn 不应复用该 turn 的 redo/checkpoint token。

### 12.3 进度行（Progress Line）

Copilot Chat 的“进度提示”更像是：一次请求里不断追加的短句行（可完成/可失败），并且完成后仍保留在聊天记录里，形成“执行轨迹”。

Tripilot 的契约：
- `chatProgress({ text, status })`：追加一行进度记录
  - status：running | done | error
  - text：短句，不要长段落（长输出放 tool output 或普通 assistant 文本）

可映射的 runtime 事件：
- run.started / session.status(busy) → thinking
- session.status(retry) → `chatProgress("Retry #N …")`
- tool.state(status=running/completed/error) → 可同时发 `chatProgress` 或仅靠 tool 行
- terminal.event（长输出）→ 只在需要时生成“已运行命令/已产生输出”的简短进度行，具体输出放专用区域

当前实现对齐：
- `session.status(type=retry)` 已映射到 `chatProgress`。
- 其它“read files / analyze / summarize history”等细粒度 progress：当前尚无稳定来源，需 runtime 侧补充事件或在 bridge 层按工具名生成。

#### 12.3.1 Thinking Transcript（执行轨迹 / 思考细节）

目标：在 Copilot-like 的 busy 状态（Thinking/Running tools）期间，把 agent 的“过程性输出”以时间线形式持续追加展示，并在最终 assistant message 到来后依然可回看。

官方语义参考（仅能证明“会展示工具/搜索过程”，但官方并未公开 icon 逐一对应的图例）：
- Agent mode：强调“every tool invocation is transparently displayed in the UI”
  - https://code.visualstudio.com/blogs/2025/02/24/ introducing-copilot-agent-mode
- Copilot Edits agent mode UX：明确搜索结果是“Expand the message to see the results of which searches were done.”
  - https://github.blog/changelog/2025-03-06-github-copilot-updates-in-visual-studio-code-february-release-v0-25-including-improvements-to-agent-mode-and-next-exit-suggestions-ga-of-custom-instructions-and-more/

结论（定案）：
- 我们把 thinking transcript 视为“过程轨迹（trace）”的 UI 容器：包含 tool 调用、搜索/读取、终端运行、fetch 等短句。
- 由于官方未提供 icon legend，本项目采用“可解释的推断映射”，以便在 UI 上稳定区分常见 step 类型；后续若拿到更权威的 UI 证据（例如官方录屏逐帧），再把映射升级为“确定”。

UI 形态（对齐截图：竖线 + 气泡图标 + 多条 item）：
- transcript 是一个列表（timeline），每条 item 左侧是“气泡图标”，右侧是气泡文本。
- transcript 列表本身不提供“整段折叠/展开”（避免用户错过追加内容），但允许 **busy 状态条（Working/Thinking）** 作为一个稳定条目，在气泡内部提供折叠的“阶段明细”。
- 新追加 item **自动滚动**到可见区域（优先滚动 transcript 内部滚动容器；必要时联动 messages 容器）。

Working/Thinking（Busy Status）折叠阶段明细（对齐 Copilot 行为，定案）：
- 在一次 turn 的 busy 周期内，trace 中存在一个稳定条目（invocationId 固定，例如 `turn:status`），summary 行展示 `Working…` / `Thinking…` / `Running tools…`。
- summary 行可展开，展开后展示“阶段短句列表”（按时间追加，保留最近 N 条，建议 N=12）。
- 阶段短句是 best-effort：官方文档没有公开“阶段词汇列表”，因此我们以 UI 观测 + bridge/runtime 的 `chatSetStatus.detail` / progress 短句为来源。

阶段短句的常见词形（示例，允许随版本变化）：
- thinking / considering / evaluating / preparing / analyzing / loading / reasoning / processing / running / executing

Step 类型 → 图标映射（推断，按文本/工具名规则归类）：

| Step 类型 | 典型文本（示例/匹配规则） | 图标（本项目） |
|---|---|---|
| `search` | `Searching…` / `Searched…` / `Search:` / `grep/file_search/semantic_search` | 🔎（search） |
| `read` | `读取 …` / `Reading …` / `Read …` / `read_file` | 👁️（eye） |
| `fetch` | `Fetching …` / `Fetched …` / `fetch_webpage` | 🔗（link） |
| `run` | `Running …` / `Ran …` / `run_in_terminal` / `run_task` | `>_`（terminal） |
| `edit` | `Applying …` / `Patched …` / `apply_patch` / `write_file` | ✎（edit） |
| `other` | 其它无法归类的短句 | 💬（comment/tool） |

实现约束：
- runtime/bridge 侧短期仍可只发 `chatThinkingDelta`（纯文本增量）。webview 侧用上述规则推断类型并选图标。
- 中长期建议升级协议：把 transcript item 结构化（`{ type, title, detail }`），避免纯文本推断带来的不确定性。

### 12.4 工具调用摘要（Tool Invocation Summary）

原则：
- 默认折叠，只显示“调用了什么工具 + 用时 + 成功/失败”。
- 展开后显示 inputPreview（结构化 JSON 的缩略）与 output（可截断）。

Tripilot 契约：
- `chatToolInvocationBegin({ invocationId, toolName, inputPreview })`
- `chatToolInvocationEnd({ invocationId, ok, durationMs, outputPreview, outputFull, toolName })`

当前实现对齐：
- 扩展侧基于 `message.part.updated(partType=tool)` 实现 begin/end，并对 input 做了 JSON preview。
- question.asked（需要用户回答）已迁移为 webview 内联卡片：扩展侧发 `questionRequest`，webview 回传 `questionAction`。
- Tripilot（2026-02 增量）：ACP question 已形成端到端闭环（runtime 请求 → webview 表单 → extension 回写 runtime），并支持超时/取消。
- `chatProgress` 已用于 permission/question 的等待态与结果态；webview 侧改为“可折叠进度组 + 按 id 原位更新”，避免重复刷屏。
- progress 文案已本地化（中文）：如“等待审批/等待输入/审批已通过/输入已收到”等。

### 12.5 Edits / Files Changed（Review Bar + Diff Modal）

Copilot Chat 的 edits 语义：
- 一次请求可能产生多个文件变更
- UI 给出一个“Files changed”汇总条（可展开列表）
- 支持：Preview（查看差异）、Keep（保留并收起 UI）、Undo（撤销本次 edits）

Copilot（VS Code 官方文档）对“编辑器内审阅”的补充语义（需要对齐）：
- Pending changes：AI 产生的 edits 会直接写入并落盘；VS Code 会记住哪些文件仍处于“待审阅”状态（重启后也会恢复）。
- 可见指示：待审阅文件在 Explorer 与 editor tab 上会有“squared-dot”指示。
- 文件级 overlay controls：打开被修改的文件后，编辑器展示 inline diff，并在编辑器右下角（overlay）提供文件级控制：
  - ↑ / ↓ 在“建议的 edits（变更块）”之间导航
  - Keep / Undo 用于接受/拒绝“该文件”的所有待审阅 edits
  - 显示位置计数（例如 $x/y$，表示当前位于第 x 处变更 / 共 y 处变更）
- 块级（单处变更）controls：当 hover 到某一处 inline change 时，会出现块级控件，用于接受/拒绝“单处变更”（不等同于文件级 Keep/Undo）。
- Chat 侧全局操作：在 Chat view 的 files changed 列表里可一次性 Keep/Undo 所有文件。
- Auto-accept：支持 `chat.editing.autoAccept` 延迟自动接受（hover 文件级 overlay 可取消倒计时）。

Tripilot 契约（阶段 1 走 session.diff）：
- `editReviewRequest({ requestId, summary, files, diffStats, canPreview })`
- `editPreviewData({ requestId, diffs:[{file, additions, deletions, before, after}] })`
- `editReviewClear({ requestId })`
- `editReviewAction({ requestId, action: preview|keep|undo })`（webview → extension）

Tripilot（扩展侧）编辑器内审阅 UI 对齐目标（阶段 1）：
- 需要实现并区分两层 UI：
  - 文件级 overlay：导航（↑/↓）+ 计数（x/y）+ Keep/Undo（文件）
  - 块级控件：在单处变更附近出现，用于 Keep/Undo（单处变更）
- 约束：由于 VS Code stable API 对“真正悬浮且不占行号的控件”支持有限，允许使用 inset/decoration 做近似，但必须保留上述交互语义与层级区分。

当前实现对齐：
- 扩展侧 `session.diff` → `editReviewRequest`（requestId 使用 `session:${sessionID}`，会原地更新）。
- webview 侧已实现 files changed bar + 多文件 diff modal，并支持 openDiff/openAllDiffs/openFile。
- undo：扩展侧通过 `/session/:id/revert`（messageID）做 best-effort 撤销；目前依赖 `message.part.updated(partType=patch)` 记录锚点，属于“尽力而为”策略（需要 runtime 明确保证 revert 语义）。

### 12.6 Tool / URL Approval（审批）

VS Code 文档语义（Use tools in chat）：
- 工具调用可能需要用户审批（允许一次/总是允许/拒绝）
- 访问 URL（fetch）通常是单独的 URL 审批（与工具审批不同层级）

opentride/runtime 侧建议对齐为两类 permission：
- `permission.request`：工具级（fs.* / terminal.* / mcp.*）
- `permission.request`（或专门事件）+ permission=fetch.url：URL 级（fetch / browser）

Tripilot UI 建议：
- 审批必须在 webview 内完成（不弹 VS Code 原生 modal），以便达到 Copilot Chat 的“可回看执行轨迹”。
- 审批的 UI 也应产生一条进度/工具行（例如“Waiting for approval…”）。

当前实现对齐：
- 扩展侧已监听 `permission.asked` 并通过 webview 内联审批卡片回写 `permission.reply`（可回看执行轨迹）。
- Tripilot（2026-02 增量）：permission/question 均会产出 `chatProgress` 轨迹（running/done/error），并在 webview 中按进度组展示。
- `editApprovalAction` 目前标注为未端到端接线（尚未实现）。

#### 12.6.1 Checkpoints（还原检查点 / 重做，定案）

目标：复刻 Copilot Chat 的“还原检查点（Restore checkpoint）”与“重做（Redo）”体验：
- 在一次 turn 结束、且产生了 workspace edits 时，插入 checkpoint 卡片。
- 用户点击“还原检查点”后：撤销该检查点之后的所有 workspace 修改，并将聊天记录回滚到该检查点位置。
- 还原后弹出 redo toast（“已还原检查点 / 重做 / 关闭”），允许一次性重做刚才被还原的修改。

消息契约：
- extension → webview
  - `chatCheckpoint({ checkpointId })`：在消息时间线上插入 checkpoint 卡片。
  - `checkpointRedoOffer({ checkpointId, redoToken })`：展示 redo toast。
  - `checkpointRedoClear()`：隐藏 redo toast。
- webview → extension
  - `checkpointAction({ action: "restore", checkpointId })`
  - `checkpointAction({ action: "redo", checkpointId, redoToken })`

extension 行为（MVP，best-effort，已落地）：
1) 何时创建 checkpoint
  - turn 结束进入 idle 时，若存在 diffs：生成一个 checkpointId，并发送 `chatCheckpoint`。
  - diffs 来源：
    - HTTP+SSE：使用 `session.diff` 的 diff 列表（`state.lastSessionDiffs`）。
    - ACP：合并 `acp.diffsByRequestId` 的 diffs。
2) Restore（还原）
  - 前置条件：仅允许在 idle 状态执行（busy 时必须拒绝）。
  - 文件回滚：以“检查点创建时的 diff 快照”为准，将每个文件写回到 checkpoint 的 `after` 文本；对“检查点后新增但检查点快照不包含”的文件，best-effort 删除。
  - 聊天回滚：发送 `chatReset`，然后重放 transcript 到 checkpoint（含 checkpoint 卡片本身）。
  - UI 清理：清空/隐藏 Files changed bar（避免还原前的 pending hunks 残留）。
  - redo 发放：生成 `redoToken`，发送 `checkpointRedoOffer`。
3) Redo（重做）
  - 前置条件：必须提供与 restore 发放一致的 `redoToken`；否则忽略。
  - 文件恢复：把 restore 之前捕获的“当前文件内容”写回（best-effort；无法读取的文件不会强行覆盖）。
  - 聊天恢复：发送 `chatReset` 并重放 restore 前的 transcript。
  - 清理：发送 `checkpointRedoClear`，并清空 redo plan（一次性）。

重要约束（定案）：
- redo offer 的有效期：只保证“紧跟一次 restore 的一次 redo”。一旦用户发送新消息（新 turn）或产生新的 edits，必须清除 redo offer。
- 该实现不泄露模型的 chain-of-thought：checkpoint 仅存 diff 快照与 UI transcript（user/assistant 文本）。
- 这是“工作区层面的回滚”，不是“服务端会话 message 列表的严格回滚”。若未来 runtime 暴露更严格的 revert（例如按 messageId 回滚会话 + diffs），可替换此 best-effort 文件回滚实现以提升一致性。

### 12.7 对齐差距（以“完全复刻 Copilot 进度/状态”为准）

已对齐（可用）：
- Working → Thinking 的切换框架（bridge 层状态机）。
- Tool begin/end 摘要（默认折叠）+ input/output preview。
- Files changed bar（预览/保留/撤销）+ 多文件 diff modal + openDiff/openAllDiffs/openFile。
- Checkpoints（还原检查点 / 重做）MVP：还原后清理 pending UI，并提供一次性 redo offer。

未对齐（需要补）：
- URL approval：若 runtime 将 URL 级审批单独建模（例如 fetch/browser），需要同样以 webview 内联卡片承载（并在聊天记录中可回看）。
- 细粒度 progress：例如 “Read files / Summarizing conversation / Choosing tools …” 需要 runtime 侧事件或 bridge 层规则化生成。
- References：Copilot 的引用/使用了哪些上下文（Used X references）目前没有稳定事件来源，`chatReference` 尚未接入。
- Checkpoints 严格一致性：HTTP+SSE 若能提供“按 messageId 严格回滚会话 + diff”的 server-side 语义，应升级为 server-side restore（而非 client 端 best-effort 写文件）。

### 12.8 下一步 TODO（工程拆解）

1) Runtime/Protocol：补齐 progress/reference/approval 的事件契约（protocol schemas + runtime emit）。
2) SDK/Bridge：把 permission.asked / question.asked 改为发往 webview 的审批消息，回传 reply，并生成可回看的 progress/tool 行。
3) Webview：实现 Copilot-like approval 卡片（Allow once/always/deny + 详细模式），并与 tool summary 关联。
4) Edits：把 revert 语义从 best-effort 升级为“严格撤销本次 edits”（runtime 明确 messageID/patchID 关联）。
5) References：定义“引用来源”格式（文件/符号/URL/diagnostic），并在 UI 增加折叠展示。

注：上述第 2 项（permission.asked / question.asked → webview）已完成；后续重点转向 URL 级审批语义、References 事件来源与更细粒度 progress。
