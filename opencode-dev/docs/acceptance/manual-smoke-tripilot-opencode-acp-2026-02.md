# Tripilot × opencode-acp 手工冒烟验收脚本（10分钟）

更新时间：2026-02-23
适用范围：TC5.1、TC5.2、TC0-1、TC0-2、TC0-3

## 0. 目标

本脚本用于快速验证本轮迁移新增能力：
- question 内联输入闭环（runtime → webview → runtime）
- permission 内联审批闭环
- chatProgress 轨迹分组、按 requestId 原位更新
- 中文文案一致性

---

## 1. 前置检查（1分钟）

1) 确认 Tripilot watch 在运行（无编译报错）。
2) 启动 opencode server：
   - opencode serve --port 18181
3) 探活：
   - http://127.0.0.1:18181/doc 返回 200
   - http://127.0.0.1:18181/event 返回 Content-Type: text/event-stream
4) VS Code 扩展宿主已打开 Tripilot Chat。

证据：
- 终端截图（server listening）
- /doc 与 /event 响应截图

---

## 2. 用例执行（7分钟）

## TC0-1 / TC5.1：question 提交与取消

步骤A（提交）：
1) 发送会触发 question 的请求（让 agent 需要用户补充输入）。
2) 观察出现“问题输入卡片”（非 VS Code 原生弹窗）。
3) 填写答案并点击“提交”。

期望：
- question 卡片出现。
- 提交后流程继续。
- 进度组中出现“等待输入… → 已收到输入”。

步骤B（取消）：
1) 再触发一次 question。
2) 点击“取消”。

期望：
- 流程不崩溃，可继续下一轮对话。
- 进度组中出现“输入被拒绝/取消”或“输入超时/已取消”。

证据：
- 提交前/提交后截图各1张
- 取消后截图1张

判定：
- Pass：提交与取消都可闭环，且状态正确。
- Fail：无卡片、提交无回写、取消后会话卡死。

---

## TC0-2 / TC5.2：permission + question 轨迹与原位更新

步骤：
1) 触发 permission 请求，分别执行：允许一次、拒绝。
2) 触发 question 请求，分别执行：提交、取消。
3) 在“执行进度”可折叠组中观察同一 requestId 的状态变化。

期望：
- 每个请求都有 running → done/error。
- 同一 requestId 为原位更新，不重复刷多条同义记录。
- 进度在可折叠组内可回看。

证据：
- 进度组展开截图（至少包含1次 running 和最终态）
- permission 与 question 各1次完整轨迹截图

判定：
- Pass：轨迹完整、原位更新生效。
- Fail：重复新增行、状态不收敛、无最终态。

---

## TC0-3：中文文案校验

步骤：
1) 复用上面 permission/question 流程。
2) 检查关键文案是否为中文。

必查文案（示例）：
- 等待审批…
- 审批已通过（once/always）
- 审批已拒绝
- 等待输入…
- 已收到输入
- 输入被拒绝/取消

期望：
- 不出现旧英文残留（如 Waiting for approval / Input received）。

证据：
- 中文文案截图2-3张（覆盖 permission + question）

判定：
- Pass：关键路径文案均为中文。
- Fail：出现英文残留或混杂严重。

---

## 3. 结果汇总模板（2分钟）

请直接填写：

- TC0-1：Pass / Fail
  - 备注：
- TC0-2：Pass / Fail
  - 备注：
- TC0-3：Pass / Fail
  - 备注：
- TC5.1：Pass / Fail
  - 备注：
- TC5.2：Pass / Fail
  - 备注：

总评：
- 通过条件：以上 5 项全部 Pass。
- 若 Fail：记录复现步骤、截图、发生时间与最近 requestId。

### 3.1 本轮执行记录（2026-02-23）

- TC0-1：Pass
  - 备注：`Tripilot: Debug Mock Question` 已验证提交分支；出现 `Mock Question 收到回答`。
- TC0-2：Pass
  - 备注：`Tripilot: Debug Mock Permission` + `Tripilot: Debug Mock Question` 均出现进度组并收敛到结果态。
- TC0-3：Pass
  - 备注：关键文案均为中文（等待审批、需要权限、调试问题、已取消或未提交等）。
- TC5.1：Pass
  - 备注：question 卡片提交与取消分支均闭环。
- TC5.2：Pass
  - 备注：permission/question 轨迹可见，且同一流程未出现同义重复刷屏。

总评：
- 本轮 5 项全部 Pass，可作为 2026-02 迁移增量专项首轮验收结果。

---

## 4. 常见失败定位

1) 无 question/permission 卡片
- 检查当前 provider 是否为 opencode-acp。
- 检查 extension host 控制台是否有消息桥接错误。

2) 进度不更新或重复
- 检查 chatProgress 是否带 id。
- 检查前端是否命中按 id 更新分支。

3) 文案出现英文
- 检查前端 toolName 映射与状态文案是否被旧分支覆盖。

---

## 5. 调试命令（用于稳定复现）

当 runtime 未稳定触发 `question/request` 或 `permission/request` 时，可使用以下命令做“协议层直测”：

- `Tripilot: Debug Mock Question`
  - 作用：直接弹出 question 内联卡片，覆盖提交/取消两条分支。
  - 用于：TC0-1、TC5.1、TC0-2（question 侧）。
- `Tripilot: Debug Mock Permission`
  - 作用：直接弹出 permission 卡片，覆盖允许一次/始终允许/拒绝分支。
  - 用于：TC5.2、TC0-2（permission 侧）。

使用方式：
1) 在 Extension Development Host 打开命令面板；
2) 运行对应 Debug 命令；
3) 截图卡片与结果回显；
4) 在“执行进度”中核对 running → done/error。

注意：
- Debug 命令用于验证 Tripilot Webview 协议映射与交互闭环；
- 真实 runtime 端到端链路仍需在后续回归中复测。

---

## 6. 关联文档

- [Phase 1 验收](./phase-1.md)
- [Phase 2 验收](./phase-2.md)
- [最小回归矩阵](./minimal-regression-matrix.md)
- [设计文档](../design.md)
