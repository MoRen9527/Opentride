# Tride Product State

## Module Overview

- `Tride` 是本机子进程 runtime / CLI 与 agentic orchestration 底座。
- 它在整体商业模式中属于 PC 端软件层，负责让 `opencode`、`claude code`、`codex` 等开发能力进入设计与开发链路。

## Current Product Scope

- 支撑开发者工具编排、runtime、CLI、SDK 和工具调用能力。
- 作为 `Tripilot + Tride + vscodium + CLI` 组成的 PC 端软件层中的开发工具与 orchestration 底座。
- 配合 `TriLC` 承接本地化任务、本地工具链执行与部分服务域下发任务。
- 也可直接作为用户自用自动化、PC 软件自动化与 `vibe coding` 的工作台能力层。
- 影响研发效率、执行能力和开发成本。
- 不承担正式宿主切换语义；正式宿主适配与切换由 `TriHost` 负责。

- 涉及具体项目代码仓库时，产品侧文档基线应按 `PROJECT.md`、`REQUIREMENTS.md`、产品版 `ROADMAP.md` 和产品版 `STATE.md` 维护；若缺失，应视为待补齐的产品真源缺口。

## Current Progress

- 根级 `AGENTS.md` 已与中央 `BusinessStrategy` 完成委派对齐。
- 首版 registry 已建立工作层，但模块级 README / docs 仍需后续持续归整。
- 当前已明确不再作为切换后的正式宿主，而是继续作为 PC 端软件中的开发工具层演进。

## Bug And Gap State

- 当前产品状态更多依赖根级文档和代码树，缺少统一的模块产品快照。
- `packages/` 等实现细节需要后续 code registry 继续收口。
- 与 `TriHost` 的边界虽然已在中央真源中收口，但模块级产品资料仍需持续跟进该口径。

## Cross-Module Dependencies

- 与 `Tripilot` 一起支撑工具入口和开发工作台能力。
- 与 `vscodium` 共同组成 PC 端软件层。
- 与 `TriLC` 协同完成本地化任务与本地域工具执行。
- 与 `TriMC` 在实际研发链路中形成运行面与开发工具层协同。
- 与 `TriHost` 存在未来正式宿主适配边界关系。
- 与 `Tristaciss` 等模块在实际研发链路中发生协同。

## Architecture State

- 当前定位清晰：属于 PC 端软件层中的 runtime / CLI / orchestration 底座，而不是正式宿主层；但模块级产品资料层还处于首版建立阶段。

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
