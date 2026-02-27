# 最小回归矩阵（Tripilot × opencode-acp）

更新时间：2026-02-23
适用场景：日常开发回归、提测前检查、发版前 Gate

## 1. 回归分层

### L0：提交前/日常冒烟（10-15 分钟）

目标：快速判断关键链路是否可用。

必跑：
- Phase 1: TC1（基本对话）
- Phase 1: TC3（工具卡片 begin/end）
- Phase 1: TC5.1（question 提交/取消）
- Phase 1: TC5.2（permission/question chatProgress）
- Phase 2: TC0-3（中文文案校验）

通过标准：
- 以上用例全部 Pass；若任一 Fail，阻断当日合并主分支。

---

### L1：提测前回归（30-60 分钟）

目标：确认核心体验稳定、可演示。

必跑：
- L0 全部
- Phase 1: TC2（长输出流式稳定性）
- Phase 1: TC4（权限允许一次）
- Phase 1: TC5（权限拒绝）
- Phase 1: TC6（取消）
- Phase 2: TC0-1、TC0-2（迁移专项）
- Phase 2: TC4（多会话隔离）

通过标准：
- 关键链路（question/permission/progress/cancel）无 Blocker。

---

### L2：发版前 Gate（半天）

目标：上线风险控制。

必跑：
- L1 全部
- Phase 1: TC7（CLI 登录一次可用）
- Phase 1: TC8（断线提示安全行为）
- Phase 2: TC1（重启 Extension Host 恢复）
- Phase 2: TC2（重启 server 恢复）
- Phase 2: TC3（SSE 去重）
- Phase 2: TC5（错误提示质量）

通过标准：
- 无 Blocker/Major 未关闭项；
- 迁移增量专项 TC0-1~TC0-3 必须全部 Pass。

---

## 2. 执行建议（按角色）

- 开发者：每次改动后至少跑 L0。
- 测试/联调：提测单提交前跑 L1。
- 发布负责人：发版窗口前跑 L2 并签字。

---

## 3. 失败处理规则

- L0 失败：禁止合并，先修复再回归。
- L1 失败：禁止提测，需补缺陷单与复测证据。
- L2 失败：禁止发版，进入发布阻断流程。

---

## 4. 证据最小集

每个失败/通过批次至少保留：
- 关键截图（卡片、进度组、结果态）
- 一段日志（requestId 或命令输出）
- 执行时间与执行人

建议命名：
- `YYYYMMDD-Lx-TCx.y-pass.png`
- `YYYYMMDD-Lx-TCx.y-fail.png`

---

## 5. 关联文档

- [Phase 1 验收](./phase-1.md)
- [Phase 2 验收](./phase-2.md)
- [手工冒烟脚本](./manual-smoke-tripilot-opencode-acp-2026-02.md)
- [最小化自动化清单](./minimal-automation-checklist.md)
