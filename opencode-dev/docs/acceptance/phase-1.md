# Phase 1 验收：opencode 全量 + Tripilot UI（流式 + 工具 + 权限）

本验收文档是“可复现、可抓证据”的执行清单：做完 Phase 1 的实现后，必须逐条验证并记录结果（截图/日志/抓包）。

## 0. 目标与非目标

### 0.1 目标（必须全部通过）

- Tripilot UI 能通过 opencode server 完成一次端到端对话：创建会话 → 发送消息 → SSE 流式增量 → 完成。
- UI 能展示工具调用状态（至少 begin/end 或 running/completed），且不会卡死在 running。
- UI 能处理权限请求：弹出审批 UI → 回写允许/拒绝 → 会话继续/中止。
- UI 能处理 question 请求：以内联问题卡片收集输入并回写 runtime（不使用 VS Code 原生 modal）。
- permission/question 的流程轨迹可见：`chatProgress` 至少覆盖 running 与结果态（done/error），且同一 requestId 原位更新。
- “CLI 登录一次可用”：本机执行过 `opencode auth login` 后，Tripilot 能显示 provider 已登录状态（不读取 token 明文）。

### 0.2 非目标（Phase 1 不测/不要求）

- Checkpoint/redo、复杂 diff review 体验（Phase 2/3 再补）。
- 多窗口多实例强一致（Phase 2 再测）。

---

## 1. 测试环境（Preflight）

### 1.1 环境要求

- OS：Windows（本机）
- IDE：VS Code 或 VSCodium（建议都测）
- opencode：能在本机启动 server（`opencode serve`）
- Tripilot：作为 VS Code 扩展在 Extension Development Host 中可运行

### 1.2 必须记录的信息

- VS Code/VSCodium 版本号
- opencode 版本（commit/tag）
- 扩展版本（commit）
- 运行端口（server 监听端口）

---

## 2. 启动步骤（必须可重复）

### 2.1 启动 opencode server（CLI）

- 启动命令：`opencode serve --port <PORT>`（或等价方式）
- 探活：`GET http://127.0.0.1:<PORT>/doc` 返回 200
- 事件流：`GET http://127.0.0.1:<PORT>/event` 返回 `text/event-stream`

记录证据：
- `/doc` 的 200 截图或 curl 输出
- `/event` 响应头截图（Content-Type）

### 2.2 启动扩展（F5）

- 在扩展开发宿主中打开 Tripilot UI
- 确认 UI 加载完成（无红色错误提示）

记录证据：
- UI 首页截图
- Extension Host Console 无 error（或记录 error 作为缺陷）

---

## 3. 验收用例（逐条执行）

> 每条用例必须同时检查：UI 表现、HTTP 请求、SSE 事件序列、错误处理。

### TC1：创建会话 + 发送消息（Happy Path）

步骤：
1) 打开 Tripilot Chat。
2) 发送一句普通文本，例如："hello"。

期望（UI）：
- UI 立即显示用户消息。
- UI 在 1s 内进入“正在思考/生成”状态。

期望（网络）：
- 发生会话创建请求（若首次）：`POST /session`（或等价）。
- 发送消息：`POST /session/{id}/prompt_async`（或等价）。

期望（SSE）：
- 至少收到一次 assistant 增量事件（对应 UI 的流式 delta）。
- 最终收到“assistant 完成”信号，UI 停止追加内容。

失败判定：
- UI 没有任何 delta，或只出现一次整段文本（不流式）
- UI 一直 loading 不结束

证据：
- DevTools Network：两条请求的 URL+status
- SSE 事件抓包（至少 10 条事件样本）

### TC2：流式稳定性（长输出 + 滚动 + 不丢字）

步骤：
1) 发送一个会触发长回答的问题（例如要求列 50 条）。
2) 在回答流式输出时滚动上下。

期望：
- UI 不掉帧/不冻结（主观可用；如有性能指标可记录）。
- 文本连续，不重复、不丢失、不乱序。

证据：
- 录屏或关键时刻截图
- SSE 事件序列片段

### TC3：工具调用展示（最少 begin/end）

