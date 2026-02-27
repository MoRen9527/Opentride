# Opentride → opencode-dev 迁移草案（Step B）

更新时间：2026-02-27
分支：`chore/migrate-to-opencode-dev`

## 目标

- 将业务代码与构建相关目录统一收口到 `opencode-dev/`。
- 根目录保留“仓库治理与入口层”（README、许可、CI、Git 配置等）。

## 建议迁移映射（第一批）

以下目录建议迁入 `opencode-dev/`：

- `docs/`
- `infra/`
- `nix/`
- `packages/`
- `packages_legacy_opentride/`
- `patches/`
- `script/`
- `scripts/`
- `sdks/`
- `specs/`
- `themes/`

以下文件建议迁入 `opencode-dev/`（与工程构建强相关）：

- `package.json`
- `package_legacy_opentride.json`
- `bun.lock`
- `bunfig.toml`
- `tsconfig.json`
- `turbo.json`
- `sst.config.ts`
- `sst-env.d.ts`
- `flake.nix`
- `flake.lock`

## 根目录建议保留（入口/治理层）

- `.git/`、`.github/`、`.gitignore`
- `.vscode/`、`.editorconfig`、`.prettierignore`
- `.husky/`
- `README.md`、`README.zh-CN.md`、`README.zh-TW.md`
- `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`
- `AGENTS.md`
- `STATS.md`、`STYLE_GUIDE.md`
- `install`
- `logs/`（可选：后续再评估是否下沉）
- `github/`（若仅存放临时脚本，可后续评估）

## 暂不迁移（第二批再评估）

- `node_modules/`（不迁移，迁移后重装依赖）
- `.opencode/`（保留根目录，避免破坏本地工具会话状态）

## 执行提示（下一步）

1. 先创建 `opencode-dev/`。
2. 按“目录优先、文件其次”顺序搬迁。
3. 修正根目录入口脚本（转发到 `opencode-dev/`）。
4. 执行最小验证：安装依赖、构建、关键脚本。
5. 通过后再提交“迁移 commit + 兼容 commit + 文档 commit”。

## 当前执行状态（2026-02-27）

- 已完成下沉：`docs/`、`infra/`、`nix/`、`packages_legacy_opentride/`、`patches/`、`script/`、`scripts/`、`sdks/`、`specs/`、`themes/`。
- 未完成：`packages/`（本地进程占用导致 `git mv` 权限错误，需释放占用后重试）。