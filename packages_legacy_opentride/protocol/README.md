# @opentride/protocol

协议唯一事实来源：schemas/v1/index.json。

- JSON Schema: draft-07
- 严格区分：request/response/event（通过 kind const）
- type 判别：通过 type const
- response：payload.result | payload.error 二选一
