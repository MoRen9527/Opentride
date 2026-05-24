# Tride Code State

## Repository Map

- 根级配置：`package.json`、`bunfig.toml`、`tsconfig.json`、`turbo.json`
- agent 与本地规则：`AGENTS.md`、`.opencode/`
- 代码与资产：runtime、CLI、测试、`opencode-dev/` 和相关工程目录

## Current Code Health

- 当前已有较完整的工程骨架和本地规则入口。
- 当前代码健康应按“PC 端软件开发工具层”理解，而不是按正式宿主层理解。
- 代码健康尚未形成统一 registry 评分基线。

## Change Tracking Baseline

- 关键代码变动后续应在本文件补充热区和结构变化摘要。
- 与 SDK、runtime 或 PC 端软件层边界相关的变化应同步回写中央 strategy 边界。

- 涉及具体项目代码仓库时，技术侧文档基线应按 `docs/engineering/DESIGN.md`、技术版 `ROADMAP.md`、技术版 `STATE.md` 以及 `docs/execution/<workstream>/<phase>/PLAN.md`、`SUMMARY.md`、`VERIFICATION.md` 维护；若缺失，应视为待补齐的技术或执行层缺口。

## Git Health

- 尚未建立 registry 级 git 健康摘要。
- 当前只能确认存在活跃工程结构，无法直接从本文件推断变更热度。

## Local CodeGraph Index

- 2026-05-24 已在模块根目录建立本地 CodeGraph 索引，由 `TrideCodeRegistry` 接管摘要与后续维护纪律。
- 当前索引摘要：869 files，11,120 nodes，23,596 edges；语言覆盖 `javascript`、`rust`、`tsx`、`typescript`、`yaml`；backend 为 `node-sqlite`。
- `.codegraph/` 仅作为本地缓存与辅助索引，不作为仓库真源提交；后续只在本文件记录扫描摘要、版本锚点、排除规则、入口与调用链发现、待确认缺口。
- 首轮版本锚点：以本次本地扫描时工作区状态为准；后续正式收口时应补充对应 git commit / branch。

## Quality Risks

- 开发底座的真实复杂度可能高于当前 registry 摘要。
- 若把 Tride 误写成正式宿主或 `TriHost` 替代层，会直接破坏中央运行与宿主边界。
- 若不持续补充 package 和 runtime 结构，后续 Role Agents 很难准确评估实现成本。

## Sources

- `../../AGENTS.md`
- `../../package.json`
- `../../README.md`
- `../../tests/`
