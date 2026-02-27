import * as vscode from "vscode"
import * as childProcess from "node:child_process"

export type AcpSpawnConfig = {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  onStderr?: (chunkText: string) => void
}

export type AcpConnected = {
  process: childProcess.ChildProcessWithoutNullStreams
  connection: any
}

export type AcpSession = AcpConnected & {
  sessionId: string
}

export async function createAcpConnected(
  config: AcpSpawnConfig,
  handlers: {
    onSessionUpdate: (update: any) => void | Promise<void>
    onRequestPermission: (req: any) => Promise<any>
    canWriteTextFile?: (params: { path: string; content: string }) => boolean | Promise<boolean>
    onRequestEditApproval?: (req: {
      requestId: string
      title?: string
      diffs: Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
    }) => Promise<"apply" | "cancel" | undefined>
    onDidApplyEdits?: (evt: {
      requestId: string
      title?: string
      diffs: Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
    }) => void | Promise<void>

    // ACP extension methods (agent -> client).
    onExtMethod?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
    onExtNotification?: (method: string, params: Record<string, unknown>) => void | Promise<void>
  },
): Promise<AcpConnected> {
  const sdk = await import("@agentclientprotocol/sdk")

  const proc = childProcess.spawn(config.command, config.args, {
    cwd: config.cwd,
    env: {
      ...process.env,
      ...(config.env ?? {}),
    },
    stdio: "pipe",
  })

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        proc.stdin.write(Buffer.from(chunk), (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    },
  })

  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      proc.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk))
      })
      proc.stdout.on("end", () => controller.close())
      proc.stdout.on("error", (err) => controller.error(err))

      proc.on("error", (err) => controller.error(err))
      proc.on("exit", () => controller.close())
    },
  })

  // Surface stderr to the extension host console for diagnosis.
  proc.stderr.on("data", (chunk: Buffer) => {
    // eslint-disable-next-line no-console
    console.error(`[acp] ${String(chunk)}`)

    try {
      config.onStderr?.(String(chunk))
    } catch {
      // ignore
    }
  })

  const stream = sdk.ndJsonStream(output, input)

  const client: any = {
    async sessionUpdate(params: any) {
      await handlers.onSessionUpdate(params)
    },

    async requestPermission(params: any) {
      return handlers.onRequestPermission(params)
    },

    async readTextFile(params: any): Promise<any> {
      // ACP uses absolute paths.
      const uri = vscode.Uri.file(params.path)
      const data = await vscode.workspace.fs.readFile(uri)
      const text = new TextDecoder("utf-8").decode(data)
      return { content: text }
    },

    async writeTextFile(params: any): Promise<any> {
      const uri = vscode.Uri.file(params.path)
      const after = typeof params?.content === "string" ? params.content : String(params?.content ?? "")

      if (handlers.canWriteTextFile) {
        const allowed = await handlers.canWriteTextFile({ path: String(params?.path ?? ""), content: after })
        if (!allowed) {
          throw new Error(`Write denied by policy: ${String(params?.path ?? "")}`)
        }
      }

      let before = ""
      try {
        const existing = await vscode.workspace.fs.readFile(uri)
        before = new TextDecoder("utf-8").decode(existing)
      } catch {
        // file may not exist
      }

      const isEdit = before !== after
      const fileLabel = (() => {
        try {
          const rel = vscode.workspace.asRelativePath(uri, false)
          return String(rel ?? "").trim() || String(params.path)
        } catch {
          return String(params.path)
        }
      })()

      const diff = {
        file: fileLabel,
        additions: Math.max(0, after.split(/\r?\n/).length - before.split(/\r?\n/).length),
        deletions: Math.max(0, before.split(/\r?\n/).length - after.split(/\r?\n/).length),
        before,
        after,
      }

      const requestId = `acp-write-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const title = `写入文件：${fileLabel}`

      if (isEdit && handlers.onRequestEditApproval) {
        const action = await handlers.onRequestEditApproval({ requestId, title, diffs: [diff] })
        if (action !== "apply") {
          throw new Error("Edit cancelled by user")
        }
      }

      const enc = new TextEncoder()
      await vscode.workspace.fs.writeFile(uri, enc.encode(after))

      if (isEdit && handlers.onDidApplyEdits) {
        try {
          await handlers.onDidApplyEdits({ requestId, title, diffs: [diff] })
        } catch {
          // ignore
        }
      }
      return {}
    },

    async createTerminal(_params: any) {
      throw sdk.RequestError.methodNotFound("terminal/create")
    },

    async terminalOutput(_params: any): Promise<any> {
      throw sdk.RequestError.methodNotFound("terminal/output")
    },

    async waitForTerminalExit(_params: any): Promise<any> {
      throw sdk.RequestError.methodNotFound("terminal/wait_for_exit")
    },

    async killTerminal(_params: any): Promise<any> {
      throw sdk.RequestError.methodNotFound("terminal/kill")
    },

    async releaseTerminal(_params: any): Promise<any> {
      throw sdk.RequestError.methodNotFound("terminal/release")
    },

    async extMethod(_method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> {
      const method = String(_method ?? "").trim()
      const params = (_params && typeof _params === "object" ? _params : {}) as Record<string, unknown>

      try {
        // eslint-disable-next-line no-console
        console.error(`[acp] extMethod: ${method} ${JSON.stringify(params).slice(0, 2000)}`)
      } catch {
        // ignore
      }

      if (handlers.onExtMethod) {
        return await handlers.onExtMethod(method, params)
      }

      // Default: return empty object for unknown extension methods.
      return {}
    },

    async extNotification(_method: string, _params: Record<string, unknown>): Promise<void> {
      const method = String(_method ?? "").trim()
      const params = (_params && typeof _params === "object" ? _params : {}) as Record<string, unknown>
      try {
        // eslint-disable-next-line no-console
        console.error(`[acp] extNotification: ${method} ${JSON.stringify(params).slice(0, 2000)}`)
      } catch {
        // ignore
      }

      if (handlers.onExtNotification) {
        await handlers.onExtNotification(method, params)
      }
      return
    },
  }

  const connection = new sdk.ClientSideConnection(() => client, stream)

  return { process: proc, connection }
}

export function formatPermissionTitle(req: any): string {
  const title = req.toolCall?.title ? String(req.toolCall.title) : "permission"
  const kind = req.toolCall?.kind ? String(req.toolCall.kind) : ""

  const raw = req.toolCall?.rawInput && typeof req.toolCall.rawInput === "object" ? (req.toolCall.rawInput as any) : undefined
  const filepathRaw = raw && typeof raw.filepath === "string" ? raw.filepath : ""
  const filepath = String(filepathRaw ?? "").trim()

  const base = kind ? `${title} (${kind})` : title
  return filepath ? `${base}: ${filepath}` : base
}

export async function promptPermissionChoice(options: Array<{ optionId: string; name: string }>, title: string): Promise<string | undefined> {
  const items = options.map((o) => ({ label: o.name, optionId: o.optionId }))
  const picked = await vscode.window.showQuickPick(items, {
    title: `允许执行：${title}？`,
    placeHolder: "选择一个权限选项",
    ignoreFocusOut: true,
  })
  return picked?.optionId
}
