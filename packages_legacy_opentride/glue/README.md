# @opentride/glue

glue 层负责：
- 传输层抽象（HTTP+SSE 与 stdio JSON-RPC 可切换）
- 协议 envelope 映射与（可选）校验
- Tripilot UI 协议与 opentride 协议之间的适配

阶段 1 只需要跑通 HTTP+SSE。
