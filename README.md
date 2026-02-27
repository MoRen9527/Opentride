# opentride

opentride 是一个本机子进程（runtime/CLI）+ VS Code/VSCodium Webview UI（Tripilot）的组合工程。

目标：
- Tripilot 只负责 UI/交互（webview）。
- 所有 agentic（规划/循环/工具编排/多模型/MCP/权限/登录/token 落盘）都由 opentride runtime 负责。

详细设计见：docs/design.md。