前置：选择一个会触发工具的任务（例如让 assistant 运行一个简单命令或读文件）。

步骤：
1) 发送会触发工具的指令。

期望：
- UI 出现工具卡片（begin），并在完成后变为 end/completed。
- 工具卡片显示 toolName 与状态。

证据：
- UI 工具卡片截图
- SSE 中对应 tool/tool-part 事件样本

### TC4：权限请求（允许一次）

步骤：
1) 发送会触发敏感操作的指令（文件写入/终端执行）。
2) 在权限弹窗选择 Allow once。

期望：
- UI 弹出权限审批（3 选项至少包含 allow/reject，推荐 allow_once/allow_always/reject）。
- 点 Allow once 后，工具继续执行，最终完成。

证据：
- 权限弹窗截图
- 审批回写请求（permission approve）URL+status

### TC5：权限请求（拒绝）

步骤：
1) 触发权限请求。
2) 选择 Reject。

期望：
- 会话停止继续执行该工具。
- UI 明确提示“被拒绝”，且不会继续流式输出错误内容。

证据：
- UI 提示截图
- SSE/HTTP 中错误状态样本

### TC5.1：question 请求（提交 / 取消）

步骤：
1) 触发一个需要用户输入的问题请求（question/prompt/input 类）。
2) 在内联问题卡片中提交答案。
3) 再次触发并执行取消（或等待超时）。

期望：
- 问题卡片在 webview 内联出现（非 VS Code 原生 modal）。
- 提交后 runtime 收到 answers/answer 并继续流程。
- 取消/超时返回 cancelled（或等价语义），并可继续后续对话。

证据：
- question 卡片截图（提交前/后、取消/超时）
- request/response 日志样本

### TC5.2：chatProgress 轨迹（permission/question）

步骤：
1) 执行 TC4、TC5、TC5.1。
2) 观察每次流程的进度轨迹。

期望：
- permission/question 都有 running → done/error 轨迹。
- 同一 requestId 按 id 原位更新，不重复刷多条同义项。

证据：
- 进度组展开截图
- requestId 对应日志

### TC6：取消（Abort）

步骤：
1) 发送一个会持续生成的请求。
2) 点击 Stop/Cancel。

期望：
- 扩展向 server 发 abort（`POST /session/{id}/abort` 或等价）。
- UI 立即停止追加，并进入 canceled/idle。

证据：
- abort 请求抓包
- UI 最终状态截图

### TC7：CLI 登录一次可用（auth.status）

步骤：
1) 在系统终端运行 `opencode auth login` 完成一次登录（OAuth 或 API key）。
2) 打开 Tripilot Settings（或状态面板）点击 Refresh。

期望：
- UI 显示 provider 已配置/已登录（OAuth 还应显示 expiresAt）。
- 不展示 token 明文。

证据：
- 状态面板截图
- runtime/opencode 侧 `auth.json` 存在（仅证明存在，不展示内容）

---

## 4. 断线与重连（Phase 1 最低要求）

### TC8：SSE 断线提示

步骤：
1) 正在流式时，临时断网或杀掉 server。

期望：
- UI 提示“连接已断开/重连中”，不会假装还在生成。
- 恢复后允许用户重试。

证据：
- UI 提示截图
- Console error 记录

---

## 5. 通过标准

- 所有 TC1~TC7、TC5.1、TC5.2 必须 Pass。
- TC8 至少要有“明确提示 + 不继续生成”的安全行为。

---

## 6. 缺陷记录格式（必填）

- Case ID：
- 现象：
- 期望：
- 复现步骤：
- 证据：截图/日志/抓包
- 严重级：Blocker / Major / Minor

---

## 7. 执行记录（2026-02-23）

- TC5.1：Pass
	- 结果：通过 `Tripilot: Debug Mock Question` 验证 question 卡片提交与取消两条分支，均可回写并结束流程。
- TC5.2：Pass
	- 结果：通过 `Tripilot: Debug Mock Permission` + `Tripilot: Debug Mock Question` 验证 progress 轨迹可见且收敛。

说明：
- 本记录用于确认 Phase 1 新增的 question/progress 验收项已完成首轮实测。
