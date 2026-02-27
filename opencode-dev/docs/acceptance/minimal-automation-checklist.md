# 最小化自动化清单（Tripilot × opencode-acp）

更新时间：2026-02-23
目标：用最小成本覆盖最高风险链路，减少截图与手工回归负担。

## 1. 每日自动化（CLI，5项，约2-5分钟）

> 全部通过时仅保留文本日志；失败时再保留截图/录屏。

执行命令：
- `powershell -ExecutionPolicy Bypass -File scripts/acceptance/daily-smoke.ps1`
- 若仅快速检查（跳过 TypeScript 编译）：
  - `powershell -ExecutionPolicy Bypass -File scripts/acceptance/daily-smoke.ps1 -SkipTypeCheck`

- C1 健康检查
  - 检查 `opencode` 可执行、`/doc` 返回 200、`/event` 为 `text/event-stream`。
- C2 扩展编译健康
  - 检查 Tripilot watch/构建无 TypeScript 错误。
- C3 调试命令可用性
  - 命令面板可执行：`Tripilot: Debug Mock Permission`、`Tripilot: Debug Mock Question`。
- C4 关键结果文本断言
  - 聊天中出现 `Mock Permission 选择结果:` 与 `Mock Question 收到回答:`（或取消提示）。
- C5 进度轨迹断言
  - 存在“执行进度”分组，且状态从 running 收敛到 done/error。

通过标准：5/5 Pass。

---

## 2. 每两周自动化（Playwright，5项，约10-20分钟）

> 两周跑一次，并只在失败时保存截图；通过仅保留测试报告。

- P1 Permission 卡片显示与按钮分支
  - 断言卡片出现，按钮含“允许一次/始终允许/拒绝”。
- P2 Permission 选择后结果回显
  - 点击“允许一次”后断言出现 `Mock Permission 选择结果: once`。
- P3 Question 卡片提交分支
  - 选择 3 组答案并提交，断言 `Mock Question 收到回答`。
- P4 Question 取消分支
  - 点击取消，断言 `已取消或未提交`。
- P5 进度组原位更新
  - 断言“执行进度”中同一流程不会重复刷同义项，最终有结果态。

通过标准：5/5 Pass。

---

## 3. 失败留证策略（省空间）

- 通过：仅保留 `junit/json` + 控制台摘要日志。
- 失败：保留失败截图（单用例最多 1-2 张）+ requestId 对应日志。
- 保留期建议：
  - 通过结果：14 天
  - 失败证据：90 天

---

## 4. 最小目录建议

- `docs/acceptance/reports/daily/`（文本报告）
- `docs/acceptance/reports/biweekly/`（Playwright 报告）
- `docs/acceptance/reports/failures/`（仅失败截图/日志）

---

## 5. 与现有文档关系

- 日常执行策略：见 [最小回归矩阵](./minimal-regression-matrix.md)
- 人工补充脚本：见 [手工冒烟脚本](./manual-smoke-tripilot-opencode-acp-2026-02.md)
- 验收基线：见 [Phase 1](./phase-1.md) 与 [Phase 2](./phase-2.md)
