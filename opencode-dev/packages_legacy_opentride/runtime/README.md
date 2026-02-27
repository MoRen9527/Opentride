# @opentride/runtime

本包将实现 opentride 本机子进程（runtime/CLI）：
- HTTP /rpc + SSE /events（阶段 1）
- tool 执行：fs.* 与 terminal.*（阶段 1）
- auth/token/config 落盘（不依赖 VS Code/GitHub auth API）

协议定义：../protocol/schemas/v1/index.schema.json。

## 本地启动（开发）

在 opentride 根目录：

- `npm run runtime:start`（默认监听 127.0.0.1:4317）

或直接：

- `node packages/runtime/src/cli.js --host 127.0.0.1 --port 4317`

Endpoints:

- `GET /health`
- `POST /rpc`
- `GET /events?sessionId=...`（SSE）

## 工具（阶段 1：最小可用）

目前 runtime 里实现了最小的 `fs.*` / `terminal.*`，并且所有工具默认都会触发 `permission.request`（通过 SSE 发给 UI），需要 UI 再用 `permission.reply` 回写才会继续执行。

为了便于快速联调，`run.start` 暂时支持用用户消息直接触发工具（后续会替换为真正的 agent/tool 调度）：

- `terminal.exec <command>`
- `fs.readFile <path>`
- `fs.listDir <path>`
- `fs.writeFile <path> <<<content`
