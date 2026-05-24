# Tride Agent Rules

## Module Role

- Tride 是本机子进程 runtime / CLI 与 agentic orchestration 底座。
- 在整体商业模式里，它负责把 `opencode`、`claude code`、`codex` 等开发能力真正接入设计与开发链路。
- 它不单独定义总体商业模式，但会直接影响研发效率、执行能力和开发成本。

## Existing Local Rules

- To test opencode in `packages/opencode`, run `bun dev`.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.

## Strategy Delegation

- 涉及总体商业模式、当前商业实验、模块优先级、是否需要 Tride 参与某条商业路径时，先回到 `TriMetaverse/BusinessStrategy`。
- 不要在本仓库内自行猜测整体商业模式或替代中央策略判断。

## Local Fact Sources

- 产品事实优先看：`README.md`、`docs/`、包清单和根级 `AGENTS.md`
- 代码事实优先看：`packages/`、`sdks/`、runtime 代码和子目录 `AGENTS.md`

## Current Registries

- `TrideBusinessStrategyRegistry`
- `TrideProductRegistry`
- `TrideCodeRegistry`

当前 registry agent canonical discovery 位于 `Tride/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。
