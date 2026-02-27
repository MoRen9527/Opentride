# Phase 2 验收：健壮性与体验（重连/恢复/多会话/错误处理）

Phase 2 目标是把 Phase 1 的“能跑通”提升为“可靠且可用”。

## 1. 目标

- 会话状态可恢复（重启 Extension Host / 重启 server 后仍能继续使用）。
- SSE 重连可用，且不会重复渲染/乱序。
- 多会话隔离（最少同一窗口内切换 session 不串台）。
- 错误提示清晰，可恢复动作明确。

## 2. Preflight

- 已通过 Phase 1 全部用例。

## 3. 用例

### 3.0 2026-02 迁移增量专项（Tripilot ← opencode-acp）

> 目的：验证本轮新增的 `question` 端到端闭环与 `chatProgress` 轨迹可视化（含中文文案）在真实会话中稳定工作。

#### TC0-1：question 端到端闭环（runtime → webview → runtime）

步骤：
1) 触发一个会要求用户输入的问题（question/prompt/input 类请求）。
2) 在 webview 内联问题卡片中填写并提交。

期望：
- 出现 question 卡片（不是 VS Code 原生 modal）。
- 提交后 runtime 收到 answers/answer，流程继续。
- 取消/超时时返回 cancelled（或等价语义），流程可恢复。

证据：
- question 卡片截图（提交前/提交后）
- 对应请求日志（request/response）

#### TC0-2：permission/question 的 chatProgress 轨迹

步骤：
1) 触发 permission 请求并分别执行：允许、拒绝、取消（或超时）。
2) 触发 question 请求并分别执行：提交、拒绝/取消（或超时）。

期望：
- 每次都出现 `running → done/error` 的进度轨迹。
- 同一 requestId 按 id 原位更新，不重复刷出多条同义记录。
- 轨迹在 webview 中归入“可折叠进度组”，可回看。

证据：
- 进度组展开截图（含 running 与最终状态）
- 控制台/日志里 requestId 对应关系

#### TC0-3：中文化文案校验

步骤：
1) 重复 TC0-2 的各分支。

期望：
- 文案为中文（如“等待审批/等待输入/审批已通过/已收到输入”等）。
- 不出现旧英文文案残留（Waiting for approval / Input received 等）。

证据：
- 各状态截图

### TC1：重启 Extension Host 后恢复

步骤：
1) 进行一轮对话并触发一次工具。
2) Developer: Reload Window。

期望：
- 重新打开 Tripilot 后能看到会话历史（或至少能继续对话）。
- 不会出现“幽灵工具卡片”卡在 running。

### TC2：重启 opencode server 后恢复

步骤：
1) 打开 UI 并保持连接。
2) 重启 opencode server。

期望：
- UI 断线提示明确。
- server 恢复后可重新连接并继续发送消息。

### TC3：SSE 去重/不重复渲染

步骤：
1) 在流式过程中制造短暂网络抖动。

期望：
- UI 不会重复追加已显示的文本（最少不出现大段重复）。

### TC4：多会话隔离

步骤：
1) 创建会话 A，发消息。
2) 创建会话 B，发消息。
3) 回到会话 A。

期望：
- A/B 的消息与工具卡片严格分离。

### TC5：错误提示（401/403/5xx/timeout）

步骤：
1) 制造 401（未登录 provider）或 403（权限拒绝）。
2) 制造 5xx（server 崩溃/返回错误）。
3) 制造 timeout（延迟网络）。

期望：
- UI 提示必须包含：错误类型、建议动作（重试/登录/查看日志）。

## 4. 通过标准

- 所有用例 Pass。
- 对于不可避免的网络抖动，UI 行为必须“可解释且不破坏会话”。
- 迁移增量专项（TC0-1~TC0-3）全部 Pass。

---

## 5. 执行记录（2026-02-23）

- TC0-1：Pass
	- 结果：question 内联卡片可展示；提交后出现回答回显；取消分支可结束并恢复。
- TC0-2：Pass
	- 结果：permission/question 均出现进度轨迹，状态从 running 收敛到 done/error。
- TC0-3：Pass
	- 结果：本轮路径未发现英文旧文案残留。

说明：
- 以上为 2026-02 迁移增量专项首轮实测结果，用于阶段里程碑归档。
