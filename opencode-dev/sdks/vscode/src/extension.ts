import * as vscode from "vscode"
import * as path from "node:path"
import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import { structuredPatch } from "diff"
import { createAcpConnected, formatPermissionTitle, promptPermissionChoice } from "./acpTransport"

const BUILD_MARKER = "opencode-vscode-build-marker:baseline-fix-2026-02-11"

export function deactivate() {}

const TERMINAL_NAME = "opencode"
const AUTH_TERMINAL_NAME = "opencode: auth"
const AUTH_LOGOUT_TERMINAL_NAME = "opencode: auth logout"
const MODELS_TERMINAL_NAME = "opencode: models"
const CHAT_VIEW_TYPE = "opencode.chat"
const CHAT_SIDEBAR_VIEW_ID = "opencode.chatView"
const LAST_SERVER_BASE_URL_KEY = "opencode.lastServerBaseUrl"
const DID_AUTO_MOVE_TO_SECONDARY_SIDEBAR_KEY = "opencode.didAutoMoveToSecondarySidebar"
const ACTIVE_AGENT_PROFILE_ID_KEY = "opencode.activeAgentProfileId"
const VISIBLE_MODEL_IDS_KEY = "opencode.visibleModelIds"
const LEGACY_SUMMARY_MODEL_ID_KEY = "opencode.summaryModelId"
const DID_PRUNE_LEGACY_SUMMARY_MODEL_ID_KEY = "opencode.didPruneLegacySummaryModelId"

type LmModelInfo = { id: string; name?: string; vendor?: string; rightText?: string }

function normalizeOneLine(textRaw: unknown, maxChars: number): string {
  const s = String(textRaw ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  if (!s) return ""
  if (s.length <= maxChars) return s
  return s.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "…"
}

function safeTruncateList(items: string[], maxItems: number): string[] {
  const out: string[] = []
  for (const it of Array.isArray(items) ? items : []) {
    const s = String(it ?? "").trim()
    if (!s) continue
    out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

function recordTurnStep(state: ChatRuntimeState, textRaw: string) {
  const text = normalizeOneLine(textRaw, 200)
  if (!text) return
  if (!state.turnSummarySteps) state.turnSummarySteps = []
  const prev = state.turnSummarySteps
  if (prev.includes(text)) return
  prev.push(text)
  // Keep memory bounded.
  if (prev.length > 24) prev.splice(0, prev.length - 24)
}

function formatToolStepForSummary(toolNameRaw: unknown, inputAny: any, ok: boolean | undefined): string {
  const toolName = String(toolNameRaw ?? "tool").trim() || "tool"
  const t = toolName.toLowerCase()

  const getFilePath = (): string => {
    const fp =
      (typeof inputAny?.filePath === "string" && inputAny.filePath) ||
      (typeof inputAny?.path === "string" && inputAny.path) ||
      (typeof inputAny?.targetPath === "string" && inputAny.targetPath) ||
      ""
    return String(fp ?? "").trim()
  }

  const getQuery = (): string => (typeof inputAny?.query === "string" ? String(inputAny.query).trim() : "")
  const getCmd = (): string => (typeof inputAny?.command === "string" ? String(inputAny.command).trim() : "")

  const filePath = getFilePath()
  const fileBase = filePath ? filePath.replaceAll("\\", "/").split("/").pop() || filePath : ""

  const verb = ok === false ? "失败" : ok === true ? "完成" : ""

  if (t.includes("read") || t.includes("read_file") || t === "read" || t === "fs.read") {
    return fileBase ? `读取 ${fileBase}${verb ? `（${verb}）` : ""}` : `读取文件${verb ? `（${verb}）` : ""}`
  }

  if (t.includes("write") || t.includes("apply_patch") || t.includes("edit") || t.includes("write_file") || t === "write" || t === "fs.write") {
    return fileBase ? `修改 ${fileBase}${verb ? `（${verb}）` : ""}` : `修改文件${verb ? `（${verb}）` : ""}`
  }

  if (t.includes("grep") || t.includes("search") || t.includes("file_search") || t.includes("glob")) {
    const q = normalizeOneLine(getQuery(), 80)
    return q ? `搜索 “${q}”${verb ? `（${verb}）` : ""}` : `搜索${verb ? `（${verb}）` : ""}`
  }

  if (t.includes("terminal") || t.includes("run")) {
    const cmd = normalizeOneLine(getCmd(), 120)
    return cmd ? `运行 ${cmd}${verb ? `（${verb}）` : ""}` : `运行命令${verb ? `（${verb}）` : ""}`
  }

  return `${toolName}${verb ? `（${verb}）` : ""}`
}

async function generateTurnSummaryViaCli(modelId: string, prompt: string, timeoutMs: number): Promise<string> {
  const args = ["run", "--format", "json", "--model", modelId, prompt]
  const r = await execOpencodeCli(args, { timeoutMs })
  const lines = String(r.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  let lastText = ""
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (obj && obj.type === "text" && obj.part && typeof obj.part.text === "string") {
        lastText = String(obj.part.text)
      }
    } catch {
      // ignore
    }
  }

  return normalizeOneLine(lastText, 32)
}

async function maybeGenerateAndPostTurnSummary(post: (m: WebviewOutboundMessage) => void, state: ChatRuntimeState) {
  const seq = state.turnSeq
  if (typeof seq !== "number") return
  if (!state.turnUserText) return

  const modelId = String(state.selectedModelId || "").trim()
  if (!modelId) return

  const userText = normalizeOneLine(state.turnUserText, 220)
  const steps = safeTruncateList(state.turnSummarySteps || [], 10)
  const stepsText = steps.length ? normalizeOneLine(steps.join("；"), 220) : "（无）"
  const changedFiles = (() => {
    const diffs = Array.isArray(state.lastSessionDiffs) ? state.lastSessionDiffs : []
    const files = diffs
      .map((d: any) => String(d?.file ?? "").trim())
      .filter(Boolean)
      .slice(0, 8)
    return files
  })()

  const prompt = [
    "你是代码助手。请生成用于 UI 完成标题的中文一句话总结。",
    "硬性要求：只输出一句话；不要换行；不要列表；不要引号；不要表情符号。",
    "长度要求：18~28 个汉字为宜，最多 32 个字符。",
    "措辞要求：以动词短语开头；不要出现‘我/我们/你’；不要出现‘已完成/完成/成功/失败’。",
    "",
    `用户请求：${userText}`,
    `关键步骤：${stepsText}`,
    changedFiles.length ? `涉及文件：${changedFiles.join(", ")}` : "涉及文件：（未知）",
  ].join("\n")

  try {
    const summary = await generateTurnSummaryViaCli(modelId, prompt, 30_000)
    // Only post if we're still on the same turn.
    if (state.turnSeq !== seq) return
    if (summary) post({ type: "chatTurnSummary", text: summary, modelId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logLine(state, `turn summary failed: ${message}`)
  }
}

// Shared cache so Settings can show models even when transport=acp.
let lastKnownLmModels: LmModelInfo[] = []
let lastKnownLmModelsStatus = ""

function normalizeStringIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of value) {
    const id = String(v ?? "").trim()
    if (!id) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

function getStoredVisibleModelIds(context: vscode.ExtensionContext): string[] {
  return normalizeStringIdList(context.globalState.get<any>(VISIBLE_MODEL_IDS_KEY))
}

function getEffectiveVisibleModelIds(context: vscode.ExtensionContext, allModels: LmModelInfo[]): string[] {
  const stored = getStoredVisibleModelIds(context)
  const allIds = allModels.map((m) => String(m?.id ?? "").trim()).filter(Boolean)
  if (!stored.length) return allIds
  const allow = new Set(stored)
  return allIds.filter((id) => allow.has(id))
}

async function setStoredVisibleModelIds(context: vscode.ExtensionContext, visibleIds: string[]): Promise<void> {
  const next = normalizeStringIdList(visibleIds)
  await context.globalState.update(VISIBLE_MODEL_IDS_KEY, next)
}

function noteLastKnownLmModels(models: LmModelInfo[], status: string) {
  lastKnownLmModels = Array.isArray(models) ? models.slice() : []
  lastKnownLmModelsStatus = String(status ?? "").trim()
}

function getBestCwdForOpencode(): string {
  const preferred = getDirectoryQuery()
  if (preferred && typeof preferred === "string") {
    try {
      if (fs.existsSync(preferred)) return preferred
    } catch {
      // ignore
    }
  }

  const ws = vscode.workspace.workspaceFolders?.[0]
  if (ws?.uri?.fsPath) {
    try {
      if (fs.existsSync(ws.uri.fsPath)) return ws.uri.fsPath
    } catch {
      // ignore
    }
  }

  return process.cwd()
}

async function execOpencodeCli(args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const cwd = opts?.cwd || getBestCwdForOpencode()
  const timeoutMs = typeof opts?.timeoutMs === "number" ? opts!.timeoutMs : 12000

  const cmd = (process.env.OPENCODE_BIN_PATH && String(process.env.OPENCODE_BIN_PATH).trim()) || "opencode"
  const env = { ...process.env, OPENCODE_CALLER: "vscode" }

  return await new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false

    const child = childProcess.spawn(cmd, args, {
      cwd,
      env,
      windowsHide: true,
    })

    const settle = (exitCode: number | null) => {
      if (settled) return
      settled = true
      resolve({ stdout, stderr, exitCode })
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      settle(null)
    }, timeoutMs)

    child.stdout?.on("data", (d: any) => {
      stdout += String(d ?? "")
    })
    child.stderr?.on("data", (d: any) => {
      stderr += String(d ?? "")
    })
    child.on("error", (e: any) => {
      stderr += String((e as any)?.message ?? e)
      try {
        clearTimeout(timer)
      } catch {
        // ignore
      }
      settle(1)
    })
    child.on("close", (code: any) => {
      try {
        clearTimeout(timer)
      } catch {
        // ignore
      }
      settle(typeof code === "number" ? code : null)
    })
  })
}

function parseModelsFromOpencodeModelsStdout(stdoutRaw: string): LmModelInfo[] {
  const lines = String(stdoutRaw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  const seen = new Set<string>()
  const out: LmModelInfo[] = []
  for (const line of lines) {
    // CLI prints `provider/model` per line.
    const id = line
    if (!id || seen.has(id)) continue
    seen.add(id)

    const slash = id.indexOf("/")
    const vendor = slash > 0 ? id.slice(0, slash) : ""
    const name = slash > 0 ? id.slice(slash + 1) : id
    out.push({ id, name, vendor })
  }
  return out
}

async function getModelsViaCliFallback(statusPrefix: string, opts?: { force?: boolean }): Promise<LmModelInfo[]> {
  const cached = Array.isArray(lastKnownLmModels) ? lastKnownLmModels : []
  if (!opts?.force && cached.length) return cached

  try {
    const r = await execOpencodeCli(["models"], { timeoutMs: 15000 })
    const models = parseModelsFromOpencodeModelsStdout(r.stdout)
    if (models.length) noteLastKnownLmModels(models, `${statusPrefix} · cli(opencode models) · models=${models.length}`)
    return models
  } catch {
    return cached
  }
}

function filterLmModelsForChat(context: vscode.ExtensionContext, allModels: LmModelInfo[]): { filtered: LmModelInfo[]; visibleIds: string[] } {
  const visibleIds = getEffectiveVisibleModelIds(context, allModels)
  if (!visibleIds.length) return { filtered: [], visibleIds: [] }
  const allow = new Set(visibleIds)
  return {
    filtered: allModels.filter((m) => allow.has(String(m?.id ?? "").trim())),
    visibleIds,
  }
}

function getSettingsHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const nonce = getNonce()
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "settings.css"))
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "settings.js"))

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} https:; font-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>OpenCode Settings</title>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="sidebarTitle">OpenCode Settings</div>
      <button class="navItem active" data-page="models">
        <span class="codicon codicon-symbol-property"></span>
        <span>Models</span>
      </button>
      <button class="navItem" data-page="customAgents">
        <span class="codicon codicon-person"></span>
        <span>Custom Agents</span>
      </button>
      <button class="navItem" data-page="tools">
        <span class="codicon codicon-tools"></span>
        <span>Tools & MCP</span>
      </button>
    </aside>
    <main class="main">
      <section class="page" data-page="models">
        <div class="header">
          <h1 class="h1">Models</h1>
        </div>
        <div class="section">
          <div class="sectionTitle">Provider Status</div>
          <div class="authBox">
            <div class="authHeaderRow">
              <div class="authKey">Status</div>
              <button id="copilotDirectAuthToggle" class="ghost small">Show</button>
            </div>
            <div id="copilotDirectAuthDetails" class="authDetails hidden">
              <div id="copilotDirectAuthText" class="authValue">Loading...</div>
              <div id="copilotDirectAuthHint" class="modelMeta authHint"></div>
              <div id="modelsStatus" class="modelMeta"></div>
            </div>
          </div>
          <div class="actionBox">
            <div class="actionHeader">Actions</div>
            <div class="actionButtons">
              <button id="copilotDirectAuthRefresh" class="ghost">Refresh</button>
              <button id="copilotDirectReloginMinimal" class="ghost">Clear + Re-login (minimal)</button>
              <button id="copilotDirectReloginPermissive" class="ghost">Clear + Re-login (permissive)</button>
              <button id="copilotDirectSignOut" class="ghost">Sign out</button>
            </div>
          </div>
        </div>
        <div class="searchRow">
          <input id="search" class="search" placeholder="Add or search model" />
          <button id="refresh" class="iconButton" title="Refresh">
            <span class="codicon codicon-refresh"></span>
          </button>
        </div>
        <div id="modelList" class="list"></div>
      </section>

      <section class="page hidden" data-page="customAgents">
        <div class="header">
          <h1 class="h1">Custom Agents</h1>
        </div>
        <div class="section">
          <div class="modelMeta">
            在工作区的 <b>.github/agents</b> 目录下创建 <code>*.agent.md</code> 文件，并在 YAML frontmatter 中配置 <code>name</code>/<code>description</code>/<code>tools</code>/<code>model</code> 等字段。<br />
            OpenCode 会扫描 <code>.github/agents/**/*.agent.md</code>（也会兼容旧格式 <code>.github/chatmodes/**/*.chatmode.md</code>）。
          </div>
          <div class="inlineForm">
            <input id="customAgentFileBase" class="text" placeholder="file base name (e.g. planner)" />
            <div></div>
            <div></div>
            <button id="customAgentCreate" class="primary">Create</button>
          </div>
          <button id="customAgentRefresh" class="iconButton" title="Refresh">
            <span class="codicon codicon-refresh"></span>
          </button>
          <div id="customAgentList" class="list"></div>
        </div>
      </section>

      <section class="page hidden" data-page="tools">
        <div class="header">
          <h1 class="h1">Tools & MCP</h1>
        </div>
        <div class="section">
          <div class="sectionTitle">Agent Profiles</div>
          <div class="modelMeta">
            profiles 是扩展侧自定义的“模式配置”。
          </div>
          <div class="profileRow">
            <select id="agentProfileSelect" class="select"></select>
            <button id="agentProfileRemove" class="ghost">Remove</button>
          </div>
          <div class="row" style="margin-top: 10px;">
            <div>
              <div class="modelName">跟随当前聊天 Profile</div>
              <div class="modelMeta">从 Chat 打开 Tools Settings / 切换 Profile 时，自动对齐到当前对话的 Profile。</div>
            </div>
            <label class="toggle" title="开启后，Settings 会自动切换到当前聊天 Profile">
              <input id="followChatProfile" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="row" style="margin-top: 8px;">
            <div>
              <div class="modelName">Settings 选择 Profile 同步到 Chat</div>
              <div class="modelMeta">可选：在 Settings 下拉切 Profile 时，同时切换当前聊天的 Profile。</div>
            </div>
            <label class="toggle" title="开启后，Settings 的 profile 下拉会同步影响当前聊天 profile">
              <input id="syncChatProfileFromSettings" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="row" style="margin-top: 8px;">
            <div>
              <div class="modelName">Edits Healing（保守兜底）</div>
              <div class="modelMeta">replace-string edits 找不到 oldString 时，允许用“最相似且唯一”的片段自动重试一次。</div>
            </div>
            <label class="toggle" title="开启后，apply_patch.edits 会在 oldString 不匹配时进行一次保守重试">
              <input id="editsEnableHealing" type="checkbox" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="row" style="margin-top: 8px;">
            <div>
              <div class="modelName">Edits Healing（当前 Profile）</div>
              <div class="modelMeta">可选：为当前 Profile 单独配置（优先级高于全局设置）。</div>
            </div>
            <div class="rowRight" style="gap: 8px;">
              <select id="profileEditsEnableHealingMode" class="select" title="inherit = 使用全局设置；on/off = 覆盖全局设置">
                <option value="inherit">inherit</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            </div>
          </div>
          <div class="inlineForm profileAdd">
            <input id="agentProfileId" class="text" placeholder="id (e.g. my-agent)" />
            <input id="agentProfileName" class="text" placeholder="name (e.g. my agent)" />
            <div></div>
            <button id="agentProfileAdd" class="primary">Add</button>
          </div>
        </div>

        <div class="section">
          <div class="sectionTitle">Built-in Tools</div>
          <div id="builtinTools" class="list"></div>
        </div>

        <div class="section">
          <div class="sectionTitle">Extension Tools (Commands)</div>
          <div id="commandTools" class="list"></div>
          <div class="inlineForm">
            <input id="cmdToolName" class="text" placeholder="tool name (e.g. myTool)" />
            <input id="cmdToolCommand" class="text" placeholder="command id (e.g. workbench.action...)" />
            <input id="cmdToolDesc" class="text" placeholder="description (optional)" />
            <button id="cmdToolAdd" class="primary">Add</button>
          </div>
          <div class="inlineForm" style="margin-top: 8px;">
            <input id="cmdDiscoverQuery" class="text" placeholder="discover commands (query)" />
            <button id="cmdDiscover" class="ghost">Discover</button>
          </div>
          <div id="cmdDiscoverList" class="list"></div>
        </div>

        <div class="section">
          <div class="sectionTitle">MCP Servers</div>
          <div class="modelMeta">配置并启用 MCP servers。</div>
          <button id="mcpRefresh" class="iconButton" title="Refresh">
            <span class="codicon codicon-refresh"></span>
          </button>
          <div id="mcpServers" class="list"></div>
          <div class="inlineForm" style="margin-top: 12px;">
            <input id="mcpId" class="text" placeholder="id (e.g. docs)" />
            <input id="mcpName" class="text" placeholder="name (e.g. Docs)" />
            <select id="mcpTransport" class="select">
              <option value="stdio">stdio</option>
              <option value="sse">sse</option>
            </select>
            <input id="mcpUrl" class="text" placeholder="url (for sse)" />
            <input id="mcpCommand" class="text" placeholder="command (for stdio)" />
            <input id="mcpArgs" class="text" placeholder='args JSON (e.g. ["--flag"])' />
            <button id="mcpAdd" class="primary">Add</button>
          </div>
        </div>
      </section>
    </main>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}

class OpencodeSettingsPanel {
  static current: OpencodeSettingsPanel | undefined

  private readonly panel: vscode.WebviewPanel
  private readonly context: vscode.ExtensionContext
  private didInit = false

  static show(context: vscode.ExtensionContext, opts?: { initialPage?: "models" | "tools" | "customAgents" }) {
    const existing = OpencodeSettingsPanel.current
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn)
      const page = opts?.initialPage
      if (page) existing.post({ type: "setPage", page })
      return
    }

    const panel = vscode.window.createWebviewPanel(
      "opencode.settings",
      "OpenCode Settings",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    )

    OpencodeSettingsPanel.current = new OpencodeSettingsPanel(context, panel)
    if (opts?.initialPage) {
      OpencodeSettingsPanel.current.post({ type: "setPage", page: opts.initialPage })
    }
  }

  private constructor(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
    this.context = context
    this.panel = panel
    panel.webview.html = getSettingsHtml(context, panel.webview)

    panel.onDidDispose(() => {
      if (OpencodeSettingsPanel.current === this) OpencodeSettingsPanel.current = undefined
    })

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      const type = String(msg?.type ?? "").trim()
      if (!type) return

      if (type === "webviewReady") {
        await this.refreshAndPost({ init: true })
        return
      }

      if (type === "refreshModels") {
        await this.refreshAndPost({ init: false, forceProviderFetch: true })
        return
      }

      if (type === "toggleModel") {
        const id = String(msg?.id ?? "").trim()
        const enabled = Boolean(msg?.enabled)
        if (!id) return
        await this.toggleModel(id, enabled)
        return
      }
    })
  }

  private post(msg: any) {
    try {
      this.panel.webview.postMessage(msg)
    } catch {
      // ignore
    }
  }

  private async refreshAndPost(opts: { init: boolean; forceProviderFetch?: boolean }) {
    const models = await this.getAllModels({ forceProviderFetch: Boolean(opts.forceProviderFetch) })
    const visibleIds = getEffectiveVisibleModelIds(this.context, models)
    const payload = {
      type: opts.init ? "init" : "update",
      models,
      visibleModelIds: visibleIds,
      modelsStatus: lastKnownLmModelsStatus || this.getModelsStatusFallback(models),
    }
    this.didInit = true
    this.post(payload)
  }

  private async getAllModels(opts?: { forceProviderFetch?: boolean }): Promise<LmModelInfo[]> {
    // Best-effort: prefer in-memory cache (works for ACP), but allow fetching /provider
    // when running with http+sse.
    const cached = Array.isArray(lastKnownLmModels) ? lastKnownLmModels : []
    if (cached.length && !opts?.forceProviderFetch) return cached

    if (getTransportMode() === "acp") {
      // ACP-only: prefer session-provided models, but fall back to `opencode models` so
      // Settings can still show a list even when ACP's newSession omits model metadata.
      const viaCli = await getModelsViaCliFallback("acp", { force: Boolean(opts?.forceProviderFetch) })
      return viaCli
    }

    try {
      const baseUrl = getServerBaseUrl()
      const url = new URL("/provider", baseUrl)
      const res = await fetchWithTimeout(url, { method: "GET" }, 8000)
      if (!res.ok) return cached
      const json = (await res.json()) as any
      const providers: any[] = Array.isArray(json?.all) ? json.all : []
      const connected = new Set<string>(Array.isArray(json?.connected) ? json.connected.map((x: any) => String(x)) : [])

      const models: LmModelInfo[] = []
      for (const p of providers) {
        const providerID = String(p?.id ?? "").trim()
        if (!providerID) continue
        const providerName = String(p?.name ?? providerID).trim()
        const providerModels = p?.models && typeof p.models === "object" ? p.models : {}
        const isConnected = connected.has(providerID)
        const keys = Object.keys(providerModels).sort((a, b) => a.localeCompare(b))
        for (const modelID of keys) {
          const meta = providerModels[modelID]
          const displayName = String(meta?.name ?? modelID).trim()
          models.push({
            id: `${providerID}/${modelID}`,
            name: displayName,
            vendor: providerName,
            rightText: isConnected ? "" : "未登录",
          })
        }
      }

      noteLastKnownLmModels(models, `http+sse · providers=${providers.length} · models=${models.length}`)
      return models
    } catch {
      return cached
    }
  }

  private getModelsStatusFallback(models: LmModelInfo[]): string {
    const mode = getTransportMode()
    if (mode === "acp") return `acp · models=${models.length}`
    return `http+sse · server=${getServerBaseUrl()} · models=${models.length}`
  }

  private async toggleModel(id: string, enabled: boolean) {
    const all = await this.getAllModels()
    const allIds = all.map((m) => String(m?.id ?? "").trim()).filter(Boolean)
    if (!allIds.length) return

    const effective = new Set(getEffectiveVisibleModelIds(this.context, all))

    if (enabled) {
      effective.add(id)
    } else {
      effective.delete(id)
    }

    if (effective.size === 0) {
      // Keep at least one model enabled.
      effective.add(id)
      vscode.window.showInformationMessage("至少需要启用一个模型。")
    }

    // Store: [] means "all models visible".
    const nextEffective = Array.from(effective)
    const isAll = nextEffective.length === allIds.length && allIds.every((x) => effective.has(x))
    const stored = isAll ? [] : nextEffective.sort((a, b) => a.localeCompare(b))
    await setStoredVisibleModelIds(this.context, stored)

    // Update settings webview UI.
    await this.refreshAndPost({ init: !this.didInit })
  }
}

// Copilot-like: the chat UI has a single session-level "Files changed" bar.
// It should represent ALL pending edits across multiple turns/requestIds.
const EDITS_REVIEW_SESSION_ID = "opencode:edits:pending"

type EditHunkNav = {
  index: number
  oldStartLine0: number
  oldLineCount: number
  newStartLine0: number
  newEndLine0: number
  newLineCount: number
  oldLinesText: string[]
  newLinesText: string[]
}

const editNavByUri = new Map<string, { hunks: EditHunkNav[]; requestId?: string; file?: string; fileKey?: string; beforeText?: string }>()
let activeEditNav: { uriKey: string; index: number } | null = null
let editNavAllDeco: vscode.TextEditorDecorationType | undefined
let editNavActiveDeco: vscode.TextEditorDecorationType | undefined
let editNavCodeLensEmitter: vscode.EventEmitter<void> | undefined
let editNavOverlayFallbackDeco: vscode.TextEditorDecorationType | undefined
let editNavBlockOverlayDeco: vscode.TextEditorDecorationType | undefined

// Copilot-like: allow the editor status bar actions to appear even when the user
// opens a changed file manually (not via the chat "open diff" action).
const editNavPendingDiffByUri = new Map<string, { requestId: string; file: string; before: string; after: string }>()
const editNavPendingUrisByRequestId = new Map<string, Set<string>>()

let editsDevLogEnabled = false
let editsDevLogVerbose = false

let terminalAutoApproveDevLogEnabled = false
let terminalAutoApproveDevLogVerbose = false

let lastEditsCmdWarnAt = 0
let lastEditsCmdWarnMsg = ""

let lastEditsCmdInfoAt = 0
let lastEditsCmdInfoMsg = ""

function infoEditsCmd(state: any, msg: string) {
  try {
    const now = Date.now()
    if (msg === lastEditsCmdInfoMsg && now - lastEditsCmdInfoAt < 2_000) return
    lastEditsCmdInfoAt = now
    lastEditsCmdInfoMsg = msg
    logLine(state, `[edits-cmd] ${msg}`)
  } catch {
    // ignore
  }
}

function warnEditsCmd(state: any, msg: string) {
  try {
    const now = Date.now()
    if (msg === lastEditsCmdWarnMsg && now - lastEditsCmdWarnAt < 10_000) return
    lastEditsCmdWarnAt = now
    lastEditsCmdWarnMsg = msg
    logLine(state, `[edits-cmd] ${msg}`)
  } catch {
    // ignore
  }
}

function pickEditorForEditsCommand(): vscode.TextEditor | undefined {
  try {
    const active = vscode.window.activeTextEditor
    if (active) return active
  } catch {
    // ignore
  }

  try {
    const uriKey = activeEditNav?.uriKey
    if (uriKey) {
      const match = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriKey)
      if (match) return match
    }
  } catch {
    // ignore
  }

  try {
    const visible = vscode.window.visibleTextEditors
    if (!visible?.length) return undefined

    // If there's exactly one pending diff, prefer that file's editor.
    try {
      if (editNavPendingDiffByUri.size === 1) {
        const onlyUriKey = Array.from(editNavPendingDiffByUri.keys())[0]
        const match = visible.find((e) => e.document.uri.toString() === onlyUriKey)
        if (match) return match
      }
    } catch {
      // ignore
    }

    // Prefer editors that already have a nav with hunks.
    const withNav = visible.filter((e) => {
      const k = e.document.uri.toString()
      const nav = editNavByUri.get(k)
      return Boolean(nav?.hunks?.length)
    })
    if (withNav.length === 1) return withNav[0]
    if (withNav.length > 1) return withNav[0]

    // Next prefer editors that have a pending diff (can be attached).
    const withPending = visible.filter((e) => {
      const k = e.document.uri.toString()
      return Boolean(editNavPendingDiffByUri.get(k))
    })
    if (withPending.length === 1) return withPending[0]
    if (withPending.length > 1) return withPending[0]

    return visible[0]
  } catch {
    return undefined
  }
}

function isTruthyEnv(v: unknown) {
  const s = String(v ?? "").trim().toLowerCase()
  return s === "1" || s === "true" || s === "yes" || s === "on"
}

function safeJsonForLog(value: any, maxLen = 4000) {
  try {
    const s = JSON.stringify(value)
    if (typeof s !== "string") return ""
    if (s.length <= maxLen) return s
    return s.slice(0, maxLen) + `…(+${s.length - maxLen} chars)`
  } catch {
    return ""
  }
}

function editsDevLog(msg: string, data?: any, opts?: { verbose?: boolean }) {
  try {
    const verbose = Boolean(opts?.verbose)
    if (!editsDevLogEnabled) return
    if (verbose && !editsDevLogVerbose) return
    const out = getChatOutputChannel()
    const extra = typeof data === "undefined" ? "" : " " + safeJsonForLog(data)
    out.appendLine(`[edits-dev] ${msg}${extra}`)
  } catch {
    // ignore
  }
}

function terminalAutoApproveDevLog(msg: string, data?: any, opts?: { verbose?: boolean }) {
  try {
    const verbose = Boolean(opts?.verbose)
    if (!terminalAutoApproveDevLogEnabled) return
    if (verbose && !terminalAutoApproveDevLogVerbose) return
    const out = getChatOutputChannel()
    const extra = typeof data === "undefined" ? "" : " " + safeJsonForLog(data)
    out.appendLine(`[terminal-autoapprove] ${msg}${extra}`)
  } catch {
    // ignore
  }
}

function getEditsDebugSnapshot(uriKey: string) {
  try {
    const nav = editNavByUri.get(uriKey)
    const pending = editNavPendingDiffByUri.get(uriKey)
    const fileKey = nav?.fileKey ?? editFileKeyByUriKey.get(uriKey)
    const chain = fileKey ? editPendingRequestIdsByFileKey.get(fileKey) : undefined
    const fileInsetRid = editFileOverlayRequestIdByUri.get(uriKey)
    const blockInsetRid = editBlockOverlayRequestIdByUri.get(uriKey)
    const fileInsetLine = editFileOverlayByUri.get(uriKey)?.line
    const blockInsetsCount = editBlockOverlaysByUri.get(uriKey)?.size
    const activeIndex = activeEditNav?.uriKey === uriKey ? activeEditNav.index : undefined

    return {
      uriKey,
      nav: nav
        ? { requestId: nav.requestId, file: nav.file, fileKey: nav.fileKey, hunks: nav.hunks?.length ?? 0, beforeLen: nav.beforeText?.length ?? 0 }
        : null,
      pending: pending ? { requestId: pending.requestId, file: pending.file, beforeLen: pending.before?.length ?? 0, afterLen: pending.after?.length ?? 0 } : null,
      fileKey,
      chain,
      overlays: { fileInsetRid, blockInsetRid, fileInsetLine, blockInsetsCount },
      activeIndex,
    }
  } catch {
    return { uriKey, error: true }
  }
}

// Copilot-like: a file can accumulate pending edits across multiple turns.
// Track the requestIds that contributed edits to a given file, and the earliest baseline
// (text before the first pending edit was applied) for stable hunks/highlights.
const editPendingRequestIdsByFileKey = new Map<string, string[]>()
const editPendingBaselineByFileKey = new Map<string, string>()
// Full-document snapshot representing a "reviewed" (accepted/clean) state.
// Used as a stable baseline for the next edit turn when ACP diff.before is fragmented.
const editLastReviewedDocTextByFileKey = new Map<string, string>()
const editLastKnownDocTextByFileKey = new Map<string, string>()
const editFileKeyByUriKey = new Map<string, string>()

// Short-circuit helper: after a file is reverted back to its pending baseline (clean state),
// record a lightweight signature for a short window so we can avoid triggering ACP tool spam
// when the user immediately asks to "delete the random content" that has already been undone.
type RecentCleanBaselineSig = { atMs: number; fileKey: string; uriKey: string; sig: string; why: string }
const recentCleanBaselineSigByFileKey = new Map<string, RecentCleanBaselineSig>()
const RECENT_CLEAN_BASELINE_WINDOW_MS = 2 * 60 * 1000

function fastTextSig(text: string): string {
  const hashString = (input: string): number => {
    // Fast non-crypto hash (djb2 variant) for change detection.
    let h = 5381
    for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i)
    return h >>> 0
  }

  // Normalize line endings so signatures match between editor text (\n)
  // and disk reads on Windows (\r\n).
  const s = String(text ?? "").replace(/\r/g, "")
  const head = s.slice(0, 1024)
  const tail = s.length > 1024 ? s.slice(-1024) : ""
  return `${s.length}:${hashString(head + "\n" + tail)}`
}

function noteRecentCleanBaselineSig(fileKeyRaw: string, uriKeyRaw: string, baselineText: string, why: string) {
  try {
    const fileKey = String(fileKeyRaw ?? "").trim()
    const uriKey = String(uriKeyRaw ?? "").trim()
    if (!fileKey || !uriKey) return
    const now = Date.now()
    recentCleanBaselineSigByFileKey.set(fileKey, { atMs: now, fileKey, uriKey, sig: fastTextSig(baselineText), why })

    // Prune old entries opportunistically.
    for (const [fk, v] of Array.from(recentCleanBaselineSigByFileKey.entries())) {
      if (!v?.atMs || now - v.atMs > RECENT_CLEAN_BASELINE_WINDOW_MS) recentCleanBaselineSigByFileKey.delete(fk)
    }
  } catch {
    // ignore
  }
}

function pickRecentCleanBaselineCandidate(opts?: { preferredFileKey?: string }): RecentCleanBaselineSig | undefined {
  try {
    const now = Date.now()
    const preferred = String(opts?.preferredFileKey ?? "").trim()
    if (preferred) {
      const v = recentCleanBaselineSigByFileKey.get(preferred)
      if (v && now - v.atMs <= RECENT_CLEAN_BASELINE_WINDOW_MS) return v
    }

    let best: RecentCleanBaselineSig | undefined
    for (const v of Array.from(recentCleanBaselineSigByFileKey.values())) {
      if (!v?.atMs) continue
      if (now - v.atMs > RECENT_CLEAN_BASELINE_WINDOW_MS) continue
      if (!best || v.atMs > best.atMs) best = v
    }
    return best
  } catch {
    return undefined
  }
}

function isDeleteRecentlyAddedRandomContentRequest(textRaw: string): boolean {
  const t = String(textRaw ?? "").trim()
  if (!t) return false
  // Keep this strict to avoid interfering with unrelated prompts.
  return /^删除刚才增加的随机内容[\s。.!！?？]*$/.test(t)
}

// ACP fallback: stable "before" snapshots per requestId.
// Some tool runtimes write to documents before we can establish a pending chain,
// which can accidentally overwrite lastReviewed with "after".
// This cache is populated from read/tool snapshots and used to synthesize diffs.
const acpStableBeforeByRequestId = new Map<string, Map<string, string>>()

function getStableBeforeForRequest(requestId: string | undefined, fileKey: string): string | undefined {
  try {
    const rid = String(requestId ?? "").trim()
    if (!rid) return undefined
    const fk = String(fileKey ?? "").trim()
    if (!fk) return undefined
    return acpStableBeforeByRequestId.get(rid)?.get(fk)
  } catch {
    return undefined
  }
}

function noteStableBeforeForRequest(requestId: string | undefined, fileKey: string, text: string) {
  try {
    const rid = String(requestId ?? "").trim()
    if (!rid) return
    const fk = String(fileKey ?? "").trim()
    if (!fk) return
    const m = acpStableBeforeByRequestId.get(rid) ?? new Map<string, string>()
    if (!m.has(fk)) m.set(fk, String(text ?? ""))
    acpStableBeforeByRequestId.set(rid, m)
  } catch {
    // ignore
  }
}

function noteLastKnownDocText(fileKey: string | undefined, docText: string) {
  try {
    const fk = String(fileKey ?? "").trim()
    if (!fk) return
    editLastKnownDocTextByFileKey.set(fk, docText)
  } catch {
    // ignore
  }
}

function noteLastReviewedDocText(fileKey: string | undefined, docText: string) {
  try {
    const fk = String(fileKey ?? "").trim()
    if (!fk) return
    editLastReviewedDocTextByFileKey.set(fk, docText)
  } catch {
    // ignore
  }
}

function removePendingForFileInRequest(uriKey: string, fileKey: string, requestId: string) {
  try {
    const rid = String(requestId ?? "").trim()
    if (!rid) return

    const cur = editNavPendingDiffByUri.get(uriKey)
    if (cur?.requestId === rid) editNavPendingDiffByUri.delete(uriKey)

    const set = editNavPendingUrisByRequestId.get(rid)
    if (set) {
      set.delete(uriKey)
      if (set.size === 0) editNavPendingUrisByRequestId.delete(rid)
      else editNavPendingUrisByRequestId.set(rid, set)
    }

    const chain = editPendingRequestIdsByFileKey.get(fileKey)
    if (chain && chain.length) {
      const next = chain.filter((x) => x !== rid)
      if (next.length) editPendingRequestIdsByFileKey.set(fileKey, next)
      else {
        editPendingRequestIdsByFileKey.delete(fileKey)
        editPendingBaselineByFileKey.delete(fileKey)
        // Preserve last-known full document text across keep/undo so the next
        // edit turn can compute hunks from a stable baseline even if ACP diff.before
        // is fragmented.
      }
    }

    editsDevLog("removePendingForFileInRequest", { uriKey, fileKey, requestId: rid, chain: editPendingRequestIdsByFileKey.get(fileKey) }, { verbose: true })
  } catch {
    // ignore
  }
}

function clearAllPendingForFileKeyAndUri(uriKeyRaw: string, fileKeyRaw: string, why: string) {
  try {
    const uriKey = String(uriKeyRaw ?? "").trim()
    const fileKey = String(fileKeyRaw ?? "").trim()
    if (!uriKey || !fileKey) return

    // Drop per-file pending chain/baseline.
    editPendingBaselineByFileKey.delete(fileKey)
    editPendingRequestIdsByFileKey.delete(fileKey)

    // Drop per-uri pending diff and detach from requestId -> uri sets.
    try {
      const p = editNavPendingDiffByUri.get(uriKey)
      if (p) {
        editNavPendingDiffByUri.delete(uriKey)
        const rid = String(p?.requestId ?? "").trim()
        if (rid) {
          const set = editNavPendingUrisByRequestId.get(rid)
          if (set) {
            set.delete(uriKey)
            if (set.size === 0) editNavPendingUrisByRequestId.delete(rid)
            else editNavPendingUrisByRequestId.set(rid, set)
          }
        }
      }
    } catch {
      // ignore
      editNavPendingDiffByUri.delete(uriKey)
    }

    // Clear any in-editor nav/overlays.
    clearEditNavForUriKey(uriKey)

    editsDevLog(
      "clearAllPendingForFileKeyAndUri",
      { uriKey, fileKey, why, pendingTotal: editNavPendingDiffByUri.size, chains: editPendingRequestIdsByFileKey.size },
      { verbose: true },
    )

    // If this was the last pending file, clear the session-level bar.
    try {
      postPendingEditsReviewBar()
    } catch {
      // ignore
    }
  } catch {
    // ignore
  }
}

let dispatchEditReviewActionFromEditor:
  | ((input: { requestId: string; action: "keep" | "undo"; file?: string }) => Promise<void>)
  | undefined

let editNavStatusItem: vscode.StatusBarItem | undefined
let editNavPrevItem: vscode.StatusBarItem | undefined
let editNavNextItem: vscode.StatusBarItem | undefined
let editNavKeepHunkItem: vscode.StatusBarItem | undefined
let editNavUndoHunkItem: vscode.StatusBarItem | undefined
let editNavKeepFileItem: vscode.StatusBarItem | undefined
let editNavUndoFileItem: vscode.StatusBarItem | undefined

let coreEditsOverlayReady = false
let coreEditsOverlayNextRetryAt = 0
let coreEditsOverlayLastErrorAt = 0
let coreEditsOverlayLastErrorMsg = ""

let coreEditsOverlaySupportsHunkOverlays = false

// We use the patched workbench “core” edits overlay for the Copilot-like floating UI.
// Any z-order issues (e.g. context menus) should be solved in the workbench injection.
const DISABLE_CORE_EDITS_OVERLAY = false

type CoreEditsOverlayHunkState = { index: number; line: number }
type CoreEditsOverlayState = {
  visible: boolean
  index?: number
  total?: number
  uri?: string
  hunks?: CoreEditsOverlayHunkState[]
}

// ACP tool-call baseline capture: some ACP tool runtimes do not emit diff blocks.
// To keep Copilot-like "Files changed" + hunks behavior, we compute diffs by
// snapshotting file contents before/after tool completion.
const acpToolFileBaselinesByToolCallId = new Map<
  string,
  Array<{ rawPath: string; relativePath: string; fileKey: string; before: string }>
>()

type AcpFsChangeKind = "create" | "change" | "delete"
type AcpFsChange = { kind: AcpFsChangeKind; at: number; fsPath: string }

// Fallback: when ACP doesn't provide diff blocks AND we can't infer file targets from rawInput,
// use workspace fs events observed while tools are running.
const acpFsChangesByToolCallId = new Map<string, Map<string, AcpFsChange>>()
const acpFsChangesByEditRequestId = new Map<string, Map<string, AcpFsChange>>()

let acpCaptureActiveEditRequestId: string | undefined
let acpCaptureRunningToolCallIds: Set<string> | undefined

function shouldIgnoreFsPathForAcpEdits(fsPathRaw: string): boolean {
  const p = String(fsPathRaw ?? "")
  if (!p) return true
  const norm = p.replaceAll("\\", "/").toLowerCase()
  if (norm.includes("/node_modules/")) return true
  if (norm.includes("/.git/")) return true
  if (norm.includes("/.svn/")) return true
  if (norm.includes("/.hg/")) return true
  if (norm.includes("/dist/")) return true
  if (norm.includes("/build/")) return true
  if (norm.includes("/out/")) return true
  if (norm.includes("/.turbo/")) return true
  if (norm.includes("/.next/")) return true
  return false
}

function getCandidateFilePathsFromPatchText(patchTextRaw: unknown): string[] {
  const patchText = typeof patchTextRaw === "string" ? patchTextRaw : ""
  if (!patchText.trim()) return []
  const out: string[] = []
  const re = /^\*\*\*\s+(Update|Add|Delete)\s+File:\s+(.+?)\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(patchText))) {
    const p = String(m[2] ?? "").trim()
    if (p) out.push(p)
  }
  return out
}

function getCandidateFilePathsFromToolOutput(outputRaw: unknown): string[] {
  const text = typeof outputRaw === "string" ? outputRaw : ""
  if (!text.trim()) return []
  const out: string[] = []
  const lines = text.split(/\r?\n/g)

  // Common tool outputs include VCS-like status lines:
  //   M path/to/file
  //   A path/to/file
  //   D path/to/file
  // as well as the opencode apply_patch summary.
  const re = /^\s*(?:[MADRCU?]|MM)\s+(.+?)\s*$/
  for (const line of lines) {
    const m = re.exec(line)
    if (!m) continue
    const p = String(m[1] ?? "").trim()
    if (!p) continue
    out.push(p)
  }

  // De-dupe while preserving order.
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const p of out) {
    const s = String(p ?? "").trim()
    if (!s) continue
    if (seen.has(s)) continue
    seen.add(s)
    uniq.push(s)
  }
  return uniq
}

function resolveCandidateFileUriBestEffort(rawPath: string, baseDirRaw?: string): vscode.Uri | undefined {
  try {
    let s = String(rawPath ?? "").trim()
    if (!s) return undefined

    // Strip simple surrounding quotes.
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1)
    }

    try {
      if (/^file:\/\//i.test(s)) return vscode.Uri.parse(s)
    } catch {
      // ignore
    }

    const baseDir = String(baseDirRaw ?? getDirectoryQuery() ?? process.cwd() ?? "").trim() || process.cwd()
    const root = (() => {
      try {
        return path.parse(baseDir).root || ""
      } catch {
        return ""
      }
    })()

    // Absolute paths.
    try {
      if (path.isAbsolute(s)) return vscode.Uri.file(path.normalize(s))
    } catch {
      // ignore
    }

    // Windows-specific: handle drive-relative paths that are missing the drive letter,
    // e.g. `OneDrive\Code\...`.
    try {
      if (process.platform === "win32" && root) {
        const win = path.win32
        const startsRootRelative = s.startsWith("\\") || s.startsWith("/")
        if (startsRootRelative) {
          const abs = win.join(root, s.replace(/^[\\/]+/, ""))
          return vscode.Uri.file(abs)
        }

        const looksDriveRelative = /^[^\\/:\s]+[\\/]/.test(s) && !s.startsWith(".") && !s.startsWith("..")
        if (looksDriveRelative) {
          const first = s.split(/[\\/]/)[0]?.toLowerCase?.() ?? ""
          const baseLower = baseDir.toLowerCase()
          const commonPrefixes = new Set(["onedrive", "users", "windows", "program files", "program files (x86)"])
          if (commonPrefixes.has(first) || (first && baseLower.includes(`\\${first}\\`))) {
            const abs = win.join(root, s)
            return vscode.Uri.file(abs)
          }
        }
      }
    } catch {
      // ignore
    }

    // Relative path.
    try {
      return vscode.Uri.file(path.resolve(baseDir, s))
    } catch {
      return undefined
    }
  } catch {
    return undefined
  }
}

async function synthesizeDiffsFromCandidates(requestId: string | undefined, candidatesRaw: string[], limit = 24): Promise<any[]> {
  const candidates = Array.from(new Set((Array.isArray(candidatesRaw) ? candidatesRaw : []).map((s) => String(s ?? "").trim()).filter(Boolean))).slice(0, limit)
  if (!candidates.length) return []
  const diffs: any[] = []
  for (const rawPath of candidates) {
    let uri = resolveCandidateFileUriBestEffort(rawPath, getDirectoryQuery())
    if (!uri) uri = resolveAnyFileUri(rawPath)
    if (!uri) {
      const relativePath = tryToRelativePath(rawPath)
      const fileLike = relativePath || rawPath
      uri = resolveProjectFileUri(fileLike, getDirectoryQuery(), { mustExist: false })
    }
    if (!uri) continue

    const fileKey = canonicalizeFileKey(uri.fsPath)
    if (!fileKey) continue

    const relativePath = tryToRelativePath(uri.fsPath)
    const fileLike = relativePath || String(rawPath ?? "").trim()
    if (!fileLike) continue

    // Prefer in-memory latest text when a file is open/dirty.
    // Many tool runtimes apply edits through the editor buffer without saving to disk.
    const afterFromKnown = editLastKnownDocTextByFileKey.get(fileKey)
    let afterFromOpen: string | undefined
    try {
      const open = vscode.workspace.textDocuments.find((d) => {
        try {
          const dk = d?.uri?.scheme === "file" ? canonicalizeFileKey(d.uri.fsPath) : ""
          return Boolean(dk) && dk === fileKey
        } catch {
          return false
        }
      })
      if (open) afterFromOpen = open.getText()
    } catch {
      // ignore
    }
    const stableBefore = requestId ? getStableBeforeForRequest(requestId, fileKey) : undefined
    const beforeText =
      (typeof stableBefore === "string" ? stableBefore : undefined) ??
      (typeof editLastReviewedDocTextByFileKey.get(fileKey) === "string" ? editLastReviewedDocTextByFileKey.get(fileKey) : undefined) ??
      (typeof editLastKnownDocTextByFileKey.get(fileKey) === "string" ? editLastKnownDocTextByFileKey.get(fileKey) : undefined) ??
      ""

    // Choose an after candidate that actually differs from the computed before.
    // This avoids "empty diffs" when apply_patch writes to disk but the open editor buffer
    // has not refreshed yet (buffer still equals before).
    let afterFromDisk: string | undefined
    try {
      const text = await readTextFileBestEffort(uri)
      if (typeof text === "string") afterFromDisk = text
    } catch {
      // ignore
    }

    const afterText = (() => {
      const open = typeof afterFromOpen === "string" ? afterFromOpen : undefined
      const known = typeof afterFromKnown === "string" ? afterFromKnown : undefined
      const disk = typeof afterFromDisk === "string" ? afterFromDisk : undefined

      if (typeof open === "string" && open !== beforeText) return open
      if (typeof known === "string" && known !== beforeText) return known
      if (typeof disk === "string" && disk !== beforeText) return disk
      return open ?? known ?? disk
    })()
    if (typeof afterText !== "string") continue

    if (beforeText === afterText) continue
    const stats = computeAddDelStats(beforeText, afterText)
    diffs.push({ file: fileLike, fileKey, additions: stats.additions, deletions: stats.deletions, before: beforeText, after: afterText })
  }
  return diffs
}

function getCandidateFilePathsFromToolInput(rawInput: any): string[] {
  const out: string[] = []

  const stripQuotes = (sRaw: string): string => {
    const s = String(sRaw ?? "").trim()
    if (!s) return ""
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
    return s
  }

  const extractFileWriteTargetsFromCommandLine = (lineRaw: string): string[] => {
    const line = String(lineRaw ?? "")
    if (!line.trim()) return []
    const results: string[] = []

    // Shell/PowerShell redirections: > file, >> file, 2> file, *>> file
    // Ignore stream merges like 2>&1.
    const redirRe = /(?:^|\s)(?:\*?\d*)>{1,2}\s*("[^"]+"|'[^']+'|[^\s|&;]+)(?!\s*&\d)/g
    for (const m of line.matchAll(redirRe)) {
      const t = stripQuotes(String(m[1] ?? "").trim())
      if (!t) continue
      if (/^&\d+$/.test(t)) continue
      if (/^(?:nul|\/dev\/null)$/i.test(t)) continue
      results.push(t)
    }

    // Common PowerShell file-writing cmdlets
    //   Out-File -FilePath x
    //   Set-Content -Path x
    //   Add-Content -Path x
    //   Tee-Object -FilePath x
    const psWriter = /(out-file|set-content|add-content|tee-object)\b/gi
    const pathArg = /-(filepath|path|literalpath)\s+("[^"]+"|'[^']+'|[^\s|&;]+)/gi
    if (psWriter.test(line)) {
      for (const m of line.matchAll(pathArg)) {
        const t = stripQuotes(String(m[2] ?? "").trim())
        if (!t) continue
        if (/^(?:nul|\/dev\/null)$/i.test(t)) continue
        results.push(t)
      }
    }

    // Python one-liners often write files without shell redirection, e.g.
    //   python -c "from pathlib import Path; Path('x.md').write_text('...', encoding='utf-8')"
    //   python -c "open('x.md','w',encoding='utf-8').write('...')"
    // Extract the obvious path literals.
    if (/\bpython\b/i.test(line) && /\s-c\s*/.test(line)) {
      const pyPathRe = /\b(?:Path|open)\(\s*("[^"]{1,260}"|'[^']{1,260}')/g
      for (const m of line.matchAll(pyPathRe)) {
        const t = stripQuotes(String(m[1] ?? "").trim())
        if (!t) continue
        if (t.includes("\n") || t.includes("\r")) continue
        // Keep it conservative: prefer path-like strings.
        results.push(t)
      }
    }

    return results
  }

  const looksLikeFilePath = (sRaw: string): boolean => {
    const s = String(sRaw ?? "").trim()
    if (!s) return false
    if (s.length > 2600) return false
    if (/\s/.test(s)) return false
    // ignore URIs other than file://
    if (/^[a-z]+:\/\//i.test(s) && !/^file:\/\//i.test(s)) return false
    // common absolute path prefixes
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true
    if (s.startsWith("./") || s.startsWith("../") || s.startsWith(".\\") || s.startsWith("..\\")) return true
    if (s.includes("/") || s.includes("\\")) {
      // must have a plausible extension or end with a filename-ish segment
      if (/\.[a-z0-9]{1,8}$/i.test(s)) return true
      // allow extensionless but only if it contains a dot-folder or looks like a repo file
      if (s.includes(".vscode/") || s.includes(".vscode\\")) return true
    }
    // bare relative filename with extension
    if (/^[^\\/]+\.[a-z0-9]{1,8}$/i.test(s)) return true
    return false
  }

  const visit = (value: any, depth: number) => {
    if (depth > 3) return
    if (value == null) return

    if (typeof value === "string") {
      const s = value.trim()
      if (!s) return

      // If the raw input is itself patch text, extract file paths.
      out.push(...getCandidateFilePathsFromPatchText(s))

      // If the string looks like a command line, try extracting redirection/cmdlet targets.
      if (s.includes(">") || /\b(out-file|set-content|add-content|tee-object)\b/i.test(s)) {
        out.push(...extractFileWriteTargetsFromCommandLine(s))
      }

      // Heuristic: some tool runtimes pass file targets as plain strings.
      // Avoid aggressive matching; only accept strings that look path-like.
      if (looksLikeFilePath(s)) out.push(s)

      // Many ACP runtimes stringify the tool input as JSON.
      if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
        try {
          const parsed = JSON.parse(s)
          visit(parsed, depth + 1)
        } catch {
          // ignore
        }
      }
      return
    }

    if (Array.isArray(value)) {
      for (const it of value) visit(it, depth + 1)
      return
    }

    if (typeof value !== "object") return

    const v = value as any

    const direct = [
      v.filePath,
      v.filepath,
      v.path,
      v.relativePath,
      v.targetPath,
      v.target,
      v.output,
      v.outputPath,
      v.outputFile,
      v.outputFilePath,
      v.dest,
      v.destination,
      v.filename,
      v.fileName,
      v.uri,
      v.command,
      v.commandLine,
      v.cmd,
      v.script,
    ]
      .map((x: any) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean)
    out.push(...direct)

    // If command-like fields exist, parse them for file write targets.
    for (const cmd of [v.commandLine, v.command, v.cmd, v.script]) {
      if (typeof cmd === "string" && cmd.trim()) out.push(...extractFileWriteTargetsFromCommandLine(cmd))
    }

    // Some tools pass patch text under different keys.
    out.push(...getCandidateFilePathsFromPatchText(v.patch))
    out.push(...getCandidateFilePathsFromPatchText(v.input))
    out.push(...getCandidateFilePathsFromPatchText(v.patchText))
    out.push(...getCandidateFilePathsFromPatchText(v.diff))

    // Batch-style inputs might include arrays of file objects.
    const filesArr = Array.isArray(v.files) ? v.files : Array.isArray(v.filePaths) ? v.filePaths : null
    if (filesArr) {
      for (const it of filesArr) {
        const p =
          typeof it === "string"
            ? it.trim()
            : typeof it?.path === "string"
              ? it.path.trim()
              : typeof it?.relativePath === "string"
                ? it.relativePath.trim()
                : typeof it?.filePath === "string"
                  ? it.filePath.trim()
                  : ""
        if (p) out.push(p)
      }
    }

    // Common wrappers used by tool runtimes.
    for (const key of ["parameters", "params", "payload", "data", "args", "arguments", "request", "toolInput", "tool_input"]) {
      if (v && v[key] != null) visit(v[key], depth + 1)
    }
  }

  try {
    visit(rawInput, 0)
  } catch {
    // ignore
  }
  // De-dupe while preserving order.
  const seen = new Set<string>()
  const uniq: string[] = []
  for (const p of out) {
    const s = String(p ?? "").trim()
    if (!s) continue
    if (seen.has(s)) continue
    seen.add(s)
    uniq.push(s)
  }
  return uniq
}

function tryToRelativePath(rawPath: string): string {
  const raw = String(rawPath ?? "").trim()
  if (!raw) return ""
  const norm = raw.replaceAll("\\\\", "/")
  if (!path.isAbsolute(raw)) return norm.replace(/^\/+/, "")

  const bases: string[] = []
  const dir = String(getDirectoryQuery() ?? "").trim()
  if (dir) bases.push(dir)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f?.uri?.fsPath) bases.push(f.uri.fsPath)
  }

  const abs = path.normalize(raw)
  for (const base of bases) {
    try {
      const b = path.normalize(base)
      const rel = path.relative(b, abs)
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue
      return rel.replaceAll("\\\\", "/")
    } catch {
      // ignore
    }
  }
  return norm
}

async function readTextFileBestEffort(uri: vscode.Uri, maxBytes = 1024 * 1024): Promise<string | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri)
    if (typeof stat?.size === "number" && stat.size > maxBytes) return undefined
  } catch {
    // ignore
  }
  try {
    const buf = await vscode.workspace.fs.readFile(uri)
    if (!buf?.length) return ""
    // Decode as UTF-8; for non-text/binary, return undefined.
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf)
    // Heuristic: if there are many NULs, treat as binary.
    const nulCount = (text.match(/\u0000/g) || []).length
    if (nulCount > 0) return undefined
    return text
  } catch {
    return undefined
  }
}

async function pushCoreEditsOverlayState(state: CoreEditsOverlayState) {
  if (DISABLE_CORE_EDITS_OVERLAY) return
  const now = Date.now()
  if (!coreEditsOverlayReady && now < coreEditsOverlayNextRetryAt) return

  try {
    if (!coreEditsOverlayReady) {
      await vscode.commands.executeCommand("opencode.editsOverlay.init")
      coreEditsOverlayReady = true

      // Feature-detect core overlay capabilities so we can avoid duplicate UI.
      try {
        const caps: any = await vscode.commands.executeCommand("opencode.editsOverlay.getCapabilities")
        coreEditsOverlaySupportsHunkOverlays = Boolean(caps?.hunkOverlays)
      } catch {
        coreEditsOverlaySupportsHunkOverlays = false
      }

      // Now that core overlay is available, refresh to clear legacy hover overlays.
      try {
        setTimeout(() => {
          try {
            updateEditNavStatusBar()
          } catch {
            // ignore
          }
        }, 0)
      } catch {
        // ignore
      }
    }
    await vscode.commands.executeCommand("opencode.editsOverlay.setState", state)
  } catch (err) {
    coreEditsOverlayReady = false
    coreEditsOverlayNextRetryAt = now + 5_000

    try {
      const msg = err instanceof Error ? err.message : String(err)
      const shouldLog = msg && (msg !== coreEditsOverlayLastErrorMsg || now - coreEditsOverlayLastErrorAt > 30_000)
      if (shouldLog) {
        coreEditsOverlayLastErrorAt = now
        coreEditsOverlayLastErrorMsg = msg
        getChatOutputChannel().appendLine(`[edits-overlay] core overlay unavailable: ${msg}`)
      }
    } catch {
      // ignore
    }
  }
}

// Copilot-like: in-editor floating actions anchored to each visible hunk (preferred).
type EditOverlayInset = { webview: vscode.Webview; dispose: () => void }
// File-level overlay: anchored near the bottom visible line.
const editFileOverlayByUri = new Map<string, { inset: EditOverlayInset; line: number }>()
const editFileOverlayRequestIdByUri = new Map<string, string>()
// Block-level overlays: one inset per hunk index.
const editBlockOverlaysByUri = new Map<string, Map<number, { inset: EditOverlayInset; line: number }>>()
const editBlockOverlayRequestIdByUri = new Map<string, string>()
// Debounce repositioning of the file-level inset. Insets can affect visible ranges;
// without debounce+hysteresis we may end up in a create/dispose feedback loop.
const editFileOverlayRepositionTimerByUri = new Map<string, ReturnType<typeof setTimeout>>()
// Visible range changes can be triggered by our own inset create/dispose.
// Track creation time to suppress immediate self-triggered repositioning.
const editFileOverlayLastCreateAtByUri = new Map<string, number>()
// When switching editors/tabs, `visibleRanges` can be temporarily empty/incorrect.
// Delay inset creation until the viewport is settled, otherwise we may anchor too low (e.g. EOF).
const editFileOverlayLayoutRetryTimerByUri = new Map<string, ReturnType<typeof setTimeout>>()

// In ACP, Files changed is rendered as a session-level bar aggregating pending edits.
// When the user continues editing a pending file (or ACP writes into an open buffer),
// we need to recompute +/− stats and refresh the session bar.
let acpPendingFilesChangedRefreshTimer: ReturnType<typeof setTimeout> | undefined
// When a user uses editor Undo/Redo on a pending file but does not save,
// the disk content can lag behind the live buffer. ACP tools may operate on disk,
// which can cause repeated patch failures (oldString not found / no-op edits).
// To keep disk and buffer consistent, we auto-save pending files on Undo/Redo.
const acpPendingAutoSaveUndoTimerByUri = new Map<string, ReturnType<typeof setTimeout>>()
const scheduleAcpPendingFilesChangedRefresh = (reason: string, fileKey?: string) => {
  try {
    if (transport() !== "acp") return
    // Only refresh when there's pending state to show.
    if (!editPendingBaselineByFileKey.size && !editNavPendingDiffByUri.size && !editPendingRequestIdsByFileKey.size) return
    if (acpPendingFilesChangedRefreshTimer) clearTimeout(acpPendingFilesChangedRefreshTimer)
    acpPendingFilesChangedRefreshTimer = setTimeout(() => {
      try {
        // postPendingEditsReviewBar() recomputes stats from live buffers (buildPendingReviewDiffs).
        postPendingEditsReviewBar()
        editsDevLog("acp pending bar refreshed", { reason, fileKey }, { verbose: true })
      } catch {
        // ignore
      }
    }, 120)
  } catch {
    // ignore
  }
}

// Some hosts may expose createWebviewTextEditorInset but still throw at runtime.
// When we detect a runtime failure, disable inset usage and fall back to non-reflow decorations.
let editInsetDisabledDueToError = false

function canUseEditInsets() {
  try {
    // User requested: restore original floating overlays (NOT insets).
    return false
  } catch {
    return false
  }
}

function ensureEditNavOverlayFallbackDecoration() {
  if (editNavOverlayFallbackDeco) return
  // Best-effort “in-editor bar” fallback for stable VS Code (no insets): a decoration
  // rendered near the bottom visible line. Actions are exposed via hover command links.
  editNavOverlayFallbackDeco = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      margin: "0 0 0 12px",
      textDecoration:
        "display:inline-flex;align-items:center;gap:8px;" +
        "padding:2px 10px;" +
        "border:1px solid var(--vscode-panel-border);" +
        "border-radius:10px;" +
        "background:var(--vscode-editorWidget-background);" +
        // Keep within the editor surface.
        // Using fixed positioning can cause the overlay to cover workbench UI (e.g. context menus).
        "position:absolute;right:18px;z-index:20;",
    },
  })
}

function ensureEditNavBlockOverlayDecoration() {
  if (editNavBlockOverlayDeco) return
  // Render a small “block-level” bar near the active hunk line.
  // This MUST NOT change document layout (unlike insets), to avoid content jumping.
  editNavBlockOverlayDeco = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      margin: "0 0 0 12px",
      textDecoration:
        "display:inline-flex;align-items:center;gap:8px;" +
        "padding:2px 10px;" +
        "border:1px solid var(--vscode-panel-border);" +
        "border-radius:10px;" +
        "background:var(--vscode-editorWidget-background);" +
        "position:absolute;right:14px;",
    },
  })
}

function clearEditNavBlockOverlay(editor?: vscode.TextEditor) {
  try {
    if (!editor || !editNavBlockOverlayDeco) return
    editor.setDecorations(editNavBlockOverlayDeco, [])
  } catch {
    // ignore
  }
}

function updateEditNavBlockOverlay(editor: vscode.TextEditor, nav: { hunks: EditHunkNav[] }) {
  try {
    ensureEditNavBlockOverlayDecoration()
    if (!editNavBlockOverlayDeco) return

    const uriKey = editor.document.uri.toString()
    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const idx = Math.max(0, Math.min(cur, nav.hunks.length - 1))
    const h = nav.hunks[idx]
    if (!h) {
      clearEditNavBlockOverlay(editor)
      return
    }

    const clampLine = (line0: number) => Math.max(0, Math.min(line0, Math.max(0, editor.document.lineCount - 1)))
    const desiredLine = clampLine(h.newEndLine0)
    const range = new vscode.Range(desiredLine, 0, desiredLine, 0)

    const label = "保留  撤销"
    editor.setDecorations(editNavBlockOverlayDeco, [
      {
        range,
        renderOptions: { after: { contentText: label } },
      },
    ])
  } catch {
    // ignore
  }
}

function clearEditNavOverlayFallback(editor?: vscode.TextEditor) {
  try {
    if (!editor || !editNavOverlayFallbackDeco) return
    editor.setDecorations(editNavOverlayFallbackDeco, [])
  } catch {
    // ignore
  }
}

function updateEditNavOverlayFallback(editor: vscode.TextEditor, nav: { hunks: EditHunkNav[]; requestId?: string; file?: string }) {
  try {
    ensureEditNavOverlayFallbackDecoration()
    if (!editNavOverlayFallbackDeco) return

    const visible = Array.isArray(editor.visibleRanges) && editor.visibleRanges.length ? editor.visibleRanges[0] : undefined
    const desiredLine = Math.max(0, Math.min(visible ? visible.end.line : 0, Math.max(0, editor.document.lineCount - 1)))
    // Anchor at column 0 so it stays visible even when the line is long.
    // Anchoring at end-of-line can render off-screen unless horizontally scrolled.
    const range = new vscode.Range(desiredLine, 0, desiredLine, 0)

    const uriKey = editor.document.uri.toString()
    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const idx = Math.max(0, Math.min(cur, nav.hunks.length - 1))
    const total = Math.max(1, nav.hunks.length)

    const label = `保留 撤销  ${idx + 1}/${total}  ↑ ↓`
    editor.setDecorations(editNavOverlayFallbackDeco, [
      {
        range,
        renderOptions: { after: { contentText: label } },
      },
    ])
  } catch {
    // ignore
  }
}

function disposeEditFileOverlay(uriKey: string) {
  const rec = editFileOverlayByUri.get(uriKey)
  if (rec) {
    try {
      rec.inset.dispose()
    } catch {
      // ignore
    }
  }
  editFileOverlayByUri.delete(uriKey)
  editFileOverlayRequestIdByUri.delete(uriKey)
}

function disposeEditBlockOverlay(uriKey: string) {
  const recs = editBlockOverlaysByUri.get(uriKey)
  if (recs) {
    for (const rec of Array.from(recs.values())) {
      try {
        rec.inset.dispose()
      } catch {
        // ignore
      }
    }
  }
  editBlockOverlaysByUri.delete(uriKey)
  editBlockOverlayRequestIdByUri.delete(uriKey)
}

function disposeAllEditOverlays() {
  for (const k of Array.from(editFileOverlayByUri.keys())) disposeEditFileOverlay(k)
  for (const k of Array.from(editBlockOverlaysByUri.keys())) disposeEditBlockOverlay(k)
}

function getEditFileOverlayHtml() {
  // Inline everything; keep it tiny and theme-driven.
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root{color-scheme: light dark;}
      html,body{padding:0;margin:0;overflow:hidden;}
      .wrap{height:100%;display:flex;justify-content:flex-end;align-items:flex-end;padding:4px 8px;}
      .bar{display:flex;align-items:center;gap:10px;
        padding:6px 10px;border-radius:10px;
        border:1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        font-family: var(--vscode-font-family);
        font-size: 12px;
        color: var(--vscode-foreground);
      }
      .muted{color: var(--vscode-descriptionForeground);}
      .btn{appearance:none;border:none;border-radius:8px;
        padding:4px 10px;cursor:pointer;
        font: inherit;
      }
      .btnIcon{width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;
        padding:0;border-radius:8px;line-height:1;
      }
      .btnPrimary{background: var(--vscode-button-background); color: var(--vscode-button-foreground);}
      .btnPrimary:hover{background: var(--vscode-button-hoverBackground);}
      .btnGhost{background: transparent; color: var(--vscode-foreground); border:1px solid var(--vscode-panel-border);}
      .btnGhost:hover{background: var(--vscode-list-hoverBackground);}
      .sep{width:1px;height:16px;background: var(--vscode-panel-border);opacity:0.9;}
      .tight{letter-spacing:0.2px;}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="bar" role="toolbar" aria-label="Edits">
        <button class="btn btnGhost btnIcon" id="prev" aria-label="上一处">↑</button>
        <span class="muted tight" id="counter">1/1</span>
        <button class="btn btnGhost btnIcon" id="next" aria-label="下一处">↓</button>
        <div class="sep"></div>
        <button class="btn btnPrimary" id="keep">保留</button>
        <button class="btn btnGhost" id="undo">撤销</button>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      let idx = 0;
      const post = (cmd) => vscode.postMessage({ type: 'cmd', cmd, idx });
      document.getElementById('prev').addEventListener('click', () => post('prevHunk'));
      document.getElementById('next').addEventListener('click', () => post('nextHunk'));
      document.getElementById('keep').addEventListener('click', () => post('keepFile'));
      document.getElementById('undo').addEventListener('click', () => post('undoFile'));
      window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.type !== 'state') return;
        idx = Number(msg.idx ?? 0);
        const total = Number(msg.total ?? 1);
        const c = document.getElementById('counter');
        if (c) c.textContent = String(idx + 1) + '/' + String(Math.max(1, total));
      });
    </script>
  </body>
</html>`
}

function getEditBlockOverlayHtml() {
  // Inline everything; keep it tiny and theme-driven.
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root{color-scheme: light dark;}
      html,body{padding:0;margin:0;overflow:hidden;}
      .wrap{display:flex;justify-content:flex-end;padding:4px 8px;}
      .bar{display:flex;align-items:center;gap:10px;
        padding:6px 10px;border-radius:10px;
        border:1px solid var(--vscode-panel-border);
        background: var(--vscode-editorWidget-background);
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        font-family: var(--vscode-font-family);
        font-size: 12px;
        color: var(--vscode-foreground);
      }
      .btn{appearance:none;border:none;border-radius:8px;
        padding:4px 10px;cursor:pointer;
        font: inherit;
      }
      .btnPrimary{background: var(--vscode-button-background); color: var(--vscode-button-foreground);}
      .btnPrimary:hover{background: var(--vscode-button-hoverBackground);}
      .btnGhost{background: transparent; color: var(--vscode-foreground); border:1px solid var(--vscode-panel-border);}
      .btnGhost:hover{background: var(--vscode-list-hoverBackground);}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="bar" role="toolbar" aria-label="Edit Block">
        <button class="btn btnPrimary" id="keep">保留</button>
        <button class="btn btnGhost" id="undo">撤销</button>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      let idx = 0;
      const post = (cmd) => vscode.postMessage({ type: 'cmd', cmd, idx });
      document.getElementById('keep').addEventListener('click', () => post('keepHunk'));
      document.getElementById('undo').addEventListener('click', () => post('undoHunk'));
      window.addEventListener('message', (e) => {
        const msg = e.data;
        if (!msg || msg.type !== 'state') return;
        idx = Number(msg.idx ?? 0);
      });
    </script>
  </body>
</html>`
}

async function ensureEditFileOverlayForEditor(editor: vscode.TextEditor, nav: { hunks: EditHunkNav[]; requestId?: string; file?: string }) {
  const uriKey = editor.document.uri.toString()

  // If the request changed for this doc, recreate the inset so it can re-anchor correctly.
  try {
    const rid = String(nav?.requestId ?? "").trim()
    const prevRid = editFileOverlayRequestIdByUri.get(uriKey)
    if (rid && prevRid && prevRid !== rid) {
      editsDevLog("file overlay rid changed -> dispose", { uriKey, prevRid, rid })
      disposeEditFileOverlay(uriKey)
    }
  } catch {
    // ignore
  }

  const createInset = (vscode.window as any).createWebviewTextEditorInset as
    | undefined
    | ((ed: vscode.TextEditor, line: number, height: number) => EditOverlayInset)

  if (!nav?.hunks?.length) {
    editsDevLog("file overlay: no hunks -> dispose", getEditsDebugSnapshot(uriKey), { verbose: true })
    disposeEditFileOverlay(uriKey)
    return
  }

  if (!createInset || editInsetDisabledDueToError) {
    editsDevLog("file overlay: inset unavailable/disabled", { uriKey, hasCreateInset: Boolean(createInset), editInsetDisabledDueToError })
    disposeEditFileOverlay(uriKey)
    return
  }

  const existing = editFileOverlayByUri.get(uriKey)
  const insetHeightLines = 2

  // If the editor viewport hasn't settled yet (common right after switching back
  // to a tab), avoid creating/moving the inset based on a missing `visibleRanges`.
  // We'll retry shortly when the editor reports a stable visible range.
  try {
    const hasVisible = Array.isArray(editor.visibleRanges) && editor.visibleRanges.length > 0
    if (!hasVisible && !existing) {
      const prev = editFileOverlayLayoutRetryTimerByUri.get(uriKey)
      if (prev) clearTimeout(prev)
      editFileOverlayLayoutRetryTimerByUri.set(
        uriKey,
        setTimeout(() => {
          try {
            const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriKey)
            if (!ed) return
            const currentNav = editNavByUri.get(uriKey)
            if (!currentNav?.hunks?.length) return
            void ensureEditFileOverlayForEditor(ed, currentNav)
          } catch {
            // ignore
          }
        }, 80),
      )
      return
    }
  } catch {
    // ignore
  }
  // File-level bar should NOT compete with hunk-level bars.
  // Copilot-like: keep a stable file-level bar near the bottom of the current
  // viewport, so it stays reachable when navigating between distant hunks.
  // (Anchoring below the last hunk makes it disappear when the last hunk is far away.)
  const desiredLine = (() => {
    const visible = Array.isArray(editor.visibleRanges) && editor.visibleRanges.length ? editor.visibleRanges[0] : undefined
    // For file-level inset we allow anchoring at `lineCount` (one past EOF) so the bar can
    // appear *below* the last real line/hunk in short files.
    const maxAnchorLine = Math.max(0, editor.document.lineCount)
    const clampLine = (line0: number) => Math.max(0, Math.min(line0, maxAnchorLine))
    const used = new Set<number>()
    try {
      const m = editBlockOverlaysByUri.get(uriKey)
      if (m && m.size) {
        for (const rec of Array.from(m.values())) {
          used.add(rec.line)
        }
      }
    } catch {
      // ignore
    }

    const allocate = (requested: number) => {
      const start = clampLine(requested)
      if (!used.has(start)) return start
      for (let i = start + 1; i <= maxAnchorLine; i++) {
        if (!used.has(i)) return i
      }
      for (let i = start - 1; i >= 0; i--) {
        if (!used.has(i)) return i
      }
      return start
    }

    const idealLine = (() => {
      // Anchor a bit ABOVE the viewport bottom so the inset (which has its own height)
      // remains visible without requiring extra scrolling.
      // Note: `visible.end.line` tends to be at/near the viewport bottom.
      const safety = insetHeightLines + 1
      const bottom0 = visible ? Math.max(0, visible.end.line) : maxAnchorLine
      return clampLine(Math.max(0, bottom0 - safety))
    })()

    if (!existing) return allocate(idealLine)
    if (!visible) return existing.line

    // IMPORTANT: creating/disposing a TextEditorInset can itself shift `visibleRanges`.
    // If we chase `visible.end.line` too eagerly, the desiredLine will oscillate by
    // roughly `insetHeightLines` (feedback loop), causing the overlay to "jump".
    // Use a wider hysteresis window to keep the inset stable while it's in view.
    // NOTE: inserting an inset can reduce the number of visible *text* lines, which
    // makes `visible.end.line` move upward. That can incorrectly make the inset look
    // “out of view”, triggering an oscillation. Treat a small band below the visible
    // end as still effectively in-view.
    const softVisibleEnd = Math.min(maxAnchorLine, visible.end.line + insetHeightLines + 2)
    const inView = existing.line >= visible.start.line && existing.line <= softVisibleEnd
    const existingConflictsWithBlock = used.has(existing.line)
    const hysteresis = insetHeightLines + 3
    const closeEnough = Math.abs(existing.line - idealLine) <= hysteresis
    if (inView && closeEnough && !existingConflictsWithBlock) return existing.line
    return allocate(idealLine)
  })()

  editsDevLog(
    "file overlay desiredLine",
    {
      uriKey,
      desiredLine,
      existingLine: existing?.line,
      lineCount: editor.document.lineCount,
      hunks: nav.hunks.length,
      requestId: nav.requestId,
    },
    { verbose: true },
  )
  if (!existing || existing.line !== desiredLine) {
    if (existing) {
      try {
        existing.inset.dispose()
      } catch {
        // ignore
      }
      editFileOverlayByUri.delete(uriKey)
    }
    try {
      // Height is in editor line heights (not a real text line, so it has no line number).
      // Give it a little room so the bar can visually sit at the bottom.
      const inset = createInset(editor, desiredLine, insetHeightLines)
      inset.webview.options = { enableScripts: true }
      inset.webview.html = getEditFileOverlayHtml()

      inset.webview.onDidReceiveMessage((msg: any) => {
        const cmd = String(msg?.cmd ?? "")
        const msgIdx = Number(msg?.idx ?? -1)
        if (!cmd) return

        const currentEditor =
          vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriKey) ?? vscode.window.activeTextEditor
        if (!currentEditor || currentEditor.document.uri.toString() !== uriKey) return
        const currentNav = editNavByUri.get(uriKey)
        if (!currentNav?.hunks?.length) return

        const clamped = Number.isFinite(msgIdx)
          ? Math.max(0, Math.min(msgIdx, currentNav.hunks.length - 1))
          : Math.max(0, Math.min(activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0, currentNav.hunks.length - 1))

        activeEditNav = { uriKey, index: clamped }
        applyEditNavToEditor(currentEditor, currentNav.hunks, clamped)
        try {
          editNavCodeLensEmitter?.fire()
        } catch {
          // ignore
        }
        updateEditNavStatusBar()

        if (cmd === "keepFile") void vscode.commands.executeCommand("opencode.edits.keepFile", { uri: uriKey })
        else if (cmd === "undoFile") void vscode.commands.executeCommand("opencode.edits.undoFile", { uri: uriKey })
        else if (cmd === "prevHunk") {
          const target = Math.max(0, clamped - 1)
          void vscode.commands.executeCommand("opencode.edits.gotoHunk", { uri: uriKey, index: target })
        } else if (cmd === "nextHunk") {
          const target = Math.max(0, Math.min(clamped + 1, currentNav.hunks.length - 1))
          void vscode.commands.executeCommand("opencode.edits.gotoHunk", { uri: uriKey, index: target })
        }
      })

      editFileOverlayByUri.set(uriKey, { inset, line: desiredLine })
      editFileOverlayLastCreateAtByUri.set(uriKey, Date.now())
      editsDevLog("file overlay created", { uriKey, line: desiredLine, requestId: nav.requestId })
    } catch (err) {
      editInsetDisabledDueToError = true
      disposeEditFileOverlay(uriKey)
      try {
        const out = getChatOutputChannel()
        out.appendLine(`[edits-ui] file inset create failed; falling back: ${String((err as any)?.message ?? err)}`)
      } catch {
        // ignore
      }
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          updateEditNavStatusBar()
        } catch {
          // ignore
        }
      }, 0)
      return
    }
  }

  try {
    const rid = String(nav?.requestId ?? "").trim()
    if (rid) editFileOverlayRequestIdByUri.set(uriKey, rid)
  } catch {
    // ignore
  }

  try {
    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const idx = Math.max(0, Math.min(cur, nav.hunks.length - 1))
    const rec2 = editFileOverlayByUri.get(uriKey)
    if (rec2?.inset) void rec2.inset.webview.postMessage({ type: "state", idx, total: nav.hunks.length })
  } catch {
    // ignore
  }
}

async function ensureEditBlockOverlayForEditor(editor: vscode.TextEditor, nav: { hunks: EditHunkNav[]; requestId?: string; file?: string }) {
  const uriKey = editor.document.uri.toString()

  // If the request changed for this doc, recreate all hunk insets (their anchors depend on hunk lines).
  try {
    const rid = String(nav?.requestId ?? "").trim()
    const prevRid = editBlockOverlayRequestIdByUri.get(uriKey)
    if (rid && prevRid && prevRid !== rid) {
      editsDevLog("block overlays rid changed -> dispose", { uriKey, prevRid, rid })
      disposeEditBlockOverlay(uriKey)
    }
  } catch {
    // ignore
  }

  const createInset = (vscode.window as any).createWebviewTextEditorInset as
    | undefined
    | ((ed: vscode.TextEditor, line: number, height: number) => EditOverlayInset)

  if (!nav?.hunks?.length) {
    editsDevLog("block overlays: no hunks -> dispose", getEditsDebugSnapshot(uriKey), { verbose: true })
    disposeEditBlockOverlay(uriKey)
    return
  }

  if (!createInset || editInsetDisabledDueToError) {
    editsDevLog("block overlays: inset unavailable/disabled", { uriKey, hasCreateInset: Boolean(createInset), editInsetDisabledDueToError })
    disposeEditBlockOverlay(uriKey)
    return
  }

  const clampLine = (line0: number) => Math.max(0, Math.min(line0, Math.max(0, editor.document.lineCount - 1)))

  const existingMap = editBlockOverlaysByUri.get(uriKey) ?? new Map<number, { inset: EditOverlayInset; line: number }>()
  const nextIndices = new Set<number>()
  const nextMap = new Map<number, { inset: EditOverlayInset; line: number }>()
  const usedLines = new Set<number>()

  const allocateLine = (requested: number) => {
    const start = clampLine(requested)
    if (!usedLines.has(start)) {
      usedLines.add(start)
      return start
    }
    const maxLine = Math.max(0, editor.document.lineCount - 1)
    for (let i = start + 1; i <= maxLine; i++) {
      if (!usedLines.has(i)) {
        usedLines.add(i)
        return i
      }
    }
    for (let i = start - 1; i >= 0; i--) {
      if (!usedLines.has(i)) {
        usedLines.add(i)
        return i
      }
    }
    usedLines.add(start)
    return start
  }

  // Recompute desired lines every time so block overlays follow hunk line changes
  // (e.g. when more hunks arrive in later diffs).
  const hunksSorted = Array.from(nav.hunks)
    .filter((h) => Number.isFinite(Number((h as any)?.index)) && Number((h as any)?.index) >= 0)
    .sort((a, b) => Number((a as any).index) - Number((b as any).index))

  for (const hunk of hunksSorted) {
    const idx = Number((hunk as any).index)
    if (!Number.isFinite(idx) || idx < 0) continue
    nextIndices.add(idx)

    const desiredLine = allocateLine(clampLine(Number((hunk as any).newEndLine0)))
    const existing = existingMap.get(idx)

    editsDevLog(
      "block overlay desiredLine",
      { uriKey, idx, desiredLine, existingLine: existing?.line, newStartLine0: hunk.newStartLine0, newEndLine0: hunk.newEndLine0 },
      { verbose: true },
    )

    if (existing && existing.line === desiredLine) {
      nextMap.set(idx, existing)
      continue
    }

    if (existing) {
      try {
        existing.inset.dispose()
      } catch {
        // ignore
      }
    }

    try {
      const inset = createInset(editor, desiredLine, 2)
      inset.webview.options = { enableScripts: true }
      inset.webview.html = getEditBlockOverlayHtml()

      inset.webview.onDidReceiveMessage((msg: any) => {
        const cmd = String(msg?.cmd ?? "")
        const msgIdx = Number(msg?.idx ?? -1)
        if (!cmd || !Number.isFinite(msgIdx) || msgIdx < 0) return

        const currentEditor =
          vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriKey) ?? vscode.window.activeTextEditor
        if (!currentEditor || currentEditor.document.uri.toString() !== uriKey) return
        const currentNav = editNavByUri.get(uriKey)
        if (!currentNav?.hunks?.length) return

        const clamped = Math.max(0, Math.min(msgIdx, currentNav.hunks.length - 1))
        activeEditNav = { uriKey, index: clamped }
        applyEditNavToEditor(currentEditor, currentNav.hunks, clamped)
        try {
          editNavCodeLensEmitter?.fire()
        } catch {
          // ignore
        }
        updateEditNavStatusBar()

        if (cmd === "keepHunk") void vscode.commands.executeCommand("opencode.edits.keepHunk")
        else if (cmd === "undoHunk") void vscode.commands.executeCommand("opencode.edits.undoHunk")
      })

      nextMap.set(idx, { inset, line: desiredLine })
      editsDevLog("block overlay created", { uriKey, idx, line: desiredLine, requestId: nav.requestId })
    } catch (err) {
      editInsetDisabledDueToError = true
      disposeEditBlockOverlay(uriKey)
      try {
        const out = getChatOutputChannel()
        out.appendLine(`[edits-ui] block inset create failed; falling back: ${String((err as any)?.message ?? err)}`)
      } catch {
        // ignore
      }
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          updateEditNavStatusBar()
        } catch {
          // ignore
        }
      }, 0)
      return
    }
  }

  for (const [idx, rec] of Array.from(existingMap.entries())) {
    if (!nextIndices.has(idx)) {
      try {
        rec.inset.dispose()
      } catch {
        // ignore
      }
    }
  }

  if (nextMap.size) editBlockOverlaysByUri.set(uriKey, nextMap)
  else editBlockOverlaysByUri.delete(uriKey)

  try {
    const rid = String(nav?.requestId ?? "").trim()
    if (rid) editBlockOverlayRequestIdByUri.set(uriKey, rid)
  } catch {
    // ignore
  }

  try {
    for (const [idx, rec] of Array.from(nextMap.entries())) {
      void rec.inset.webview.postMessage({ type: "state", idx })
    }
  } catch {
    // ignore
  }
}

const EDIT_REVIEW_ACTIVE_CONTEXT_KEY = "opencode.editsReviewActive"
const EDIT_REVIEW_FILE_ACTIVE_CONTEXT_KEY = "opencode.editsReviewFileActive"
let lastEditReviewActiveContextValue: boolean | undefined
let lastEditReviewFileActiveContextValue: boolean | undefined

function setContextSafe(key: string, value: any) {
  try {
    return vscode.commands.executeCommand("setContext", key, value)
  } catch {
    return Promise.resolve(undefined)
  }
}

function updateEditReviewEditorContext() {
  const anyActive = editNavByUri.size > 0
  const editor = vscode.window.activeTextEditor
  const uriKey = editor?.document?.uri?.toString()
  const nav = uriKey ? editNavByUri.get(uriKey) : undefined
  const fileActive = Boolean(nav?.requestId && nav?.file)

  if (lastEditReviewActiveContextValue !== anyActive) {
    lastEditReviewActiveContextValue = anyActive
    void setContextSafe(EDIT_REVIEW_ACTIVE_CONTEXT_KEY, anyActive)
  }
  if (lastEditReviewFileActiveContextValue !== fileActive) {
    lastEditReviewFileActiveContextValue = fileActive
    void setContextSafe(EDIT_REVIEW_FILE_ACTIVE_CONTEXT_KEY, fileActive)
  }
}

function computeEditHunks(before: string, after: string): EditHunkNav[] {
  try {
    // context:0 gives stable (old/new) line slices for per-hunk undo/keep.
    const patch = structuredPatch("before", "after", String(before ?? ""), String(after ?? ""), "", "", { context: 0 })
    const hunks = Array.isArray(patch?.hunks) ? patch.hunks : []
    const result: EditHunkNav[] = []
    for (let i = 0; i < hunks.length; i++) {
      const h = hunks[i]

      const oldStart = Number(h?.oldStart ?? 1)
      const oldLines = Math.max(0, Number(h?.oldLines ?? 0))
      const oldStart0 = Math.max(0, oldStart - 1)

      const newStart = Number(h?.newStart ?? 1)
      const newLines = Math.max(0, Number(h?.newLines ?? 0))
      const start0 = Math.max(0, newStart - 1)
      const end0 = Math.max(start0, start0 + Math.max(1, newLines) - 1)

      const lines: string[] = Array.isArray(h?.lines) ? h.lines : []
      const oldLinesText: string[] = []
      const newLinesText: string[] = []
      for (const line of lines) {
        if (!line || typeof line !== "string") continue
        if (line.startsWith("\\")) continue
        if (line.startsWith("-")) oldLinesText.push(line.slice(1))
        if (line.startsWith("+")) newLinesText.push(line.slice(1))
      }

      result.push({
        index: i,
        oldStartLine0: oldStart0,
        oldLineCount: oldLines,
        newStartLine0: start0,
        newEndLine0: end0,
        newLineCount: newLines,
        oldLinesText,
        newLinesText,
      })
    }

    editsDevLog(
      "computeEditHunks",
      {
        beforeLen: String(before ?? "").length,
        afterLen: String(after ?? "").length,
        hunks: result.length,
        sample: result.slice(0, 12).map((h) => ({
          i: h.index,
          start: h.newStartLine0 + 1,
          end: h.newEndLine0 + 1,
          newLines: h.newLineCount,
          add: h.newLinesText.length,
          del: h.oldLinesText.length,
        })),
      },
      { verbose: true },
    )
    return result
  } catch {
    return []
  }
}

function applyKeptHunkToBaselineText(baseline: string, h: EditHunkNav): string {
  const text = String(baseline ?? "")
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const endsWithEol = text.endsWith(eol)
  const head = endsWithEol ? text.slice(0, -eol.length) : text
  const lines = head.length ? head.split(eol) : []

  const start0 = Math.max(0, Math.min(Number(h.oldStartLine0) || 0, lines.length))
  const deleteCount = Math.max(0, Number(h.oldLineCount) || 0)
  const insertLines = Array.isArray(h.newLinesText) ? h.newLinesText : []

  lines.splice(start0, deleteCount, ...insertLines)

  const nextHead = lines.join(eol)
  return endsWithEol ? nextHead + eol : nextHead
}

function computeAddDelStats(before: string, after: string): { additions: number; deletions: number } {
  try {
    const patch = structuredPatch("before", "after", String(before ?? ""), String(after ?? ""), "", "", { context: 0 })
    const hunks = Array.isArray(patch?.hunks) ? patch.hunks : []
    let additions = 0
    let deletions = 0
    for (const h of hunks) {
      const lines: string[] = Array.isArray(h?.lines) ? h.lines : []
      for (const line of lines) {
        if (!line || typeof line !== "string") continue
        if (line.startsWith("\\")) continue
        if (line.startsWith("+")) additions++
        else if (line.startsWith("-")) deletions++
      }
    }
    return { additions: Math.max(0, additions), deletions: Math.max(0, deletions) }
  } catch {
    return { additions: 0, deletions: 0 }
  }
}

function canonicalizeFileKey(fileLike: string): string {
  const raw = String(fileLike ?? "").trim()
  if (!raw) return ""

  let p = raw
  try {
    if (/^file:\/\//i.test(raw)) p = vscode.Uri.parse(raw).fsPath
  } catch {
    // ignore
  }

  try {
    const base = getDirectoryQuery() || process.cwd()
    p = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.resolve(base, p))
  } catch {
    // ignore
  }

  try {
    if (process.platform === "win32") p = p.toLowerCase()
  } catch {
    // ignore
  }

  return p
}

function ensureEditNavStatusBar(context: vscode.ExtensionContext) {
  if (editNavStatusItem) return

  // High priority so they don't get pushed into the status bar overflow.
  // Order (left -> right): keep/undo (file) -> counter -> arrows -> hunk actions.
  editNavKeepFileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1006)
  editNavUndoFileItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1005)
  editNavStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1004)
  editNavPrevItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1003)
  editNavNextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1002)
  editNavKeepHunkItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1001)
  editNavUndoHunkItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000)

  editNavPrevItem.text = "$(chevron-up)"
  editNavPrevItem.tooltip = "上一处更改"
  editNavPrevItem.command = "opencode.edits.prevHunk"

  editNavNextItem.text = "$(chevron-down)"
  editNavNextItem.tooltip = "下一处更改"
  editNavNextItem.command = "opencode.edits.nextHunk"

  editNavKeepHunkItem.text = "$(check)"
  editNavKeepHunkItem.tooltip = "保留更改（hunk）"
  editNavKeepHunkItem.command = "opencode.edits.keepHunk"

  editNavUndoHunkItem.text = "$(discard)"
  editNavUndoHunkItem.tooltip = "撤销更改（hunk）"
  editNavUndoHunkItem.command = "opencode.edits.undoHunk"

  editNavKeepFileItem.text = "$(check) 保留"
  editNavKeepFileItem.tooltip = "保留此文件更改"
  editNavKeepFileItem.command = "opencode.edits.keepFile"

  editNavUndoFileItem.text = "$(discard) 撤销"
  editNavUndoFileItem.tooltip = "撤销此文件更改"
  editNavUndoFileItem.command = "opencode.edits.undoFile"

  context.subscriptions.push(
    editNavStatusItem,
    editNavPrevItem,
    editNavNextItem,
    editNavKeepHunkItem,
    editNavUndoHunkItem,
    editNavKeepFileItem,
    editNavUndoFileItem,
  )
}

function hideEditNavStatusBar() {
  editNavStatusItem?.hide()
  editNavPrevItem?.hide()
  editNavNextItem?.hide()
  editNavKeepHunkItem?.hide()
  editNavUndoHunkItem?.hide()
  editNavKeepFileItem?.hide()
  editNavUndoFileItem?.hide()

  void pushCoreEditsOverlayState({ visible: false })

  // Clear all in-editor overlays.
  disposeAllEditOverlays()
  clearEditNavOverlayFallback(vscode.window.activeTextEditor)
  clearEditNavBlockOverlay(vscode.window.activeTextEditor)
}

function updateEditNavStatusBar() {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    hideEditNavStatusBar()
    updateEditReviewEditorContext()
    return
  }
  const uriKey = editor.document.uri.toString()
  const nav = editNavByUri.get(uriKey)
  if (!nav?.hunks?.length) {
    hideEditNavStatusBar()
    updateEditReviewEditorContext()
    return
  }

  const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
  const idx = Math.max(0, Math.min(cur, nav.hunks.length - 1))
  const total = Math.max(1, nav.hunks.length)

  // Preferred: workbench core floating overlay (non-inset).
  // If the overlay isn't available yet, keep the status bar fallback visible until init succeeds.
  if (!DISABLE_CORE_EDITS_OVERLAY) {
    try {
      if (coreEditsOverlayReady) {
        editNavStatusItem?.hide()
        editNavPrevItem?.hide()
        editNavNextItem?.hide()
        editNavKeepHunkItem?.hide()
        editNavUndoHunkItem?.hide()
        editNavKeepFileItem?.hide()
        editNavUndoFileItem?.hide()
      } else {
        const hasMany = total > 1
        if (editNavStatusItem) {
          editNavStatusItem.text = `Edits ${idx + 1}/${total}`
          editNavStatusItem.tooltip = `Edits ${idx + 1}/${total}`
          editNavStatusItem.show()
        }
        if (hasMany) {
          editNavPrevItem?.show()
          editNavNextItem?.show()
        } else {
          editNavPrevItem?.hide()
          editNavNextItem?.hide()
        }
        editNavKeepHunkItem?.show()
        editNavUndoHunkItem?.show()
        editNavKeepFileItem?.hide()
        editNavUndoFileItem?.hide()
      }

      // Do not show any inset/decoration entry points in this mode.
      disposeEditFileOverlay(uriKey)
      disposeEditBlockOverlay(uriKey)
      clearEditNavOverlayFallback(editor)
      clearEditNavBlockOverlay(editor)

      const hunks: CoreEditsOverlayHunkState[] = []
      for (const h of nav.hunks) {
        const hi = Number(h.index)
        if (!Number.isFinite(hi) || hi < 0) continue
        const line = Math.max(1, Math.floor(Number(h.newStartLine0) + 1))
        hunks.push({ index: hi, line })
      }

      void pushCoreEditsOverlayState({
        visible: true,
        index: idx,
        total,
        uri: editor.document.uri.toString(),
        hunks,
      })

      noteLastKnownDocText(nav.fileKey, editor.document.getText())
      updateEditReviewEditorContext()
      return
    } catch {
      // fall through to status bar fallback below
    }
  }

  // Fallback: status bar controls (plus CodeLens for per-hunk keep/undo).
  try {
    const hasMany = total > 1

    if (editNavStatusItem) {
      editNavStatusItem.text = `Edits ${idx + 1}/${total}`
      editNavStatusItem.tooltip = `Edits ${idx + 1}/${total}`
      editNavStatusItem.show()
    }

    if (hasMany) {
      editNavPrevItem?.show()
      editNavNextItem?.show()
    } else {
      editNavPrevItem?.hide()
      editNavNextItem?.hide()
    }

    editNavKeepHunkItem?.show()
    editNavUndoHunkItem?.show()
    editNavKeepFileItem?.hide()
    editNavUndoFileItem?.hide()
  } catch {
    // ignore
  }

  disposeEditFileOverlay(uriKey)
  disposeEditBlockOverlay(uriKey)
  clearEditNavOverlayFallback(editor)
  clearEditNavBlockOverlay(editor)
  noteLastKnownDocText(nav.fileKey, editor.document.getText())
  updateEditReviewEditorContext()
  return
}

function clearPendingEditNavForRequest(requestId: string) {
  const rid = String(requestId ?? "").trim()
  if (!rid) return

  editsDevLog("clearPendingEditNavForRequest:start", { rid, keys: editNavPendingUrisByRequestId.get(rid)?.size ?? 0 })

  const keys = editNavPendingUrisByRequestId.get(rid)
  if (keys) {
    for (const k of keys) {
      try {
        const pending = editNavPendingDiffByUri.get(k)
        // Important: a uriKey can move to a NEWER requestId when the same file is edited again.
        // Only delete the pending diff if it is still owned by this requestId.
        if (pending?.requestId === rid) {
          editNavPendingDiffByUri.delete(k)
        }

        const fileKey =
          (pending?.file ? canonicalizeFileKey(pending.file) : undefined) ??
          editFileKeyByUriKey.get(k)

        if (fileKey) {
          const arr = editPendingRequestIdsByFileKey.get(fileKey)
          if (arr && arr.length) {
            editPendingRequestIdsByFileKey.set(
              fileKey,
              arr.filter((x) => x !== rid),
            )
            const next = editPendingRequestIdsByFileKey.get(fileKey)
            if (!next || next.length === 0) {
              editPendingRequestIdsByFileKey.delete(fileKey)
              editPendingBaselineByFileKey.delete(fileKey)
            }
          }
        }
      } catch {
        // ignore
        // Only delete if we are confident it belongs to this request.
        const pending = editNavPendingDiffByUri.get(k)
        if (!pending || pending?.requestId === rid) editNavPendingDiffByUri.delete(k)
      }
    }
    editNavPendingUrisByRequestId.delete(rid)
  }

  try {
    const editor = vscode.window.activeTextEditor
    const uriKey = editor?.document?.uri?.toString()
    if (uriKey) {
      const nav = editNavByUri.get(uriKey)
      if (nav?.requestId === rid) {
        editNavByUri.delete(uriKey)
        activeEditNav = null
        try {
          if (editor) {
            editor.setDecorations(editNavAllDeco!, [])
            editor.setDecorations(editNavActiveDeco!, [])
          }
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  // Remove any cached editor nav for this request.
  for (const [k, v] of Array.from(editNavByUri.entries())) {
    if (v?.requestId === rid) editNavByUri.delete(k)
  }

  editsDevLog("clearPendingEditNavForRequest:done", { rid, remainingPending: editNavPendingUrisByRequestId.size, remainingNav: editNavByUri.size })
  updateEditNavStatusBar()
  updateEditReviewEditorContext()
}

function clearEditNavForUriKey(uriKeyRaw: string) {
  const uriKey = String(uriKeyRaw ?? "").trim()
  if (!uriKey) return

  try {
    editNavByUri.delete(uriKey)
    if (activeEditNav?.uriKey === uriKey) activeEditNav = null
  } catch {
    // ignore
  }

  // Clear overlays & decorations for any visible editor showing this doc.
  try {
    disposeEditFileOverlay(uriKey)
    disposeEditBlockOverlay(uriKey)
  } catch {
    // ignore
  }

  try {
    for (const e of vscode.window.visibleTextEditors) {
      if (e?.document?.uri?.toString?.() !== uriKey) continue
      try {
        e.setDecorations(editNavAllDeco!, [])
        e.setDecorations(editNavActiveDeco!, [])
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  try {
    editNavCodeLensEmitter?.fire()
  } catch {
    // ignore
  }

  updateEditNavStatusBar()
  updateEditReviewEditorContext()
}

function cachePendingEditNavFromDiffs(
  requestId: string,
  diffs: any[],
  resolveUriForFile: (file: string) => vscode.Uri | undefined,
) {
  const rid = String(requestId ?? "").trim()
  if (!rid) return

  editsDevLog("cachePendingEditNavFromDiffs:start", {
    rid,
    diffs: Array.isArray(diffs) ? diffs.length : 0,
    prevKeys: editNavPendingUrisByRequestId.get(rid)?.size ?? 0,
  })

  const nextKeys = new Set<string>()
  for (const d of Array.isArray(diffs) ? diffs : []) {
    const file = String(d?.file ?? "").trim()
    if (!file) continue
    const before = typeof d?.before === "string" ? d.before : ""
    const after = typeof d?.after === "string" ? d.after : ""

    // Guard: some ACP hosts/toolchains may include files with an empty/no-op diff.
    // If before/after are identical, don't create/extend pending chains/baselines.
    if (before === after) continue

    const uri = resolveUriForFile(file)
    if (!uri) continue
    const uriKey = uri.toString()
    nextKeys.add(uriKey)

    // If this file was previously tracked under a different requestId, detach it from the old request's key set.
    // Otherwise, clearing the old request later might accidentally remove the newer pending diff.
    try {
      const prevPending = editNavPendingDiffByUri.get(uriKey)
      const prevRid = String(prevPending?.requestId ?? "").trim()
      if (prevRid && prevRid !== rid) {
        const prevKeys = editNavPendingUrisByRequestId.get(prevRid)
        if (prevKeys?.has(uriKey)) {
          prevKeys.delete(uriKey)
          if (prevKeys.size === 0) editNavPendingUrisByRequestId.delete(prevRid)
          else editNavPendingUrisByRequestId.set(prevRid, prevKeys)
          editsDevLog("cachePendingEditNavFromDiffs:moveKey", { fromRid: prevRid, toRid: rid, uriKey, file }, { verbose: true })
        }
      }
    } catch {
      // ignore
    }

    const fileKey = canonicalizeFileKey(file)
    editFileKeyByUriKey.set(uriKey, fileKey)

    // Track request chain for this file.
    const chain = editPendingRequestIdsByFileKey.get(fileKey) ?? []
    const hadPendingChain = chain.length > 0
    const isNewRidForFile = !chain.includes(rid)
    if (isNewRidForFile) {
      chain.push(rid)
      editPendingRequestIdsByFileKey.set(fileKey, chain)
    }

    // Baseline used for hunk computation/undo-hunk. Important: treat "" as a valid baseline.
    const hasBaseline = editPendingBaselineByFileKey.has(fileKey)
    // Only use last-reviewed/last-known snapshots when starting a *new* pending chain for a file.
    // If a file already has pending edits (baseline exists), we must keep the earliest baseline stable.
    const isStartingNewPendingChain = !hadPendingChain && !hasBaseline
    const lastReviewed = isStartingNewPendingChain ? editLastReviewedDocTextByFileKey.get(fileKey) : undefined
    const lastKnown = isStartingNewPendingChain ? editLastKnownDocTextByFileKey.get(fileKey) : undefined
    const baseline =
      isStartingNewPendingChain && typeof lastReviewed === "string"
        ? lastReviewed
        : isStartingNewPendingChain && typeof lastKnown === "string"
          ? lastKnown
          : hasBaseline
            ? editPendingBaselineByFileKey.get(fileKey) ?? ""
            : before
    if (!hasBaseline) editPendingBaselineByFileKey.set(fileKey, baseline)

    const baselineSource =
      isStartingNewPendingChain && typeof lastReviewed === "string"
        ? "lastReviewed"
        : isStartingNewPendingChain && typeof lastKnown === "string"
          ? "lastKnown"
          : hasBaseline
            ? "pendingBaseline"
            : "diffBefore"

    editsDevLog(
      "cachePendingEditNavFromDiffs:file",
      {
        rid,
        file,
        uriKey,
        fileKey,
        beforeLen: before.length,
        afterLen: after.length,
        baselineLen: baseline.length,
        baselineSource,
        isStartingNewPendingChain,
        lastReviewedLen: isStartingNewPendingChain ? (lastReviewed?.length ?? null) : null,
        lastKnownLen: isStartingNewPendingChain ? (lastKnown?.length ?? null) : null,
        chain,
      },
      { verbose: true },
    )

    // Preserve the earliest baseline for this file within the same request,
    // but also normalize to the earliest baseline across turns.
    const prev = editNavPendingDiffByUri.get(uriKey)
    if (prev && prev.requestId === rid) {
      editNavPendingDiffByUri.set(uriKey, {
        requestId: rid,
        file,
        before: typeof prev.before === "string" ? prev.before : baseline,
        after,
      })
    } else {
      editNavPendingDiffByUri.set(uriKey, { requestId: rid, file, before: baseline, after })
    }

    // If this file is already open with an active nav, refresh its hunks/highlights.
    try {
      const openEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriKey)
      if (openEditor) {
        const pendingNow = editNavPendingDiffByUri.get(uriKey)
        const baseline2 = typeof pendingNow?.before === "string" ? pendingNow.before : baseline
        const hunks = computeEditHunks(baseline2, openEditor.document.getText())

        editsDevLog(
          "cachePendingEditNavFromDiffs:openEditor",
          {
            rid,
            uriKey,
            file,
            fileKey,
            baseline2Len: baseline2.length,
            docLen: openEditor.document.getText().length,
            hunks: hunks.length,
          },
          { verbose: true },
        )

        if (!hunks.length) {
          const existing = editNavByUri.get(uriKey)
          if (existing && existing.fileKey === fileKey) {
            editNavByUri.delete(uriKey)
            if (activeEditNav?.uriKey === uriKey) activeEditNav = null
            try {
              openEditor.setDecorations(editNavAllDeco!, [])
              openEditor.setDecorations(editNavActiveDeco!, [])
            } catch {
              // ignore
            }
            disposeEditFileOverlay(uriKey)
            disposeEditBlockOverlay(uriKey)
            updateEditNavStatusBar()
            updateEditReviewEditorContext()
          }
        } else {
          editNavByUri.set(uriKey, { hunks, requestId: rid, file, fileKey, beforeText: baseline2 })

          const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
          const clamped = Math.max(0, Math.min(cur, hunks.length - 1))
          activeEditNav = { uriKey, index: clamped }
          applyEditNavToEditor(openEditor, hunks, clamped)
          noteLastKnownDocText(fileKey, openEditor.document.getText())
          try {
            editNavCodeLensEmitter?.fire()
          } catch {
            // ignore
          }
          updateEditNavStatusBar()
          updateEditReviewEditorContext()
        }
      }
    } catch {
      // ignore
    }
  }

  // Drop stale keys for this request.
  const prev = editNavPendingUrisByRequestId.get(rid)
  if (prev) {
    for (const k of prev) {
      if (!nextKeys.has(k)) {
        const v = editNavPendingDiffByUri.get(k)
        if (v?.requestId === rid) {
          editNavPendingDiffByUri.delete(k)
          try {
            const fk = (v?.file ? canonicalizeFileKey(v.file) : undefined) ?? editFileKeyByUriKey.get(k)
            if (fk) {
              const arr = editPendingRequestIdsByFileKey.get(fk)
              if (arr && arr.length) {
                const nextArr = arr.filter((x) => x !== rid)
                if (nextArr.length) editPendingRequestIdsByFileKey.set(fk, nextArr)
                else {
                  editPendingRequestIdsByFileKey.delete(fk)
                  editPendingBaselineByFileKey.delete(fk)

                  // If the file just transitioned to "no pending edits", treat the current
                  // document snapshot as a reviewed baseline for the next turn.
                  // (This is a fallback for cases where keep/undo happened outside editor focus.)
                  if (!editLastReviewedDocTextByFileKey.has(fk)) {
                    const snap = editLastKnownDocTextByFileKey.get(fk)
                    if (typeof snap === "string") {
                      editLastReviewedDocTextByFileKey.set(fk, snap)
                    } else {
                      // Best-effort: if we never saw this document in an editor, read from disk.
                      void (async () => {
                        try {
                          const uri = vscode.Uri.parse(k)
                          const bytes = await vscode.workspace.fs.readFile(uri)
                          const text = new TextDecoder("utf-8").decode(bytes)
                          editLastKnownDocTextByFileKey.set(fk, text)
                          editLastReviewedDocTextByFileKey.set(fk, text)
                        } catch {
                          // ignore
                        }
                      })()
                    }
                  }
                }
              }
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }
  editNavPendingUrisByRequestId.set(rid, nextKeys)

  editsDevLog("cachePendingEditNavFromDiffs:done", {
    rid,
    nextKeys: nextKeys.size,
    pendingTotal: editNavPendingDiffByUri.size,
    navTotal: editNavByUri.size,
  })
}

async function maybeAttachEditNavToEditor(editor: vscode.TextEditor) {
  try {
    const uriKey = editor.document.uri.toString()
    const pending = editNavPendingDiffByUri.get(uriKey)
    const existing = editNavByUri.get(uriKey)

    editsDevLog("maybeAttachEditNavToEditor:start", {
      uriKey,
      hasPending: Boolean(pending),
      hasExisting: Boolean(existing?.hunks?.length),
      pendingRid: pending?.requestId,
      existingRid: existing?.requestId,
      pendingFile: pending?.file,
      existingFile: existing?.file,
    })
    if (existing?.hunks?.length) {
      const pendingKey = pending ? canonicalizeFileKey(pending.file) : ""
      if (!pending || (existing.requestId === pending.requestId && existing.fileKey === pendingKey)) {
        updateEditNavStatusBar()
        updateEditReviewEditorContext()
        return
      }
    }
    if (!pending) {
      updateEditNavStatusBar()
      updateEditReviewEditorContext()
      return
    }

    // Compute hunks against the current editor text to stay accurate if the user already typed.
    const hunks = computeEditHunks(pending.before, editor.document.getText())
    editsDevLog(
      "maybeAttachEditNavToEditor:computed",
      {
        uriKey,
        pendingRid: pending.requestId,
        file: pending.file,
        beforeLen: pending.before.length,
        docLen: editor.document.getText().length,
        hunks: hunks.length,
      },
      { verbose: true },
    )
    if (!hunks.length) {
      updateEditNavStatusBar()
      updateEditReviewEditorContext()
      return
    }

    editNavByUri.set(uriKey, { hunks, requestId: pending.requestId, file: pending.file, fileKey: canonicalizeFileKey(pending.file), beforeText: pending.before })
    activeEditNav = { uriKey, index: 0 }
    applyEditNavToEditor(editor, hunks, 0)
    noteLastKnownDocText(canonicalizeFileKey(pending.file), editor.document.getText())
    try {
      editNavCodeLensEmitter?.fire()
    } catch {
      // ignore
    }
    updateEditNavStatusBar()
    updateEditReviewEditorContext()
  } catch {
    // ignore
  }
}

async function refreshEditNavForEditor(editor: vscode.TextEditor) {
  try {
    const uriKey = editor.document.uri.toString()
    const nav = editNavByUri.get(uriKey)
    if (!nav?.beforeText) return

    editsDevLog(
      "refreshEditNavForEditor:start",
      { uriKey, requestId: nav.requestId, file: nav.file, hunksBefore: nav.hunks?.length ?? 0, beforeLen: nav.beforeText.length, docLen: editor.document.getText().length },
      { verbose: true },
    )

    const hunks = computeEditHunks(nav.beforeText, editor.document.getText())
    nav.hunks = hunks
    editNavByUri.set(uriKey, nav)

    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const clamped = hunks.length ? Math.max(0, Math.min(cur, hunks.length - 1)) : 0
    activeEditNav = hunks.length ? { uriKey, index: clamped } : null

    if (hunks.length) {
      applyEditNavToEditor(editor, hunks, clamped)
    } else {
      editor.setDecorations(editNavAllDeco!, [])
      editor.setDecorations(editNavActiveDeco!, [])
    }

    noteLastKnownDocText(nav.fileKey, editor.document.getText())

    editsDevLog(
      "refreshEditNavForEditor:done",
      { uriKey, hunks: hunks.length, activeIndex: activeEditNav?.uriKey === uriKey ? activeEditNav.index : null },
      { verbose: true },
    )
    editNavCodeLensEmitter?.fire()
    updateEditNavStatusBar()
    updateEditReviewEditorContext()
  } catch {
    // ignore
  }
}

function ensureEditNavDecorations() {
  if (!editNavAllDeco) {
    editNavAllDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    })
  }
  if (!editNavActiveDeco) {
    editNavActiveDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
      border: "1px solid",
      borderColor: new vscode.ThemeColor("editor.rangeHighlightBorder"),
    })
  }
}

function applyEditNavToEditor(editor: vscode.TextEditor, hunks: EditHunkNav[], activeIndex: number, opts?: { reveal?: boolean }) {
  if (!hunks.length) return
  ensureEditNavDecorations()
  const doc = editor.document
  const clampLine = (line0: number) => Math.max(0, Math.min(line0, Math.max(0, doc.lineCount - 1)))

  const uriKey = editor.document.uri.toString()

  const allOptions: vscode.DecorationOptions[] = hunks.map((h) => {
    const startLine = clampLine(h.newStartLine0)
    const endLine = clampLine(h.newEndLine0)
    const endChar = doc.lineAt(endLine).text.length
    const range = new vscode.Range(startLine, 0, endLine, endChar)

    return { range }
  })

  const a = Math.max(0, Math.min(activeIndex, hunks.length - 1))
  const h = hunks[a]
  const startLine = clampLine(h.newStartLine0)
  const endLine = clampLine(h.newEndLine0)
  const endChar = doc.lineAt(endLine).text.length
  const activeRange = new vscode.Range(startLine, 0, endLine, endChar)

  editor.setDecorations(editNavAllDeco!, allOptions)
  editor.setDecorations(editNavActiveDeco!, [activeRange])
  if (opts?.reveal) editor.revealRange(activeRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport)

  editsDevLog(
    "applyEditNavToEditor",
    {
      uriKey,
      hunks: hunks.length,
      activeIndex: a,
      reveal: Boolean(opts?.reveal),
      active: { startLine: startLine + 1, endLine: endLine + 1 },
    },
    { verbose: true },
  )
}

const editNavRefreshTimersByUri = new Map<string, any>()
function scheduleRefreshEditNavForEditor(editor: vscode.TextEditor) {
  try {
    const uriKey = editor.document.uri.toString()
    const existing = editNavRefreshTimersByUri.get(uriKey)
    if (existing) {
      try {
        clearTimeout(existing)
      } catch {
        // ignore
      }
    }
    const t = setTimeout(() => {
      editNavRefreshTimersByUri.delete(uriKey)
      try {
        void refreshEditNavForEditor(editor)
      } catch {
        // ignore
      }
    }, 80)
    editNavRefreshTimersByUri.set(uriKey, t)

    editsDevLog("scheduleRefreshEditNavForEditor", { uriKey, delayMs: 80 }, { verbose: true })
  } catch {
    // ignore
  }
}

type WebviewSink = (msg: WebviewOutboundMessage) => void
type ActiveChatView = {
  send: WebviewSink
  requestPermissionFromWebview: (req: any) => Promise<string | undefined>
  requestEditApprovalFromWebview?: (req: any) => Promise<"apply" | "cancel" | undefined>
}

const activeChatViews = new Set<ActiveChatView>()

type WebviewInboundMessage =
  | { type: "webviewReady" }
  | { type: "requestWorkspaceContext" }
  | { type: "cancel" }
  | { type: "chatUserMessage"; text: string }
  | { type: "checkpointAction"; action: "restore" | "redo"; checkpointId: string; redoToken?: string }
  | { type: "uiAction"; action: string; payload?: any }
  | { type: "setActiveAgentProfile"; id: string }
  | { type: "permissionAction"; requestId: string; optionId?: string }
  | { type: "editApprovalAction"; requestId: string; action: "preview" | "apply" | "cancel" }
  | { type: "editReviewAction"; requestId: string; action: "preview" | "keep" | "undo"; file?: string }
  | { type: "questionAction"; requestId: string; action: "reply" | "reject"; answers?: string[][] }

type ChatUiConfig = {
  thinkingStyle?: string
  collapsedTools?: boolean
  terminalTools?: boolean
  generateTitles?: boolean
  terminalOutputLocation?: string
  terminalAutoApprove?: Record<string, unknown>
  terminalAutoApproveNonDefault?: Record<string, unknown>
  terminalAutoReplyToPrompts?: boolean
  terminalEnableAutoApprove?: boolean
  terminalIgnoreDefaultAutoApproveRules?: boolean
  terminalAutoApproveWorkspaceNpmScripts?: boolean
  terminalBlockDetectedFileWrites?: "never" | "outsideWorkspace" | "all"
}

type WebviewOutboundMessage =
  | { type: "init"; extensionName: string }
  | { type: "host"; host: "editor" | "sidebar" }
  | { type: "chatConfig"; config: ChatUiConfig }
  | { type: "workspaceContext"; workspaceFolders: string[] }
  | { type: "agents"; agents: Array<{ id: string; label?: string }> }
  | {
      type: "agentProfile"
      id: string
      label?: string
      allowedOptionalTools?: string[]
      enabledOptionalTools?: string[]
    }
  | {
      type: "lmModels"
      models: Array<{ id: string; name?: string; vendor?: string; rightText?: string }>
      selectedModelId?: string
    }
  | { type: "chatReset" }
  | { type: "chatAppend"; role: "user" | "assistant" | "tool"; text: string }
  | { type: "chatAssistantStart"; initialText?: string }
  | { type: "chatAssistantDelta"; delta: string }
  | { type: "chatThinkingDelta"; delta: string }
  | { type: "chatAssistantEnd" }
  | { type: "chatCheckpoint"; checkpointId: string }
  | { type: "checkpointRedoOffer"; checkpointId: string; redoToken: string }
  | { type: "checkpointRedoClear" }
  | { type: "chatTurnSummary"; text: string; modelId?: string }
  | { type: "chatSetStatus"; status: "idle" | "working" | "thinking" | "running-tools" | "error"; detail?: string }
  | { type: "chatToolInvocationBegin"; invocationId: string; toolName: string; inputPreview?: string }
  | { type: "chatToolInvocationEnd"; invocationId: string; ok: boolean; durationMs?: number; outputPreview?: string; outputFull?: string; toolName?: string }
  // Copilot-like: progress messages (appear inline, persist after completion)
  | { type: "chatProgress"; id?: string; text: string; status?: "running" | "done" | "error"; toolName?: string }
  // Copilot-like: reference messages ("Used X reference")
  | { type: "chatReference"; uri: string; title?: string; iconPath?: string }
  // Copilot-like: permission prompt card (ACP)
  | {
      type: "permissionRequest"
      requestId: string
      title: string
      inputPreview?: string
      options: Array<{ optionId: string; name: string; kind?: string }>
    }
  | { type: "permissionClear"; requestId: string }
  // Copilot-like: question prompt card (http+sse)
  | {
      type: "questionRequest"
      requestId: string
      title: string
      questions: Array<{
        header?: string
        question: string
        multiple?: boolean
        customAllowed?: boolean
        options?: Array<{ label: string; description?: string }>
      }>
    }
  | { type: "questionClear"; requestId: string }
  // Copilot-like: edit approval (approval card + preview/apply/cancel)
  | {
      type: "editApprovalRequest"
      requestId: string
      summary?: string
      files?: Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number }>
      diffStats?: { filesChanged: number; totalFilesChanged?: number; additions: number; deletions: number }
      canPreview?: boolean
    }
  | { type: "editApprovalClear"; requestId: string }
  // Copilot-like: edits / files changed
  | {
      type: "editReviewRequest"
      requestId: string
      summary?: string
      files?: Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number }>
      diffStats?: { filesChanged: number; totalFilesChanged?: number; additions: number; deletions: number }
      canPreview?: boolean
    }
  | { type: "editReviewClear"; requestId: string }
  | {
      type: "editPreviewData"
      requestId: string
      diffs: Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
    }
  | {
      type: "contextChips"
      items: Array<{ id?: string; label: string; badge?: string; title?: string; iconPath?: string }>
    }
  | { type: "toolChips"; items: string[] }
  | {
      type: "hashSuggestions"
      items: Array<{ kind: "file" | "tool"; label: string; detail?: string; insertText?: string }>
    }
  | { type: "lmModels"; models: LmModelInfo[]; selectedModelId?: string }

type ChatRuntimeState = {
  sessionId?: string
  assistantMessageId?: string
  lastEditMessageId?: string
  lastSessionDiffs?: any[]
  activeDirectory?: string
  isBusy: boolean
  log: vscode.OutputChannel
  didLogFirstAssistantDelta?: boolean
  didEmitThinkingTranscriptForTurn?: boolean
  lastProviderAuthPrompt?: { providerID: string; at: number }
  sseAbort?: AbortController
  sseReady?: Promise<void>
  toolStateByCallId: Map<string, string>
  questionCallIdByRequestId: Map<string, string>
  questionPromptedRequestIds: Set<string>
  seenReferenceUris: Set<string>
  baseUrlOverride?: string
  selectedModelId?: string
  activeAgentProfileId?: string

  // Turn-scoped inputs used to generate a one-line completion summary.
  turnSeq?: number
  turnUserText?: string
  turnSummarySteps?: string[]
  // Transcript index captured at the start of the current user turn.
  // Used to implement Copilot-like checkpoint restore (rewind chat to before the turn).
  turnStartTranscriptIndex?: number
  turnAssistantText?: string

  // Copilot-like: minimal transcript to support checkpoint restore/redo.
  transcript?: Array<
    | { kind: "chat"; role: "user" | "assistant"; text: string }
    | { kind: "checkpoint"; checkpointId: string }
  >

  checkpointsById?: Map<
    string,
    {
      id: string
      createdAtMs: number
      transport: "http+sse" | "acp"
      snapshotDiffs: Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
      transcriptIndex: number
      lastRedoToken?: string
      redoPlan?: {
        token: string
        fileOps: Array<{ file: string; op: "write" | "delete"; text?: string }>
        transcript: Array<
          | { kind: "chat"; role: "user" | "assistant"; text: string }
          | { kind: "checkpoint"; checkpointId: string }
        >
      }
    }
  >
  lastCheckpointKey?: string
  activeRedoOffer?: { checkpointId: string; token: string }

  // Copilot-like: per-file keep/undo in the Files changed bar.
  editReviewProcessedFilesByRequestId: Map<string, Set<string>>
  editReviewLastFilesKeyByRequestId: Map<string, string>

  // ACP transport (stdio)
  acp?: {
    process: childProcess.ChildProcessWithoutNullStreams
    connection: any
    sessionId?: string
    initialized?: boolean

    // Cached model list for the Model menu (ACP transport).
    modelsCache?: Array<{ id: string; name?: string; vendor?: string; rightText?: string }>

    // Copilot-like: track one "turn" (one user prompt -> streaming/tool activity) so we can
    // (1) debounce the end of streaming in absence of an explicit "done" event, and
    // (2) group multi-file edits into a single review request.
    turnSeq?: number
    activeTurnId?: string
    activeEditRequestId?: string
    lastUpdateAtMs?: number
    lastToolUpdateAtMs?: number
    lastAssistantChunkAtMs?: number
    turnEndTimer?: ReturnType<typeof setTimeout>
    runningToolCallIds?: Set<string>

    toolStartedAtMs: Map<string, number>
    toolNameById: Map<string, string>
    lastEditDiffs?: Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
    diffsByRequestId: Map<string, Array<{ file: string; additions: number; deletions: number; before: string; after: string }>>
  }
}

function normalizeDiffs(raw: any): Array<{ file: string; additions: number; deletions: number; before: string; after: string }> {
  const diffs = Array.isArray(raw) ? raw : []
  return diffs
    .map((d: any) => {
      const file = String(d?.file ?? "").trim()
      if (!file) return null
      return {
        file,
        additions: Number(d?.additions ?? 0),
        deletions: Number(d?.deletions ?? 0),
        before: typeof d?.before === "string" ? d.before : "",
        after: typeof d?.after === "string" ? d.after : "",
      }
    })
    .filter(Boolean) as Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
}

function computeCheckpointKey(state: ChatRuntimeState, diffs: Array<{ file: string; before: string; after: string }>): string {
  const sid = String(state.sessionId ?? state.acp?.sessionId ?? "").trim() || "(no-session)"
  const head = diffs
    .slice(0, 32)
    .map((d) => `${d.file}:${(d.before || "").length}>${(d.after || "").length}`)
    .join("\n")
  return `${sid}:${fastTextSig(head)}`
}

function replayTranscript(post: (m: WebviewOutboundMessage) => void, transcript: ChatRuntimeState["transcript"]) {
  post({ type: "chatReset" })
  const items = Array.isArray(transcript) ? transcript : []
  for (const it of items) {
    if (!it) continue
    if (it.kind === "checkpoint") post({ type: "chatCheckpoint", checkpointId: String(it.checkpointId) })
    else post({ type: "chatAppend", role: it.role, text: it.text })
  }
}

async function writeTextFileEnsuringDir(uri: vscode.Uri, text: string): Promise<void> {
  try {
    const dirUri = vscode.Uri.file(path.dirname(uri.fsPath))
    await vscode.workspace.fs.createDirectory(dirUri)
  } catch {
    // ignore
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text))
}

async function deleteFileBestEffort(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false })
  } catch {
    // ignore
  }
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri)
    return true
  } catch {
    return false
  }
}

function getCurrentMergedDiffs(state: ChatRuntimeState): Array<{ file: string; additions: number; deletions: number; before: string; after: string }> {
  if (state.acp) {
    try {
      const all: any[] = []
      for (const ds of state.acp.diffsByRequestId.values()) {
        if (Array.isArray(ds) && ds.length) all.push(...ds)
      }
      const merged = mergeDiffsByFile([], normalizeDiffs(all))
      return normalizeDiffs(merged)
    } catch {
      return normalizeDiffs(state.acp.lastEditDiffs)
    }
  }
  return normalizeDiffs(state.lastSessionDiffs)
}

function resolveAnyFileUriForCheckpointWrite(fileLike: string, directory: string): vscode.Uri | undefined {
  const raw = String(fileLike ?? "").trim()
  if (!raw) return
  try {
    if (path.isAbsolute(raw)) return vscode.Uri.file(raw)
  } catch {
    // ignore
  }
  return resolveProjectFileUri(raw, directory, { mustExist: false })
}

async function performCheckpointRestore(post: (m: WebviewOutboundMessage) => void, state: ChatRuntimeState, checkpointIdRaw: string): Promise<void> {
  const checkpointId = String(checkpointIdRaw ?? "").trim()
  if (!checkpointId) return
  const rec = state.checkpointsById?.get(checkpointId)
  if (!rec) {
    vscode.window.showWarningMessage("未找到要还原的检查点。")
    return
  }

  const checkpointDiffs = normalizeDiffs(rec.snapshotDiffs)
  if (!checkpointDiffs.length) {
    vscode.window.showWarningMessage("该检查点没有可还原的 diff 快照。")
    return
  }

  // Restore should revert the workspace back to the baseline before the checkpoint's edits.
  // We do best-effort restore for the files that we have snapshot diffs for (diff.before).
  const checkpointBeforeByFile = new Map<string, { before: string; after: string; additions: number; deletions: number }>()
  for (const d of checkpointDiffs) {
    const key = String(d.file).trim()
    if (!key) continue
    checkpointBeforeByFile.set(key, {
      before: typeof d.before === "string" ? d.before : "",
      after: typeof d.after === "string" ? d.after : "",
      additions: Number.isFinite(d.additions as any) ? Number(d.additions) : 0,
      deletions: Number.isFinite(d.deletions as any) ? Number(d.deletions) : 0,
    })
  }

  const filesToRestore = [...checkpointBeforeByFile.keys()]

  const directory = getDirectoryQuery()

  // Redo should re-apply the checkpoint snapshot's "after" content, not whatever happens
  // to be on disk at the time restore was clicked (which might still be baseline in some flows).
  const redoFileOps: Array<{ file: string; op: "write" | "delete"; text?: string }> = []
  for (const file of filesToRestore) {
    const rel = String(file ?? "").trim()
    if (!rel) continue
    const snap = checkpointBeforeByFile.get(rel)
    if (!snap) continue
    redoFileOps.push({ file: rel, op: "write", text: snap.after })
  }

  // Snapshot transcript for redo before truncation.
  const prevTranscript = Array.isArray(state.transcript) ? [...state.transcript] : []

  // Apply checkpoint baseline (diff.before).
  for (const file of filesToRestore) {
    const rel = String(file ?? "").trim()
    if (!rel) continue

    const uri = resolveAnyFileUriForCheckpointWrite(rel, directory)
    if (!uri) continue

    const snap = checkpointBeforeByFile.get(rel)
    if (!snap) continue

    // Heuristic: if baseline is empty and there were only additions, it is likely a newly created file.
    // In that case, deleting is closer to restoring the baseline.
    const probablyCreated = snap.before === "" && snap.deletions === 0 && snap.additions > 0 && snap.after !== ""
    if (probablyCreated) {
      await deleteFileBestEffort(uri)
      continue
    }
    await writeTextFileEnsuringDir(uri, snap.before)
  }

  // Clear stale diff/UI state (it will be re-emitted by future tool/diff events).
  try {
    if (state.acp) {
      state.acp.diffsByRequestId.clear()
      state.acp.lastEditDiffs = []
    }
    state.lastSessionDiffs = []
    state.editReviewProcessedFilesByRequestId.clear()
    state.editReviewLastFilesKeyByRequestId.clear()
    const requestIds = new Set<string>()
    requestIds.add(EDITS_REVIEW_SESSION_ID)
    if (state.sessionId) requestIds.add(`session:${state.sessionId}`)
    if (state.acp?.activeEditRequestId) requestIds.add(state.acp.activeEditRequestId)
    for (const requestId of requestIds) post({ type: "editReviewClear", requestId })
  } catch {
    // ignore
  }

  // Truncate transcript to checkpoint (inclusive) and replay.
  if (!state.transcript) state.transcript = []

  // Back-compat: older checkpoints stored transcriptIndex as the checkpoint message index (inclusive).
  // Newer checkpoints store transcriptIndex as the transcript length at turn start (exclusive).
  const idx = Number.isFinite(rec.transcriptIndex as any) ? Math.max(0, rec.transcriptIndex) : 0
  let sliceEnd = idx
  try {
    const cur = state.transcript[idx]
    if (cur && (cur as any).kind === "checkpoint" && String((cur as any).checkpointId ?? "") === checkpointId) {
      sliceEnd = idx + 1
    }
  } catch {
    // ignore
  }
  sliceEnd = Math.min(state.transcript.length, Math.max(0, sliceEnd))
  state.transcript = state.transcript.slice(0, sliceEnd)
  replayTranscript(post, state.transcript)
  post({ type: "chatSetStatus", status: "idle" })

  // Offer redo: restore the pre-restore state for touched files + transcript.
  const token = `redo:${Date.now()}:${Math.random().toString(16).slice(2)}`
  rec.redoPlan = { token, fileOps: redoFileOps, transcript: prevTranscript }
  rec.lastRedoToken = token
  state.activeRedoOffer = { checkpointId, token }
  post({ type: "checkpointRedoOffer", checkpointId, redoToken: token })
}

async function performCheckpointRedo(post: (m: WebviewOutboundMessage) => void, state: ChatRuntimeState, checkpointIdRaw: string, redoTokenRaw: string): Promise<void> {
  const checkpointId = String(checkpointIdRaw ?? "").trim()
  const redoToken = String(redoTokenRaw ?? "").trim()
  if (!checkpointId || !redoToken) return
  const rec = state.checkpointsById?.get(checkpointId)
  const plan = rec?.redoPlan
  if (!rec || !plan || plan.token !== redoToken) return

  const directory = getDirectoryQuery()

  for (const op of plan.fileOps) {
    const rel = String(op?.file ?? "").trim()
    if (!rel) continue

    const uri = resolveAnyFileUriForCheckpointWrite(rel, directory)
    if (!uri) continue

    if (op.op === "delete") {
      await deleteFileBestEffort(uri)
      continue
    }
    await writeTextFileEnsuringDir(uri, typeof op.text === "string" ? op.text : "")
  }

  state.transcript = Array.isArray(plan.transcript) ? [...plan.transcript] : []
  replayTranscript(post, state.transcript)
  post({ type: "chatSetStatus", status: "idle" })

  rec.redoPlan = undefined
  state.activeRedoOffer = undefined
  post({ type: "checkpointRedoClear" })

  // Clear stale diff/UI state (it will be re-emitted by future tool/diff events).
  try {
    state.editReviewProcessedFilesByRequestId.clear()
    state.editReviewLastFilesKeyByRequestId.clear()
    const requestIds = new Set<string>()
    requestIds.add(EDITS_REVIEW_SESSION_ID)
    if (state.sessionId) requestIds.add(`session:${state.sessionId}`)
    if (state.acp?.activeEditRequestId) requestIds.add(state.acp.activeEditRequestId)
    for (const requestId of requestIds) post({ type: "editReviewClear", requestId })
  } catch {
    // ignore
  }
}

let chatOutputChannel: vscode.OutputChannel | undefined

function getChatOutputChannel() {
  if (!chatOutputChannel) {
    chatOutputChannel = vscode.window.createOutputChannel("opencode")
  }
  return chatOutputChannel
}

function logLine(state: ChatRuntimeState, message: string) {
  try {
    state.log.appendLine(`[${new Date().toISOString()}] ${message}`)
  } catch {
    // ignore
  }
}

export function activate(context: vscode.ExtensionContext) {
  const out = getChatOutputChannel()
  out.appendLine("opencode: activated")
  out.appendLine(BUILD_MARKER)

  // NOTE: Many edits commands are registered at activation time (outside any chat webview
  // session). They must not reference the per-webview runtime `state` variable.
  const editsCmdState = { log: out } as any

  // If this extension was bundled as a built-in extension, it may include a compiled
  // opencode CLI binary under `cli/`. Make it available in integrated terminals by
  // prepending that directory to PATH (without touching the user's global PATH).
  try {
    const cliDir = path.join(context.extensionPath, "cli")
    if (fs.existsSync(cliDir) && fs.statSync(cliDir).isDirectory()) {
      const env = context.environmentVariableCollection
      const prefix = cliDir + path.delimiter
      env.prepend("PATH", prefix)
      env.prepend("Path", prefix)

      const exe = process.platform === "win32" ? path.join(cliDir, "opencode.exe") : path.join(cliDir, "opencode")
      if (fs.existsSync(exe)) {
        env.replace("OPENCODE_BIN_PATH", exe)

        // Also patch the extension host environment so ACP can spawn `opencode`.
        // environmentVariableCollection only affects integrated terminals.
        try {
          const cur = process.env.PATH ?? process.env.Path ?? ""
          const next = prefix + cur
          process.env.PATH = next
          process.env.Path = next
          process.env.OPENCODE_BIN_PATH = exe
        } catch {
          // ignore
        }
      }

      out.appendLine(`[opencode] bundled CLI detected; prepended to terminal PATH: ${cliDir}`)
    } else {
      out.appendLine("[opencode] bundled CLI not found; using system opencode if available")
    }
  } catch (e) {
    out.appendLine(`[opencode] failed to set up bundled CLI for terminals: ${String((e as any)?.message ?? e)}`)
  }

  try {
    out.appendLine(`[opencode] extensionMode=${context.extensionMode === vscode.ExtensionMode.Development ? "development" : "production"}`)
    out.appendLine(`[opencode] extensionPath=${context.extensionPath}`)
  } catch {
    // ignore
  }

  const noteDocSnapshotIfFile = (doc: vscode.TextDocument | undefined, source: string) => {
    try {
      if (!doc) return
      if (doc.uri.scheme !== "file") return

      const uriKey = doc.uri.toString()
      const fileKey = canonicalizeFileKey(doc.uri.fsPath)
      if (!fileKey) return
      editFileKeyByUriKey.set(uriKey, fileKey)

      const text = doc.getText()
      noteLastKnownDocText(fileKey, text)

      const chain = editPendingRequestIdsByFileKey.get(fileKey)
      const hasPendingChain = Array.isArray(chain) && chain.length > 0
      // Do not overwrite the reviewed baseline while ACP tools are running.
      // Tool-driven edits can arrive before we establish a pending chain.
      const hasRunningTools = acpCaptureRunningToolCallIds && acpCaptureRunningToolCallIds.size > 0
      if (!hasPendingChain && !hasRunningTools) noteLastReviewedDocText(fileKey, text)

      editsDevLog(
        "noteDocSnapshot",
        { source, uriKey, fileKey, docLen: text.length, hasPendingChain },
        {
          verbose: true,
        },
      )
    } catch {
      // ignore
    }
  }

  // ACP fallback: capture workspace fs changes while tools are running.
  // This enables Files changed for tool chains that don't emit diff blocks and don't expose file targets.
  try {
    const recordFsChange = (uri: vscode.Uri, kind: AcpFsChangeKind) => {
      try {
        if (!uri || uri.scheme !== "file") return
        const fsPath = uri.fsPath
        if (shouldIgnoreFsPathForAcpEdits(fsPath)) return
        const uriKey = uri.toString()
        const rec: AcpFsChange = { kind, at: Date.now(), fsPath }

        // ACP session-level pending bar: keep +/− stats in sync when pending files change on disk
        // (apply_patch writes, external tools, deletes).
        try {
          const fk = canonicalizeFileKey(fsPath)
          const relevant =
            (fk && (editPendingBaselineByFileKey.has(fk) || editPendingRequestIdsByFileKey.has(fk))) ||
            editNavPendingDiffByUri.has(uriKey) ||
            editNavByUri.has(uriKey)
          if (relevant) scheduleAcpPendingFilesChangedRefresh(`fs-${kind}`, fk)
        } catch {
          // ignore
        }

        const rid = String(acpCaptureActiveEditRequestId ?? "").trim()
        if (rid) {
          const m = acpFsChangesByEditRequestId.get(rid) ?? new Map<string, AcpFsChange>()
          m.set(uriKey, rec)
          acpFsChangesByEditRequestId.set(rid, m)
        }

        const running = acpCaptureRunningToolCallIds
        if (running && running.size) {
          let i = 0
          for (const toolCallId of running) {
            if (!toolCallId) continue
            const m = acpFsChangesByToolCallId.get(toolCallId) ?? new Map<string, AcpFsChange>()
            m.set(uriKey, rec)
            acpFsChangesByToolCallId.set(toolCallId, m)
            i++
            if (i >= 4) break
          }
        }
      } catch {
        // ignore
      }
    }

    const watcher = vscode.workspace.createFileSystemWatcher("**/*")
    watcher.onDidCreate((uri) => recordFsChange(uri, "create"), null, context.subscriptions)
    watcher.onDidChange((uri) => recordFsChange(uri, "change"), null, context.subscriptions)
    watcher.onDidDelete((uri) => recordFsChange(uri, "delete"), null, context.subscriptions)
    context.subscriptions.push(watcher)
  } catch {
    // ignore
  }

  // Edits debug logging:
  // - Enabled by default in ExtensionMode.Development
  // - Or force-enable via env var OPENCODE_EDITS_DEBUG=1
  // - Verbose logs via OPENCODE_EDITS_DEBUG_VERBOSE=1
  try {
    const cfg = vscode.workspace.getConfiguration("opencode")
    const cfgEnabled = cfg.get<boolean>("dev.editsDebug", false)
    const cfgVerbose = cfg.get<boolean>("dev.editsDebugVerbose", false)
    const envEnabled = isTruthyEnv(process.env.OPENCODE_EDITS_DEBUG)
    const envVerbose = isTruthyEnv(process.env.OPENCODE_EDITS_DEBUG_VERBOSE)

    editsDevLogEnabled = context.extensionMode === vscode.ExtensionMode.Development || envEnabled || cfgEnabled
    editsDevLogVerbose = envVerbose || cfgVerbose

    if (editsDevLogEnabled) {
      out.appendLine(
        `[edits-dev] enabled (mode=${context.extensionMode === vscode.ExtensionMode.Development ? "development" : "prod"}, verbose=${editsDevLogVerbose}, source=${
          envEnabled ? "env" : cfgEnabled ? "settings" : "devMode"
        })`,
      )
    }
  } catch {
    // ignore
  }

  // Terminal auto-approve debug logging:
  // - Enabled by default in ExtensionMode.Development
  // - Or force-enable via env var OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG=1
  // - Verbose logs via OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG_VERBOSE=1
  try {
    const cfg = vscode.workspace.getConfiguration("opencode")
    const cfgEnabled = cfg.get<boolean>("dev.terminalAutoApproveDebug", false)
    const cfgVerbose = cfg.get<boolean>("dev.terminalAutoApproveDebugVerbose", false)
    const envEnabled = isTruthyEnv(process.env.OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG)
    const envVerbose = isTruthyEnv(process.env.OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG_VERBOSE)

    terminalAutoApproveDevLogEnabled = context.extensionMode === vscode.ExtensionMode.Development || envEnabled || cfgEnabled
    terminalAutoApproveDevLogVerbose = envVerbose || cfgVerbose

    if (terminalAutoApproveDevLogEnabled) {
      out.appendLine(
        `[terminal-autoapprove] enabled (mode=${context.extensionMode === vscode.ExtensionMode.Development ? "development" : "prod"}, verbose=${terminalAutoApproveDevLogVerbose}, source=${
          envEnabled ? "env" : cfgEnabled ? "settings" : "devMode"
        })`,
      )
    }
  } catch {
    // ignore
  }

  // Seed a full-document baseline for open editors so we don't depend on ACP diff.before snippets.
  // This is critical for splitting hunks correctly when edits touch multiple non-adjacent locations.
  try {
    for (const doc of vscode.workspace.textDocuments) noteDocSnapshotIfFile(doc, "activate:textDocuments")
  } catch {
    // ignore
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => {
      noteDocSnapshotIfFile(doc, "onDidOpenTextDocument")
    }),
  )

  // Live-update edits debug flags when settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      try {
        if (!e.affectsConfiguration("opencode.dev.editsDebug") && !e.affectsConfiguration("opencode.dev.editsDebugVerbose")) return
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cfgEnabled = cfg.get<boolean>("dev.editsDebug", false)
        const cfgVerbose = cfg.get<boolean>("dev.editsDebugVerbose", false)
        const envEnabled = isTruthyEnv(process.env.OPENCODE_EDITS_DEBUG)
        const envVerbose = isTruthyEnv(process.env.OPENCODE_EDITS_DEBUG_VERBOSE)

        const nextEnabled = context.extensionMode === vscode.ExtensionMode.Development || envEnabled || cfgEnabled
        const nextVerbose = envVerbose || cfgVerbose
        const changed = nextEnabled !== editsDevLogEnabled || nextVerbose !== editsDevLogVerbose
        editsDevLogEnabled = nextEnabled
        editsDevLogVerbose = nextVerbose
        if (changed) {
          out.appendLine(`[edits-dev] ${editsDevLogEnabled ? "enabled" : "disabled"} (verbose=${editsDevLogVerbose})`)
        }
      } catch {
        // ignore
      }
    }),
  )

  // Live-update terminal auto-approve debug flags when settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      try {
        if (!e.affectsConfiguration("opencode.dev.terminalAutoApproveDebug") && !e.affectsConfiguration("opencode.dev.terminalAutoApproveDebugVerbose")) return
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cfgEnabled = cfg.get<boolean>("dev.terminalAutoApproveDebug", false)
        const cfgVerbose = cfg.get<boolean>("dev.terminalAutoApproveDebugVerbose", false)
        const envEnabled = isTruthyEnv(process.env.OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG)
        const envVerbose = isTruthyEnv(process.env.OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG_VERBOSE)

        const nextEnabled = context.extensionMode === vscode.ExtensionMode.Development || envEnabled || cfgEnabled
        const nextVerbose = envVerbose || cfgVerbose
        const changed = nextEnabled !== terminalAutoApproveDevLogEnabled || nextVerbose !== terminalAutoApproveDevLogVerbose
        terminalAutoApproveDevLogEnabled = nextEnabled
        terminalAutoApproveDevLogVerbose = nextVerbose
        if (changed) {
          out.appendLine(`[terminal-autoapprove] ${terminalAutoApproveDevLogEnabled ? "enabled" : "disabled"} (verbose=${terminalAutoApproveDevLogVerbose})`)
        }
      } catch {
        // ignore
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.checkInsetSupport", async () => {
      const createInset = (vscode.window as any).createWebviewTextEditorInset as
        | undefined
        | ((ed: vscode.TextEditor, line: number, height: number) => EditOverlayInset)
      const supported = Boolean(createInset)

      let usable = false
      const hostInfo = `${vscode.env.appName} ${vscode.version}`
      let details = supported ? `createWebviewTextEditorInset 存在（${hostInfo}）` : `createWebviewTextEditorInset 不存在（${hostInfo}）`
      if (supported) {
        const editor = vscode.window.activeTextEditor
        if (editor) {
          try {
            const visible = Array.isArray(editor.visibleRanges) && editor.visibleRanges.length ? editor.visibleRanges[0] : undefined
            const line = Math.max(0, Math.min(visible ? visible.end.line : 0, Math.max(0, editor.document.lineCount - 1)))
            const inset = createInset!(editor, line, 34)
            inset.webview.options = { enableScripts: false }
            inset.webview.html = "<!doctype html><html><body></body></html>"
            inset.dispose()
            usable = true
            details = "可创建并 dispose（可用）"
          } catch (err) {
            const e = err as any
            const name = typeof e?.name === "string" ? e.name : ""
            const message = typeof e?.message === "string" ? e.message : String(e)
            const stack = typeof e?.stack === "string" ? e.stack : ""

            try {
              out.appendLine(`[dev] inset create error: ${name ? name + ": " : ""}${message}`)
              if (stack) out.appendLine(stack)
            } catch {
              // ignore
            }

            const lower = message.toLowerCase()
            const hint =
              lower.includes("proposed") || lower.includes("enable-proposed") || lower.includes("not enabled")
                ? "\n提示：这通常表示宿主要求启用/授权 Proposed API（VSCodium/稳定版 VS Code 可能会直接禁止）。"
                : ""

            details = `创建时抛错：${name ? name + ": " : ""}${message}${hint}`
          }
        } else {
          details = "当前没有激活编辑器，无法冒烟测试创建"
        }
      }

      const msg = supported
        ? `Inset 支持：是（${usable ? "可用" : "可能不可用"}）\n${details}`
        : "Inset 支持：否（createWebviewTextEditorInset 不可用）"
      try {
        out.appendLine(`[dev] ${msg}`)
      } catch {
        // ignore
      }
      void vscode.window.showInformationMessage(msg)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.showEditsDebugStatus", async () => {
      try {
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cfgEnabled = cfg.get<boolean>("dev.editsDebug", false)
        const cfgVerbose = cfg.get<boolean>("dev.editsDebugVerbose", false)
        const envEnabled = isTruthyEnv(process.env.OPENCODE_EDITS_DEBUG)
        const envVerbose = isTruthyEnv(process.env.OPENCODE_EDITS_DEBUG_VERBOSE)
        const mode = context.extensionMode === vscode.ExtensionMode.Development ? "development" : "prod"

        const msg =
          `Edits debug: ${editsDevLogEnabled ? "ON" : "OFF"} (verbose=${editsDevLogVerbose})\n` +
          `mode=${mode}, settings={enabled:${cfgEnabled}, verbose:${cfgVerbose}}, env={enabled:${envEnabled}, verbose:${envVerbose}}\n` +
          `日志在 Output → opencode（[edits-dev] 前缀）。`
        out.appendLine(`[edits-dev] status ${safeJsonForLog({ enabled: editsDevLogEnabled, verbose: editsDevLogVerbose, mode, cfgEnabled, cfgVerbose, envEnabled, envVerbose })}`)
        void vscode.window.showInformationMessage(msg)
      } catch {
        // ignore
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.toggleEditsDebug", async () => {
      try {
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cur = cfg.get<boolean>("dev.editsDebug", false)
        await cfg.update("dev.editsDebug", !cur, vscode.ConfigurationTarget.Global)
        void vscode.window.showInformationMessage(`opencode: dev.editsDebug 已设置为 ${!cur}`)
      } catch (e) {
        void vscode.window.showErrorMessage(`opencode: 无法更新 dev.editsDebug：${String(e)}`)
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.toggleEditsDebugVerbose", async () => {
      try {
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cur = cfg.get<boolean>("dev.editsDebugVerbose", false)
        await cfg.update("dev.editsDebugVerbose", !cur, vscode.ConfigurationTarget.Global)
        void vscode.window.showInformationMessage(`opencode: dev.editsDebugVerbose 已设置为 ${!cur}`)
      } catch (e) {
        void vscode.window.showErrorMessage(`opencode: 无法更新 dev.editsDebugVerbose：${String(e)}`)
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.showTerminalAutoApproveDebugStatus", async () => {
      try {
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cfgEnabled = cfg.get<boolean>("dev.terminalAutoApproveDebug", false)
        const cfgVerbose = cfg.get<boolean>("dev.terminalAutoApproveDebugVerbose", false)
        const envEnabled = isTruthyEnv(process.env.OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG)
        const envVerbose = isTruthyEnv(process.env.OPENCODE_TERMINAL_AUTOAPPROVE_DEBUG_VERBOSE)
        const mode = context.extensionMode === vscode.ExtensionMode.Development ? "development" : "prod"

        const msg =
          `Terminal auto-approve debug: ${terminalAutoApproveDevLogEnabled ? "ON" : "OFF"} (verbose=${terminalAutoApproveDevLogVerbose})\n` +
          `mode=${mode}, settings={enabled:${cfgEnabled}, verbose:${cfgVerbose}}, env={enabled:${envEnabled}, verbose:${envVerbose}}\n` +
          `日志在 Output → opencode（[terminal-autoapprove] 前缀）。`
        out.appendLine(
          `[terminal-autoapprove] status ${safeJsonForLog({ enabled: terminalAutoApproveDevLogEnabled, verbose: terminalAutoApproveDevLogVerbose, mode, cfgEnabled, cfgVerbose, envEnabled, envVerbose })}`,
        )
        void vscode.window.showInformationMessage(msg)
      } catch {
        // ignore
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.toggleTerminalAutoApproveDebug", async () => {
      try {
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cur = cfg.get<boolean>("dev.terminalAutoApproveDebug", false)
        await cfg.update("dev.terminalAutoApproveDebug", !cur, vscode.ConfigurationTarget.Global)
        void vscode.window.showInformationMessage(`opencode: dev.terminalAutoApproveDebug 已设置为 ${!cur}`)
      } catch (e) {
        void vscode.window.showErrorMessage(`opencode: 无法更新 dev.terminalAutoApproveDebug：${String(e)}`)
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.dev.toggleTerminalAutoApproveDebugVerbose", async () => {
      try {
        const cfg = vscode.workspace.getConfiguration("opencode")
        const cur = cfg.get<boolean>("dev.terminalAutoApproveDebugVerbose", false)
        await cfg.update("dev.terminalAutoApproveDebugVerbose", !cur, vscode.ConfigurationTarget.Global)
        void vscode.window.showInformationMessage(`opencode: dev.terminalAutoApproveDebugVerbose 已设置为 ${!cur}`)
      } catch (e) {
        void vscode.window.showErrorMessage(`opencode: 无法更新 dev.terminalAutoApproveDebugVerbose：${String(e)}`)
      }
    }),
  )

  // Copilot-like: per-hunk navigation (decorations + status bar + commands)
  editNavCodeLensEmitter = new vscode.EventEmitter<void>()
  context.subscriptions.push(editNavCodeLensEmitter)

  ensureEditNavStatusBar(context)
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    const editor = vscode.window.activeTextEditor
    if (editor) void maybeAttachEditNavToEditor(editor)
    else {
      updateEditNavStatusBar()
      updateEditReviewEditorContext()
    }
  }))

  // Keep the floating bar near the editor bottom as users scroll.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      try {
        const editor = e?.textEditor
        if (!editor) return
        const uriKey = editor.document.uri.toString()
        const nav = editNavByUri.get(uriKey)
        if (!nav?.hunks?.length) return

        // Reposition the file-level bar as the viewport changes so it stays reachable.
        // Do NOT move per-hunk insets here (those must stay anchored to hunks).
        if (canUseEditInsets()) {
          try {
            const lastCreateAt = editFileOverlayLastCreateAtByUri.get(uriKey) ?? 0
            // If this visible-range event was caused by our own inset mutation,
            // ignore it to avoid scheduling a reposition feedback loop.
            if (lastCreateAt && Date.now() - lastCreateAt < 120) return
          } catch {
            // ignore
          }
          const prev = editFileOverlayRepositionTimerByUri.get(uriKey)
          if (prev) clearTimeout(prev)
          editFileOverlayRepositionTimerByUri.set(
            uriKey,
            setTimeout(() => {
              try {
                void ensureEditFileOverlayForEditor(editor, nav)
              } catch {
                // ignore
              }
            }, 60),
          )
        } else {
          // No inset support: keep editor surface clean; rely on status bar + CodeLens.
          clearEditNavOverlayFallback(editor)
          clearEditNavBlockOverlay(editor)
        }
      } catch {
        // ignore
      }
    }),
  )

  // Keep nav/hunks in sync when a document changes (ACP writes or user edits).
  // This avoids races where we compute overlays before the editor text updates.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      try {
        const doc = e?.document
        if (!doc) return
        const uriKey = doc.uri.toString()
        if (!editNavByUri.has(uriKey) && !editNavPendingDiffByUri.has(uriKey)) return

        // If the user used editor Undo/Redo and the document text now matches the
        // pending baseline, immediately clear pending state + highlights.
        // This avoids stale hunks reappearing (or highlighting "original" content)
        // after an unsaved undo brings the file back to a clean state.
        try {
          if (transport() === "acp" && doc.uri.scheme === "file") {
            const reason = (e as any)?.reason
            const isUndoRedo =
              reason === (vscode as any)?.TextDocumentChangeReason?.Undo ||
              reason === (vscode as any)?.TextDocumentChangeReason?.Redo
            if (isUndoRedo) {
              const fk = canonicalizeFileKey(doc.uri.fsPath)
              if (fk) {
                const pendingBaseline =
                  (editPendingBaselineByFileKey.has(fk) ? (editPendingBaselineByFileKey.get(fk) as string) : undefined) ??
                  (typeof editNavPendingDiffByUri.get(uriKey)?.before === "string" ? (editNavPendingDiffByUri.get(uriKey) as any).before : undefined) ??
                  (typeof editNavByUri.get(uriKey)?.beforeText === "string" ? (editNavByUri.get(uriKey) as any).beforeText : undefined)

                if (typeof pendingBaseline === "string") {
                  const curText = doc.getText()
                  if (curText.length === pendingBaseline.length && curText === pendingBaseline) {
                    noteRecentCleanBaselineSig(fk, uriKey, pendingBaseline, "undo/redo matched baseline")
                    clearAllPendingForFileKeyAndUri(uriKey, fk, "undo/redo matched baseline")
                  }
                }
              }
            }
          }
        } catch {
          // ignore
        }

        // ACP robustness: if the user performed an editor Undo/Redo on a pending file,
        // auto-save so the disk state matches the live buffer.
        try {
          if (transport() === "acp" && doc.uri.scheme === "file" && Boolean((doc as any)?.isDirty)) {
            const reason = (e as any)?.reason
            const isUndoRedo =
              reason === (vscode as any)?.TextDocumentChangeReason?.Undo ||
              reason === (vscode as any)?.TextDocumentChangeReason?.Redo
            if (isUndoRedo) {
              const fk = canonicalizeFileKey(doc.uri.fsPath)
              const relevant =
                (fk && (editPendingBaselineByFileKey.has(fk) || editPendingRequestIdsByFileKey.has(fk))) ||
                editNavPendingDiffByUri.has(uriKey) ||
                editNavByUri.has(uriKey)
              if (relevant) {
                const prev = acpPendingAutoSaveUndoTimerByUri.get(uriKey)
                if (prev) clearTimeout(prev)
                acpPendingAutoSaveUndoTimerByUri.set(
                  uriKey,
                  setTimeout(() => {
                    try {
                      // Re-acquire the doc in case it was replaced.
                      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriKey)
                      if (!open || open.uri.scheme !== "file") return
                      if (!Boolean((open as any)?.isDirty)) return
                      void open.save()
                      editsDevLog("acp pending file auto-saved (undo/redo)", { uriKey, fileKey: fk }, { verbose: true })
                    } catch {
                      // ignore
                    }
                  }, 250),
                )
              }
            }
          }
        } catch {
          // ignore
        }

        // ACP session-level bar: keep +/− stats in sync with live buffer edits.
        try {
          const fk = canonicalizeFileKey(doc.uri.fsPath)
          if (fk) {
            const relevant =
              editPendingBaselineByFileKey.has(fk) ||
              editPendingRequestIdsByFileKey.has(fk) ||
              editNavPendingDiffByUri.has(uriKey) ||
              editNavByUri.has(uriKey)
            if (relevant && Array.isArray(e.contentChanges) && e.contentChanges.length) {
              scheduleAcpPendingFilesChangedRefresh("doc-change", fk)
            }
          }
        } catch {
          // ignore
        }

        // Keep last-known text in sync for pending/visible docs (ACP writes or user edits).
        // Only update reviewed baseline when there is no pending chain.
        noteDocSnapshotIfFile(doc, "onDidChangeTextDocument")

        editsDevLog("onDidChangeTextDocument", {
          uriKey,
          hasNav: editNavByUri.has(uriKey),
          hasPending: editNavPendingDiffByUri.has(uriKey),
          changes: Array.isArray(e.contentChanges) ? e.contentChanges.length : 0,
          reason: (e as any)?.reason,
        })

        const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === uriKey)
        if (!editor) return

        if (!editNavByUri.has(uriKey) && editNavPendingDiffByUri.has(uriKey)) {
          void maybeAttachEditNavToEditor(editor)
        }
        if (editNavByUri.has(uriKey)) {
          editsDevLog("scheduleRefreshEditNavForEditor (doc change)", getEditsDebugSnapshot(uriKey), { verbose: true })
          scheduleRefreshEditNavForEditor(editor)
        }
      } catch {
        // ignore
      }
    }),
  )

  // Per-hunk CodeLens fallback when insets aren't available/usable.
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: "untitled" }], {
      onDidChangeCodeLenses: editNavCodeLensEmitter.event,
      provideCodeLenses(document) {
        try {
          // If the core workbench provides true floating hunk overlays, do not
          // render CodeLens (it is inset-like and would duplicate the UI).
          if (coreEditsOverlayReady && coreEditsOverlaySupportsHunkOverlays) return []

          const uriKey = document.uri.toString()
          const nav = editNavByUri.get(uriKey)
          if (!nav?.hunks?.length) return []

          // Show per-hunk Keep/Undo directly at the hunk location.
          // This is the most reliable per-hunk affordance across VSCodium builds and
          // does not rely on Trusted Types–sensitive DOM injection.

          const clampLine = (line0: number) => Math.max(0, Math.min(line0, Math.max(0, document.lineCount - 1)))
          const lenses: vscode.CodeLens[] = []
          for (const h of nav.hunks) {
            const idx = Number(h.index)
            if (!Number.isFinite(idx) || idx < 0) continue
            const line = clampLine(h.newStartLine0)
            const range = new vscode.Range(line, 0, line, 0)
            lenses.push(
              new vscode.CodeLens(range, {
                title: "保留",
                command: "opencode.edits.keepHunkAt",
                arguments: [{ uri: uriKey, index: idx }],
              }),
            )
            lenses.push(
              new vscode.CodeLens(range, {
                title: "撤销",
                command: "opencode.edits.undoHunkAt",
                arguments: [{ uri: uriKey, index: idx }],
              }),
            )
          }
          return lenses
        } catch {
          return []
        }
      },
    }),
  )

  const gotoHunkDisposable = vscode.commands.registerCommand("opencode.edits.gotoHunk", async (args: any) => {
    try {
      const uriRaw = String(args?.uri ?? "")
      const index = Number(args?.index ?? 0)
      if (!uriRaw) return
      const uri = vscode.Uri.parse(uriRaw)
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })

      let nav = editNavByUri.get(uriRaw)
      if (!nav?.hunks?.length) {
        await maybeAttachEditNavToEditor(editor)
        nav = editNavByUri.get(uriRaw)
      }
      if (!nav?.hunks?.length) return
      const clamped = Math.max(0, Math.min(index, nav.hunks.length - 1))
      activeEditNav = { uriKey: uriRaw, index: clamped }
      applyEditNavToEditor(editor, nav.hunks, clamped, { reveal: true })
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      updateEditNavStatusBar()
    } catch {
      // ignore
    }
  })

  const keepHunkAtDisposable = vscode.commands.registerCommand("opencode.edits.keepHunkAt", async (args: any) => {
    try {
      const uriRaw = String(args?.uri ?? "")
      const index = Number(args?.index ?? 0)
      if (!uriRaw) return
      const uri = vscode.Uri.parse(uriRaw)
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })

      let nav = editNavByUri.get(uriRaw)
      if (!nav?.hunks?.length) {
        await maybeAttachEditNavToEditor(editor)
        nav = editNavByUri.get(uriRaw)
      }
      if (!nav?.hunks?.length) return
      const clamped = Math.max(0, Math.min(index, nav.hunks.length - 1))
      activeEditNav = { uriKey: uriRaw, index: clamped }
      applyEditNavToEditor(editor, nav.hunks, clamped, { reveal: true })
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      updateEditNavStatusBar()
      void vscode.commands.executeCommand("opencode.edits.keepHunk")
    } catch {
      // ignore
    }
  })

  const undoHunkAtDisposable = vscode.commands.registerCommand("opencode.edits.undoHunkAt", async (args: any) => {
    try {
      const uriRaw = String(args?.uri ?? "")
      const index = Number(args?.index ?? 0)
      if (!uriRaw) return
      const uri = vscode.Uri.parse(uriRaw)
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })

      let nav = editNavByUri.get(uriRaw)
      if (!nav?.hunks?.length) {
        await maybeAttachEditNavToEditor(editor)
        nav = editNavByUri.get(uriRaw)
      }
      if (!nav?.hunks?.length) return
      const clamped = Math.max(0, Math.min(index, nav.hunks.length - 1))
      activeEditNav = { uriKey: uriRaw, index: clamped }
      applyEditNavToEditor(editor, nav.hunks, clamped, { reveal: true })
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      updateEditNavStatusBar()
      void vscode.commands.executeCommand("opencode.edits.undoHunk")
    } catch {
      // ignore
    }
  })

  const nextHunkDisposable = vscode.commands.registerCommand("opencode.edits.nextHunk", async () => {
    const editor = pickEditorForEditsCommand()
    if (!editor) {
      warnEditsCmd(editsCmdState, "nextHunk: no editor")
      return
    }
    const uriKey = editor.document.uri.toString()
    infoEditsCmd(editsCmdState, `nextHunk: invoked uri=${uriKey}`)
    let nav = editNavByUri.get(uriKey)
    if (!nav?.hunks?.length) {
      await maybeAttachEditNavToEditor(editor)
      nav = editNavByUri.get(uriKey)
    }
    if (!nav?.hunks?.length) {
      warnEditsCmd(editsCmdState, `nextHunk: no hunks for ${uriKey}`)
      return
    }
    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const next = Math.max(0, Math.min(cur + 1, nav.hunks.length - 1))
    activeEditNav = { uriKey, index: next }
    applyEditNavToEditor(editor, nav.hunks, next, { reveal: true })
    try {
      editNavCodeLensEmitter?.fire()
    } catch {
      // ignore
    }
    updateEditNavStatusBar()
  })

  const prevHunkDisposable = vscode.commands.registerCommand("opencode.edits.prevHunk", async () => {
    const editor = pickEditorForEditsCommand()
    if (!editor) {
      warnEditsCmd(editsCmdState, "prevHunk: no editor")
      return
    }
    const uriKey = editor.document.uri.toString()
    infoEditsCmd(editsCmdState, `prevHunk: invoked uri=${uriKey}`)
    let nav = editNavByUri.get(uriKey)
    if (!nav?.hunks?.length) {
      await maybeAttachEditNavToEditor(editor)
      nav = editNavByUri.get(uriKey)
    }
    if (!nav?.hunks?.length) {
      warnEditsCmd(editsCmdState, `prevHunk: no hunks for ${uriKey}`)
      return
    }
    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const prev = Math.max(0, Math.min(cur - 1, nav.hunks.length - 1))
    activeEditNav = { uriKey, index: prev }
    applyEditNavToEditor(editor, nav.hunks, prev, { reveal: true })
    try {
      editNavCodeLensEmitter?.fire()
    } catch {
      // ignore
    }
    updateEditNavStatusBar()
  })

  const keepHunkDisposable = vscode.commands.registerCommand("opencode.edits.keepHunk", async () => {
    const editor = pickEditorForEditsCommand()
    if (!editor) {
      warnEditsCmd(editsCmdState, "keepHunk: no editor")
      return
    }
    const uriKey = editor.document.uri.toString()
    infoEditsCmd(editsCmdState, `keepHunk: invoked uri=${uriKey}`)
    let nav = editNavByUri.get(uriKey)
    if (!nav?.hunks?.length) {
      await maybeAttachEditNavToEditor(editor)
      nav = editNavByUri.get(uriKey)
    }
    if (!nav?.hunks?.length) {
      warnEditsCmd(editsCmdState, `keepHunk: no hunks for ${uriKey}`)
      return
    }

    infoEditsCmd(editsCmdState, `keepHunk: hunks=${nav.hunks.length} active=${activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0}`)

    editsDevLog("cmd keepHunk:start", getEditsDebugSnapshot(uriKey))

    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const idx = Math.max(0, Math.min(cur, nav.hunks.length - 1))
    const h = nav.hunks[idx]
    if (!h) return

    // Persist the accepted hunk into the baseline so future refreshes don't re-introduce it.
    try {
      if (typeof nav.beforeText === "string") {
        const nextBaseline = applyKeptHunkToBaselineText(nav.beforeText, h)
        nav.beforeText = nextBaseline
        editNavByUri.set(uriKey, nav)

        const fileKey = nav.fileKey ?? (nav.file ? canonicalizeFileKey(nav.file) : undefined)
        if (fileKey && editPendingBaselineByFileKey.has(fileKey)) editPendingBaselineByFileKey.set(fileKey, nextBaseline)

        const pending = editNavPendingDiffByUri.get(uriKey)
        if (pending && pending.file === nav.file && pending.requestId === nav.requestId) {
          editNavPendingDiffByUri.set(uriKey, { ...pending, before: nextBaseline })
        }
      }
    } catch {
      // ignore
    }

    // Recompute hunks against the updated baseline.
    await refreshEditNavForEditor(editor)

    const afterNav = editNavByUri.get(uriKey)
    if (!afterNav?.hunks?.length) {
      activeEditNav = null

      // Record a stable reviewed snapshot for the next turn.
      const fileKey = afterNav?.fileKey ?? (afterNav?.file ? canonicalizeFileKey(afterNav.file) : undefined)
      noteLastKnownDocText(fileKey, editor.document.getText())
      noteLastReviewedDocText(fileKey, editor.document.getText())

      // If the user kept the last remaining hunk, treat the file as reviewed (file-level):
      // keep all requestIds that contributed pending edits for this file and clear pending state.
      try {
        if (fileKey && afterNav?.file && dispatchEditReviewActionFromEditor) {
          const chain = editPendingRequestIdsByFileKey.get(fileKey) ?? (afterNav.requestId ? [afterNav.requestId] : [])
          for (const rid of chain) {
            await dispatchEditReviewActionFromEditor({ requestId: rid, action: "keep", file: afterNav.file })
            removePendingForFileInRequest(uriKey, fileKey, rid)
          }
        }
      } catch {
        // ignore
      }

      editNavByUri.delete(uriKey)
      try {
        editor.setDecorations(editNavAllDeco!, [])
        editor.setDecorations(editNavActiveDeco!, [])
      } catch {
        // ignore
      }
      disposeEditFileOverlay(uriKey)
      disposeEditBlockOverlay(uriKey)
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      updateEditNavStatusBar()
      updateEditReviewEditorContext()
      return
    }

    editsDevLog("cmd keepHunk:done", getEditsDebugSnapshot(uriKey), { verbose: true })
  })

  const undoHunkDisposable = vscode.commands.registerCommand("opencode.edits.undoHunk", async () => {
    const editor = pickEditorForEditsCommand()
    if (!editor) {
      warnEditsCmd(editsCmdState, "undoHunk: no editor")
      return
    }
    const doc = editor.document
    const uriKey = doc.uri.toString()
    infoEditsCmd(editsCmdState, `undoHunk: invoked uri=${uriKey}`)
    let nav = editNavByUri.get(uriKey)
    if (!nav?.hunks?.length) {
      await maybeAttachEditNavToEditor(editor)
      nav = editNavByUri.get(uriKey)
    }
    if (!nav?.hunks?.length) {
      warnEditsCmd(editsCmdState, `undoHunk: no hunks for ${uriKey}`)
      return
    }

    infoEditsCmd(editsCmdState, `undoHunk: hunks=${nav.hunks.length} active=${activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0}`)

    editsDevLog("cmd undoHunk:start", getEditsDebugSnapshot(uriKey))

    const cur = activeEditNav?.uriKey === uriKey ? activeEditNav.index : 0
    const idx = Math.max(0, Math.min(cur, nav.hunks.length - 1))
    const h = nav.hunks[idx]
    if (!h) return

    try {
      const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
      const clampLine = (line0: number) => Math.max(0, Math.min(line0, Math.max(0, doc.lineCount - 1)))
      const startLine0 = clampLine(h.newStartLine0)

      const edit = new vscode.WorkspaceEdit()

      if (h.newLineCount === 0) {
        const insertPos = new vscode.Position(startLine0, 0)
        const insertText = h.oldLinesText.length ? h.oldLinesText.join(eol) + eol : ""
        if (insertText) edit.insert(doc.uri, insertPos, insertText)
      } else {
        const endLine0 = clampLine(startLine0 + Math.max(1, h.newLineCount) - 1)
        const startPos = new vscode.Position(startLine0, 0)
        const endPos = endLine0 + 1 < doc.lineCount ? new vscode.Position(endLine0 + 1, 0) : new vscode.Position(endLine0, doc.lineAt(endLine0).text.length)
        const range = new vscode.Range(startPos, endPos)

        let replaceText = h.oldLinesText.join(eol)
        if (h.oldLinesText.length && endLine0 + 1 < doc.lineCount) replaceText += eol
        edit.replace(doc.uri, range, replaceText)
      }

      const ok = await vscode.workspace.applyEdit(edit)
      if (ok) {
        try {
          await doc.save()
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    await refreshEditNavForEditor(editor)

    editsDevLog("cmd undoHunk:afterRefresh", getEditsDebugSnapshot(uriKey), { verbose: true })

    try {
      const afterNav = editNavByUri.get(uriKey)
      if (afterNav && (!afterNav.hunks || afterNav.hunks.length === 0)) {
        const fk = afterNav.fileKey ?? (afterNav.file ? canonicalizeFileKey(afterNav.file) : undefined)
        noteLastKnownDocText(fk, editor.document.getText())
        noteLastReviewedDocText(fk, editor.document.getText())
        if (afterNav.requestId && afterNav.file && dispatchEditReviewActionFromEditor) {
          void dispatchEditReviewActionFromEditor({ requestId: afterNav.requestId, action: "keep", file: afterNav.file })
        }
        editNavByUri.delete(uriKey)
        try {
          editor.setDecorations(editNavAllDeco!, [])
          editor.setDecorations(editNavActiveDeco!, [])
        } catch {
          // ignore
        }
        try {
          editNavCodeLensEmitter?.fire()
        } catch {
          // ignore
        }
        updateEditNavStatusBar()
      }
    } catch {
      // ignore
    }
  })

  const keepFileDisposable = vscode.commands.registerCommand("opencode.edits.keepFile", async (args?: { uri?: string }) => {
    // Optional uri hint: lets in-editor overlays reliably target the right file
    // even when focus is not in the text editor.
    const hintedUriKey = String(args?.uri ?? "").trim()
    let editor = hintedUriKey
      ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === hintedUriKey) ?? pickEditorForEditsCommand()
      : pickEditorForEditsCommand()
    if (!editor) {
      warnEditsCmd(editsCmdState, `keepFile: no editor (hint=${hintedUriKey || "-"})`)
      return
    }
    const uriKey = hintedUriKey || editor.document.uri.toString()

    // If we were invoked with a hint but couldn't find a matching visible editor,
    // ensure we target the correct document.
    if (hintedUriKey && editor.document.uri.toString() !== hintedUriKey) {
      try {
        const uri = vscode.Uri.parse(hintedUriKey)
        const doc = await vscode.workspace.openTextDocument(uri)
        editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
      } catch (e) {
        warnEditsCmd(editsCmdState, `keepFile: failed to open hinted uri=${hintedUriKey} err=${String((e as any)?.message ?? e)}`)
      }
    }

    infoEditsCmd(editsCmdState, `keepFile: invoked uri=${uriKey} hint=${hintedUriKey ? "yes" : "no"}`)
    try {
      vscode.window.setStatusBarMessage("[opencode] keep file…", 1500)
    } catch {
      // ignore
    }

    let nav = editNavByUri.get(uriKey)
    if (!nav?.requestId || !nav?.file) {
      await maybeAttachEditNavToEditor(editor)
      nav = editNavByUri.get(uriKey)
    }
    if (!nav?.requestId || !nav?.file) {
      warnEditsCmd(editsCmdState, `keepFile: no nav for ${uriKey}`)
      return
    }
    if (!dispatchEditReviewActionFromEditor) {
      warnEditsCmd(editsCmdState, "keepFile: no dispatcher")
      return
    }

    const fileKey = nav.fileKey ?? canonicalizeFileKey(nav.file)
    const chain = editPendingRequestIdsByFileKey.get(fileKey) ?? [nav.requestId]

    infoEditsCmd(editsCmdState, `keepFile: requestId=${nav.requestId} file=${nav.file} chainLen=${chain.length}`)

    // Capture a stable "clean" snapshot to seed the next baseline.
    noteLastKnownDocText(fileKey, editor.document.getText())
    noteLastReviewedDocText(fileKey, editor.document.getText())

    editsDevLog(
      "noteLastReviewedDocText:keepFile",
      { fileKey, uriKey, docLen: editor.document.getText().length, chainLen: chain.length },
      { verbose: true },
    )

    editsDevLog("cmd keepFile:start", { ...getEditsDebugSnapshot(uriKey), action: "keep", chain }, { verbose: true })
    try {
      for (const rid of chain) {
        try {
          infoEditsCmd(editsCmdState, `keepFile: dispatch keep requestId=${rid}`)
          await dispatchEditReviewActionFromEditor({ requestId: rid, action: "keep", file: nav.file })
          infoEditsCmd(editsCmdState, `keepFile: dispatch ok requestId=${rid}`)
        } finally {
          removePendingForFileInRequest(uriKey, fileKey, rid)
        }
      }
    } catch (e) {
      warnEditsCmd(editsCmdState, `keepFile: unexpected error err=${String((e as any)?.message ?? e)}`)
      try {
        vscode.window.setStatusBarMessage("[opencode] keep file ✗", 2000)
      } catch {
        // ignore
      }
      return
    }

    editNavByUri.delete(uriKey)
    activeEditNav = null
    disposeEditFileOverlay(uriKey)
    disposeEditBlockOverlay(uriKey)
    try {
      editor.setDecorations(editNavAllDeco!, [])
      editor.setDecorations(editNavActiveDeco!, [])
    } catch {
      // ignore
    }
    try {
      editNavCodeLensEmitter?.fire()
    } catch {
      // ignore
    }
    updateEditNavStatusBar()
    updateEditReviewEditorContext()

    try {
      vscode.window.setStatusBarMessage("[opencode] keep file ✓", 1500)
    } catch {
      // ignore
    }

    editsDevLog("cmd keepFile:done", { uriKey, fileKey, chain, pendingTotal: editNavPendingDiffByUri.size, navTotal: editNavByUri.size })
  })

  const undoFileDisposable = vscode.commands.registerCommand("opencode.edits.undoFile", async (args?: { uri?: string }) => {
    const hintedUriKey = String(args?.uri ?? "").trim()
    let editor = hintedUriKey
      ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === hintedUriKey) ?? pickEditorForEditsCommand()
      : pickEditorForEditsCommand()
    if (!editor) {
      warnEditsCmd(editsCmdState, `undoFile: no editor (hint=${hintedUriKey || "-"})`)
      return
    }
    const uriKey = hintedUriKey || editor.document.uri.toString()

    if (hintedUriKey && editor.document.uri.toString() !== hintedUriKey) {
      try {
        const uri = vscode.Uri.parse(hintedUriKey)
        const doc = await vscode.workspace.openTextDocument(uri)
        editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })
      } catch (e) {
        warnEditsCmd(editsCmdState, `undoFile: failed to open hinted uri=${hintedUriKey} err=${String((e as any)?.message ?? e)}`)
      }
    }

    infoEditsCmd(editsCmdState, `undoFile: invoked uri=${uriKey} hint=${hintedUriKey ? "yes" : "no"}`)
    try {
      vscode.window.setStatusBarMessage("[opencode] undo file…", 1500)
    } catch {
      // ignore
    }

    let nav = editNavByUri.get(uriKey)
    if (!nav?.requestId || !nav?.file) {
      await maybeAttachEditNavToEditor(editor)
      nav = editNavByUri.get(uriKey)
    }
    if (!nav?.requestId || !nav?.file) {
      warnEditsCmd(editsCmdState, `undoFile: no nav for ${uriKey}`)
      return
    }
    if (!dispatchEditReviewActionFromEditor) {
      warnEditsCmd(editsCmdState, "undoFile: no dispatcher")
      return
    }

    const fileKey = nav.fileKey ?? canonicalizeFileKey(nav.file)
    const chain = editPendingRequestIdsByFileKey.get(fileKey) ?? [nav.requestId]

    infoEditsCmd(editsCmdState, `undoFile: requestId=${nav.requestId} file=${nav.file} chainLen=${chain.length}`)

    // Snapshot the current content, then revert the whole file to the baseline
    // (Copilot-like file-level undo).
    noteLastKnownDocText(fileKey, editor.document.getText())

    try {
      const baseline =
        nav.beforeText ??
        editPendingBaselineByFileKey.get(fileKey) ??
        editLastReviewedDocTextByFileKey.get(fileKey) ??
        editLastKnownDocTextByFileKey.get(fileKey)

      if (typeof baseline === "string") {
        noteRecentCleanBaselineSig(fileKey, uriKey, baseline, "undoFile command")
        const doc = editor.document
        const lastLine = Math.max(0, doc.lineCount - 1)
        const endPos = new vscode.Position(lastLine, doc.lineAt(lastLine).text.length)
        const fullRange = new vscode.Range(new vscode.Position(0, 0), endPos)
        const edit = new vscode.WorkspaceEdit()
        edit.replace(doc.uri, fullRange, baseline)
        const ok = await vscode.workspace.applyEdit(edit)
        if (ok) {
          try {
            await doc.save()
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    editsDevLog("cmd undoFile:start", { ...getEditsDebugSnapshot(uriKey), action: "undo", chain }, { verbose: true })
    for (const rid of Array.from(chain).reverse()) {
      await dispatchEditReviewActionFromEditor({ requestId: rid, action: "undo", file: nav.file })
      removePendingForFileInRequest(uriKey, fileKey, rid)
    }

    // Best-effort: clear decorations, the file content is expected to revert.
    editNavByUri.delete(uriKey)
    activeEditNav = null
    disposeEditFileOverlay(uriKey)
    disposeEditBlockOverlay(uriKey)
    try {
      editor.setDecorations(editNavAllDeco!, [])
      editor.setDecorations(editNavActiveDeco!, [])
    } catch {
      // ignore
    }
    try {
      editNavCodeLensEmitter?.fire()
    } catch {
      // ignore
    }
    updateEditNavStatusBar()
    updateEditReviewEditorContext()

    try {
      vscode.window.setStatusBarMessage("[opencode] undo file ✓", 1500)
    } catch {
      // ignore
    }

    editsDevLog("cmd undoFile:done", { uriKey, fileKey, chain, pendingTotal: editNavPendingDiffByUri.size, navTotal: editNavByUri.size })
  })

  // Workbench core overlay entrypoints.
  // We route these through wrapper commands so we can reliably log/diagnose
  // whether the click reached the extension (Output) without requiring DevTools.
  const overlayKeepDisposable = vscode.commands.registerCommand("opencode.edits.overlayKeep", async () => {
    infoEditsCmd(editsCmdState, "overlayKeep: invoked")
    try {
      vscode.window.setStatusBarMessage("[opencode] Keep", 1500)
    } catch {
      // ignore
    }
    await vscode.commands.executeCommand("opencode.edits.keepHunk")
  })
  const overlayUndoDisposable = vscode.commands.registerCommand("opencode.edits.overlayUndo", async () => {
    infoEditsCmd(editsCmdState, "overlayUndo: invoked")
    try {
      vscode.window.setStatusBarMessage("[opencode] Undo", 1500)
    } catch {
      // ignore
    }
    await vscode.commands.executeCommand("opencode.edits.undoHunk")
  })
  const overlayPrevDisposable = vscode.commands.registerCommand("opencode.edits.overlayPrev", async () => {
    infoEditsCmd(editsCmdState, "overlayPrev: invoked")
    await vscode.commands.executeCommand("opencode.edits.prevHunk")
  })
  const overlayNextDisposable = vscode.commands.registerCommand("opencode.edits.overlayNext", async () => {
    infoEditsCmd(editsCmdState, "overlayNext: invoked")
    await vscode.commands.executeCommand("opencode.edits.nextHunk")
  })

  context.subscriptions.push(overlayKeepDisposable, overlayUndoDisposable, overlayPrevDisposable, overlayNextDisposable)

  context.subscriptions.push(
    gotoHunkDisposable,
    keepHunkAtDisposable,
    undoHunkAtDisposable,
    nextHunkDisposable,
    prevHunkDisposable,
    keepHunkDisposable,
    undoHunkDisposable,
    keepFileDisposable,
    undoFileDisposable,
  )

  const openChatDisposable = vscode.commands.registerCommand("opencode.openChat", async () => {
    await vscode.commands.executeCommand(`${CHAT_SIDEBAR_VIEW_ID}.focus`)
    await ensureChatInSecondarySidebarOnFirstRun(context)
  })

  const openChatInSidebarDisposable = vscode.commands.registerCommand("opencode.openChatInSidebar", async () => {
    await vscode.commands.executeCommand(`${CHAT_SIDEBAR_VIEW_ID}.focus`)
    await ensureChatInSecondarySidebarOnFirstRun(context)
  })

  const openChatInEditorDisposable = vscode.commands.registerCommand("opencode.openChatInEditor", async () => {
    await openChat(context)
  })

  const setupChatLayoutDisposable = vscode.commands.registerCommand("opencode.setupChatLayout", async () => {
    await vscode.commands.executeCommand(`${CHAT_SIDEBAR_VIEW_ID}.focus`)
    await moveFocusedViewToSecondarySidebarBestEffort()
  })

  const authLoginDisposable = vscode.commands.registerCommand("opencode.authLoginInTerminal", async () => {
    await openAuthLoginTerminal(context)
  })

  const authLogoutDisposable = vscode.commands.registerCommand("opencode.authLogoutInTerminal", async () => {
    await openAuthLogoutTerminal(context)
  })

  const listModelsDisposable = vscode.commands.registerCommand("opencode.listModelsInTerminal", async () => {
    await openModelsTerminal(context)
  })

  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal(context)
  })

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }
    await openTerminal(context)
  })

  const devSimulatePermissionDisposable = vscode.commands.registerCommand("opencode.dev.simulatePermissionPrompt", async () => {
    if (activeChatViews.size === 0) {
      await openChat(context)
    }

    const views = Array.from(activeChatViews)
    for (const v of views) {
      const requestId = `dev-perm-${Date.now()}-${Math.random().toString(16).slice(2)}`
      v.send({ type: "chatSetStatus", status: "thinking", detail: "Waiting for approval…" })
      const chosen = await v.requestPermissionFromWebview({
        toolCall: {
          toolCallId: requestId,
          rawInput: { tool: "writeTextFile", path: "src/example.ts", bytes: 128 },
        },
        options: [
          { optionId: "once", name: "允许一次", kind: "once" },
          { optionId: "always", name: "始终允许", kind: "always" },
          { optionId: "reject", name: "拒绝", kind: "reject" },
        ],
      })
      v.send({ type: "chatAppend", role: "assistant", text: chosen ? `权限选择：${chosen}` : "权限选择：未选择（取消/超时）" })
      v.send({ type: "chatSetStatus", status: "idle" })
    }
  })

  const devSimulateTerminalPermissionDisposable = vscode.commands.registerCommand("opencode.dev.simulateTerminalPermissionPrompt", async () => {
    if (activeChatViews.size === 0) {
      await openChat(context)
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    const defaultCwd = workspaceRoot || process.cwd()
    const defaultShell = process.platform === "win32" ? "powershell.exe" : "bash"

    const scenarios: Array<{ label: string; description?: string; commandLine: string; cwd?: string; shell?: string }> = [
      {
        label: "Deny: transient env var prefix",
        description: "FOO=bar ...（应拒绝 auto-approve）",
        commandLine: "FOO=bar echo hi",
      },
      {
        label: "Approve: workspace npm script (if exists)",
        description: "需要启用 chat.tools.terminal.autoApproveWorkspaceNpmScripts，且脚本名在 workspace package.json 里存在",
        commandLine: "npm --silent run test",
        cwd: defaultCwd,
      },
      {
        label: "No file write: 2>&1",
        description: "流重定向不应被当作写文件",
        commandLine: "echo hi 2>&1",
      },
      {
        label: "File write: fd-prefixed redirect (2>file)",
        description: "验证 2>err.log 被识别为写文件",
        commandLine: "echo hi 2>err.log",
      },
      {
        label: "PowerShell file write: all-stream redirect (*>)",
        description: "echo hi *> out.txt",
        commandLine: "echo hi *> out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: all-stream append (*>>)",
        description: "echo hi *>> out.txt",
        commandLine: "echo hi *>> out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell no file write: all-stream to stream (*>&1)",
        description: "echo hi *>&1",
        commandLine: "echo hi *>&1",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "File write: redirect to workspace-relative",
        description: "echo hi > out.txt（带 cwd 以便判 inside workspace）",
        commandLine: "echo hi > out.txt",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Out-File",
        description: "echo hi | Out-File -FilePath out.txt",
        commandLine: "echo hi | Out-File -FilePath out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: pipeline 3-stage + Out-File",
        description: "Get-Process | Format-Table | Out-File out.txt",
        commandLine: "Get-Process | Format-Table | Out-File out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Out-File positional",
        description: "echo hi | Out-File out.txt",
        commandLine: "echo hi | Out-File out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Out-File -FilePath:...",
        description: "echo hi | Out-File -FilePath:out.txt",
        commandLine: "echo hi | Out-File -FilePath:out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Out-File quoted path",
        description: "echo hi | Out-File -FilePath 'out file.txt'",
        commandLine: "echo hi | Out-File -FilePath 'out file.txt'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: tee alias",
        description: "echo hi | tee -FilePath out.txt",
        commandLine: "echo hi | tee -FilePath out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Set-Content",
        description: "Set-Content -Path out.txt -Value 'hi'",
        commandLine: "Set-Content -Path out.txt -Value 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Set-Content positional",
        description: "Set-Content out.txt 'hi'",
        commandLine: "Set-Content out.txt 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: sc alias positional",
        description: "sc out.txt 'hi'",
        commandLine: "sc out.txt 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Set-Content -LiteralPath",
        description: "Set-Content -LiteralPath out.txt -Value 'hi'",
        commandLine: "Set-Content -LiteralPath out.txt -Value 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Set-Content -Path:...",
        description: "Set-Content -Path:out.txt -Value 'hi'",
        commandLine: "Set-Content -Path:out.txt -Value 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Set-Content quoted path",
        description: "Set-Content -Path 'out file.txt' -Value 'hi'",
        commandLine: "Set-Content -Path 'out file.txt' -Value 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Add-Content",
        description: "Add-Content -Path out.txt -Value 'hi'",
        commandLine: "Add-Content -Path out.txt -Value 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Add-Content positional",
        description: "Add-Content out.txt 'hi'",
        commandLine: "Add-Content out.txt 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: ac alias positional",
        description: "ac out.txt 'hi'",
        commandLine: "ac out.txt 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Add-Content -LiteralPath",
        description: "Add-Content -LiteralPath out.txt -Value 'hi'",
        commandLine: "Add-Content -LiteralPath out.txt -Value 'hi'",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: New-Item file",
        description: "New-Item -ItemType File -Path out.txt",
        commandLine: "New-Item -ItemType File -Path out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: New-Item positional path",
        description: "New-Item out.txt -ItemType File",
        commandLine: "New-Item out.txt -ItemType File",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: ni alias positional",
        description: "ni out.txt -ItemType File",
        commandLine: "ni out.txt -ItemType File",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Tee-Object",
        description: "echo hi | Tee-Object -FilePath out.txt",
        commandLine: "echo hi | Tee-Object -FilePath out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Invoke-WebRequest -OutFile",
        description: "Invoke-WebRequest https://example.com -OutFile out.txt",
        commandLine: "Invoke-WebRequest https://example.com -OutFile out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Invoke-WebRequest -OutFile:...",
        description: "Invoke-WebRequest https://example.com -OutFile:out.txt",
        commandLine: "Invoke-WebRequest https://example.com -OutFile:out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: iwr alias -OutFile",
        description: "iwr https://example.com -OutFile out.txt",
        commandLine: "iwr https://example.com -OutFile out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: iwr alias -OutFile:...",
        description: "iwr https://example.com -OutFile:out.txt",
        commandLine: "iwr https://example.com -OutFile:out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: wget alias -OutFile",
        description: "wget https://example.com -OutFile out.txt",
        commandLine: "wget https://example.com -OutFile out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: wget alias -OutFile:...",
        description: "wget https://example.com -OutFile:out.txt",
        commandLine: "wget https://example.com -OutFile:out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Start-Transcript",
        description: "Start-Transcript -Path out.txt",
        commandLine: "Start-Transcript -Path out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Start-Transcript -Path:...",
        description: "Start-Transcript -Path:out.txt",
        commandLine: "Start-Transcript -Path:out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Start-Transcript positional",
        description: "Start-Transcript out.txt",
        commandLine: "Start-Transcript out.txt",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Export-Csv",
        description: "Get-Process | Export-Csv -Path out.csv",
        commandLine: "Get-Process | Export-Csv -Path out.csv",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Export-Clixml",
        description: "Get-Date | Export-Clixml -Path out.xml",
        commandLine: "Get-Date | Export-Clixml -Path out.xml",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: Export-PfxCertificate",
        description: "Export-PfxCertificate -Cert $null -FilePath out.pfx",
        commandLine: "Export-PfxCertificate -Cert $null -FilePath out.pfx",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: .NET WriteAllText",
        description: "[System.IO.File]::WriteAllText('out.txt','hi')",
        commandLine: "[System.IO.File]::WriteAllText('out.txt','hi')",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "PowerShell file write: .NET AppendAllText",
        description: "[IO.File]::AppendAllText('out.txt','hi')",
        commandLine: "[IO.File]::AppendAllText('out.txt','hi')",
        shell: "powershell.exe",
        cwd: defaultCwd,
      },
      {
        label: "Block: interpolation in target",
        description: "目标含 $() 等插值应保守阻止",
        commandLine: "echo hi > $(whoami).txt",
      },
      {
        label: "Custom…",
        description: "输入你自己的 commandLine",
        commandLine: "",
      },
    ]

    const picked = await vscode.window.showQuickPick(
      scenarios.map((s) => ({ label: s.label, description: s.description })),
      { placeHolder: "选择一个 terminal auto-approve 模拟场景" },
    )
    if (!picked) return

    const scenario = scenarios.find((s) => s.label === picked.label)
    if (!scenario) return

    let commandLine = scenario.commandLine
    if (scenario.label === "Custom…") {
      const input = await vscode.window.showInputBox({ prompt: "输入 commandLine（例如：echo hi > out.txt）" })
      if (!input) return
      commandLine = input.trim()
      if (!commandLine) return
    }

    const cwd = scenario.cwd || defaultCwd
    const shell = scenario.shell || defaultShell

    const views = Array.from(activeChatViews)
    for (const v of views) {
      const requestId = `dev-term-perm-${Date.now()}-${Math.random().toString(16).slice(2)}`
      v.send({ type: "chatSetStatus", status: "thinking", detail: "Waiting for approval…" })
      const chosen = await v.requestPermissionFromWebview({
        toolCall: {
          toolCallId: requestId,
          kind: "terminal",
          title: "Terminal",
          rawInput: {
            commandLine,
            cwd,
            shell,
          },
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow" },
          { optionId: "reject", name: "Reject", kind: "reject" },
        ],
      })
      v.send({ type: "chatAppend", role: "assistant", text: chosen ? `Terminal 权限选择：${chosen}` : "Terminal 权限选择：未选择（取消/超时）" })
      v.send({ type: "chatSetStatus", status: "idle" })
    }
  })

  const devSimulateEditApprovalDisposable = vscode.commands.registerCommand("opencode.dev.simulateEditApproval", async () => {
    if (activeChatViews.size === 0) {
      await openChat(context)
    }

    const views = Array.from(activeChatViews)
    for (const v of views) {
      if (!v.requestEditApprovalFromWebview) continue

      const requestId = `dev-edit-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const before = "export const example = 1\n"
      const after = "export const example = 2\nexport const added = true\n"

      const action = await v.requestEditApprovalFromWebview({
        requestId,
        title: "写入文件：src/example.ts",
        diffs: [
          {
            file: "src/example.ts",
            additions: Math.max(0, after.split(/\r?\n/).length - before.split(/\r?\n/).length),
            deletions: Math.max(0, before.split(/\r?\n/).length - after.split(/\r?\n/).length),
            before,
            after,
          },
        ],
      })

      v.send({ type: "chatAppend", role: "assistant", text: action === "apply" ? "Edit approval：已应用" : "Edit approval：已取消/超时" })
      v.send({ type: "chatSetStatus", status: "idle" })
    }
  })

  const devSimulateThinkingDisposable = vscode.commands.registerCommand("opencode.dev.simulateThinkingTranscript", async () => {
    if (activeChatViews.size === 0) {
      await openChat(context)
    }
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

    // Stream as multiple small chunks with delays so the UI visibly appends over time.
    const chunks = [
      "Searching for \"chatThinkingDelta\"…\n",
      "Reading main.js (L1360-L2100)…\n",
      "Running bun run compile…\n",
      "Applying patch to media/main.js…\n",
      "Fetching https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode…\n",
      "完成：验证 transcript 不折叠、按类型换图标、追加自动滚动。\n",
    ]

    for (const v of activeChatViews) {
      v.send({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
      await sleep(200)
      for (const c of chunks) {
        // Split each line into two packets to better simulate streaming.
        const mid = Math.max(1, Math.floor(c.length / 2))
        v.send({ type: "chatThinkingDelta", delta: c.slice(0, mid) })
        await sleep(250)
        v.send({ type: "chatThinkingDelta", delta: c.slice(mid) })
        await sleep(350)
      }
    }
  })

  const addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) return

    const terminal = vscode.window.activeTerminal
    if (!terminal) return

    if (terminal.name === TERMINAL_NAME) {
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
      terminal.show()
    }
  })

  context.subscriptions.push(
    openChatDisposable,
    openChatInSidebarDisposable,
    openChatInEditorDisposable,
    setupChatLayoutDisposable,
    openTerminalDisposable,
    openNewTerminalDisposable,
    addFilepathDisposable,
    authLoginDisposable,
    authLogoutDisposable,
    listModelsDisposable,
    devSimulatePermissionDisposable,
    devSimulateTerminalPermissionDisposable,
    devSimulateEditApprovalDisposable,
    devSimulateThinkingDisposable,
  )

  const sidebarProvider = new (class implements vscode.WebviewViewProvider {
    async resolveWebviewView(webviewView: vscode.WebviewView) {
      out.appendLine("opencode: resolveWebviewView(opencode.chatView)")
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [context.extensionUri],
      }
      webviewView.webview.html = getHtml(context, webviewView.webview, "sidebar")
      const disposable = setupChatWebview(context, webviewView.webview, "sidebar")
      webviewView.onDidDispose(() => disposable.dispose())
    }
  })()

  try {
    out.appendLine("opencode: registering WebviewViewProvider(opencode.chatView)")
    const d = vscode.window.registerWebviewViewProvider(CHAT_SIDEBAR_VIEW_ID, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
    context.subscriptions.push(d)
    out.appendLine("opencode: registered WebviewViewProvider(opencode.chatView)")
  } catch (e) {
    out.appendLine(`opencode: failed to register WebviewViewProvider(opencode.chatView): ${String(e)}`)
  }
}

async function maybeOfferSecondarySidebarTip(context: vscode.ExtensionContext) {
  // Kept for backward compat if referenced elsewhere.
  await ensureChatInSecondarySidebarOnFirstRun(context)
}

async function executeFirstWorkingCommand(commandIds: string[]): Promise<boolean> {
  for (const commandId of commandIds) {
    try {
      await vscode.commands.executeCommand(commandId)
      return true
    } catch {
      // try next
    }
  }
  return false
}

async function showMoveFocusedViewPicker() {
  await executeFirstWorkingCommand(["workbench.action.moveFocusedView", "workbench.action.moveView"])
}

function isAutoMoveToSecondarySidebarEnabled(): boolean {
  return vscode.workspace.getConfiguration("opencode").get<boolean>("chat.autoMoveToSecondarySidebar", true)
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function ensureChatInSecondarySidebarOnFirstRun(context: vscode.ExtensionContext) {
  if (!isAutoMoveToSecondarySidebarEnabled()) return
  if (context.globalState.get<boolean>(DID_AUTO_MOVE_TO_SECONDARY_SIDEBAR_KEY)) return

  // Mark first so we don't keep retrying if user doesn't want it.
  await context.globalState.update(DID_AUTO_MOVE_TO_SECONDARY_SIDEBAR_KEY, true)

  // Give VS Code a moment to actually focus the view.
  await sleep(50)
  const moved = await moveFocusedViewToSecondarySidebarBestEffort({ allowPickerFallback: false })
  if (!moved) {
    const choice = await vscode.window.showInformationMessage(
      "未能自动把 opencode Chat 移到右侧（辅助侧边栏）。你可以手动移动视图位置。",
      "打开“移动视图…”",
      "运行：Setup Chat Layout",
    )

    if (choice === "打开“移动视图…”") {
      await showMoveFocusedViewPicker()
    } else if (choice === "运行：Setup Chat Layout") {
      await vscode.commands.executeCommand("opencode.setupChatLayout")
    }
  }
}

async function moveFocusedViewToSecondarySidebarBestEffort(opts?: { allowPickerFallback?: boolean }): Promise<boolean> {
  // Best-effort: command ids vary across VS Code versions.
  // If none are available, fall back to the Move Focused View picker.
  const moved = await executeFirstWorkingCommand([
    "workbench.action.moveFocusedViewToAuxiliaryBar",
    "workbench.action.moveViewToAuxiliaryBar",
    "workbench.action.moveFocusedViewToSecondarySideBar",
    "workbench.action.moveViewToSecondarySideBar",
  ])

  if (!moved) {
    if (opts?.allowPickerFallback !== false) {
      await showMoveFocusedViewPicker()
    }
    return false
  }

  await executeFirstWorkingCommand(["workbench.action.focusAuxiliaryBar", "workbench.action.toggleAuxiliaryBar"])
  return true
}

async function openChat(context: vscode.ExtensionContext, options?: { moveToNewWindow?: boolean }) {
  const panel = vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, "Chat", vscode.ViewColumn.Beside, {
    enableScripts: true,
    localResourceRoots: [context.extensionUri],
  })
  panel.webview.html = getHtml(context, panel.webview, "editor")

  const disposable = setupChatWebview(context, panel.webview, "editor")
  panel.onDidDispose(() => disposable.dispose())

  if (options?.moveToNewWindow) {
    // Best-effort: relies on VS Code built-in command.
    try {
      await vscode.commands.executeCommand("workbench.action.moveActiveEditorToNewWindow")
    } catch {
      // ignore
    }
  }
}

function setupChatWebview(context: vscode.ExtensionContext, webview: vscode.Webview, host: "editor" | "sidebar"): vscode.Disposable {
  const state: ChatRuntimeState = {
    isBusy: false,
    log: getChatOutputChannel(),
    toolStateByCallId: new Map(),
    questionCallIdByRequestId: new Map(),
    questionPromptedRequestIds: new Set(),
    seenReferenceUris: new Set(),
    editReviewProcessedFilesByRequestId: new Map(),
    editReviewLastFilesKeyByRequestId: new Map(),
    didEmitThinkingTranscriptForTurn: false,
    activeAgentProfileId: String(context.globalState.get<string>(ACTIVE_AGENT_PROFILE_ID_KEY) ?? "").trim() || undefined,
    turnSeq: 0,
    turnAssistantText: "",
    transcript: [],
    checkpointsById: new Map(),
    lastCheckpointKey: undefined,
    activeRedoOffer: undefined,
  }

  // Migration: summary-model selection was removed; prune the legacy globalState key once.
  try {
    if (!context.globalState.get<boolean>(DID_PRUNE_LEGACY_SUMMARY_MODEL_ID_KEY)) {
      const legacy = String(context.globalState.get<string>(LEGACY_SUMMARY_MODEL_ID_KEY) ?? "").trim()
      if (legacy) {
        void context.globalState.update(LEGACY_SUMMARY_MODEL_ID_KEY, undefined)
      }
      void context.globalState.update(DID_PRUNE_LEGACY_SUMMARY_MODEL_ID_KEY, true)
    }
  } catch {
    // ignore
  }

  const isPlanMode = (): boolean => String(state.activeAgentProfileId ?? "").trim() === "plan"

  const inferAgentLabel = (idRaw: string): string => {
    const id = String(idRaw ?? "").trim()
    if (id === "plan") return "Plan"
    if (id === "build") return "Build"
    if (id === "general") return "General"
    return id || "Agent"
  }

  const canWritePathUnderCurrentMode = (absPathRaw: string): boolean => {
    if (!isPlanMode()) return true
    const absPath = String(absPathRaw ?? "").trim()
    if (!absPath) return false

    // Opencode plan agent allows edits only to the plan file under .opencode/plans/*.md.
    // We enforce this in the client to ensure Plan mode can't write arbitrary files.
    const normalized = path.normalize(absPath)
    return /(?:^|[\\/])\.opencode[\\/]plans[\\/].+\.md$/i.test(normalized)
  }

  const postAgentsMenu = (modes?: Array<{ id: string; name?: string }>) => {
    const fallback: Array<{ id: string; label?: string }> = [
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
      { id: "general", label: "General" },
    ]

    const agents: Array<{ id: string; label?: string }> = [...fallback]
    const seen = new Set(agents.map((a) => a.id))

    if (Array.isArray(modes) && modes.length) {
      for (const m of modes) {
        const id = String((m as any)?.id ?? (m as any)?.name ?? "").trim()
        if (!id) continue
        if (seen.has(id)) continue
        seen.add(id)
        agents.push({ id, label: inferAgentLabel(id) })
      }
    }

    post({ type: "agents", agents })
  }

  const postAgentProfile = (idRaw: string | undefined) => {
    const id = String(idRaw ?? "").trim()
    if (!id) return
    post({
      type: "agentProfile",
      id,
      label: inferAgentLabel(id),
      allowedOptionalTools: [],
      enabledOptionalTools: [],
    })
  }

  const getProcessedFilesForEditReview = (requestId: string): Set<string> => {
    let s = state.editReviewProcessedFilesByRequestId.get(requestId)
    if (!s) {
      s = new Set()
      state.editReviewProcessedFilesByRequestId.set(requestId, s)
    }

    // Ensure the set stores canonical file keys.
    try {
      const legacy = Array.from(s)
      s.clear()
      for (const k of legacy) {
        const fk = canonicalizeFileKey(k)
        if (fk) s.add(fk)
      }
    } catch {
      // ignore
    }
    return s
  }

  const computeFilesKey = (diffs: any[]): string => {
    const hashString = (input: string): number => {
      // Fast non-crypto hash (djb2 variant) for change detection.
      let h = 5381
      for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i)
      return h >>> 0
    }

    const textSig = (text: string): string => {
      const s = String(text ?? "")
      const head = s.slice(0, 1024)
      const tail = s.length > 1024 ? s.slice(-1024) : ""
      return `${s.length}:${hashString(head + "\n" + tail)}`
    }

    return diffs
      .map((d) => {
        const f = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
        if (!f) return ""
        const before = typeof d?.before === "string" ? d.before : ""
        const after = typeof d?.after === "string" ? d.after : ""
        // Include a lightweight content signature so we can reset processed state
        // when a file changes again within the same review request.
        return `${f}\n${textSig(before)}\n${textSig(after)}`
      })
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .join("\n\n")
  }

  const computeChangedFilesBetweenDiffs = (prevDiffs: any[], nextDiffs: any[]): Set<string> => {
    const hashString = (input: string): number => {
      let h = 5381
      for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i)
      return h >>> 0
    }

    const textSig = (text: string): string => {
      const s = String(text ?? "")
      const head = s.slice(0, 1024)
      const tail = s.length > 1024 ? s.slice(-1024) : ""
      return `${s.length}:${hashString(head + "\n" + tail)}`
    }

    const diffSig = (d: any): string => {
      const before = typeof d?.before === "string" ? d.before : ""
      const after = typeof d?.after === "string" ? d.after : ""
      return `${textSig(before)}>${textSig(after)}`
    }

    const prev = new Map<string, string>()
    for (const d of Array.isArray(prevDiffs) ? prevDiffs : []) {
      const f = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
      if (!f) continue
      prev.set(f, diffSig(d))
    }

    const changed = new Set<string>()
    for (const d of Array.isArray(nextDiffs) ? nextDiffs : []) {
      const f = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
      if (!f) continue
      const sig = diffSig(d)
      const old = prev.get(f)
      if (!old || old !== sig) changed.add(f)
    }
    return changed
  }

  const mergeDiffsByFile = (existing: any[], incoming: any[]): any[] => {
    // Within a single edit-review request, tools may emit multiple diffs for the same file.
    // We want the net diff: earliest "before" -> latest "after".
    const m = new Map<string, any>()
    for (const d of Array.isArray(existing) ? existing : []) {
      const fileKey = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
      if (!fileKey) continue
      m.set(fileKey, { ...d, fileKey })
    }
    for (const d of Array.isArray(incoming) ? incoming : []) {
      const fileKey = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
      if (!fileKey) continue
      const prev = m.get(fileKey)
      if (!prev) {
        m.set(fileKey, { ...d, fileKey })
        continue
      }

      const before = typeof prev?.before === "string" ? prev.before : typeof d?.before === "string" ? d.before : ""
      const after = typeof d?.after === "string" ? d.after : typeof prev?.after === "string" ? prev.after : ""
      const stats = computeAddDelStats(before, after)
      m.set(fileKey, {
        ...prev,
        ...d,
        file: typeof d?.file === "string" && d.file.trim() ? d.file : prev?.file,
        fileKey,
        before,
        after,
        additions: stats.additions,
        deletions: stats.deletions,
      })
    }
    return Array.from(m.values())
  }

  const resolveAnyFileUri = (fileLike: string): vscode.Uri | undefined => {
    const raw = String(fileLike ?? "").trim()
    if (!raw) return
    try {
      if (path.isAbsolute(raw) && fs.existsSync(raw)) return vscode.Uri.file(raw)
    } catch {
      // ignore
    }
    return resolveProjectFileUri(raw, getDirectoryQuery())
  }

  const tryReadTextFileSync = (absPath: string): string | undefined => {
    try {
      const p = String(absPath ?? "").trim()
      if (!p) return
      if (!path.isAbsolute(p)) return
      if (!fs.existsSync(p)) return
      const buf = fs.readFileSync(p)
      // crude binary guard: NUL byte
      if (buf.includes(0)) return
      return buf.toString("utf8")
    } catch {
      return
    }
  }

  const describeFileFromKey = (fileKey: string): string => {
    const fk = String(fileKey ?? "").trim()
    if (!fk) return ""
    const base = getDirectoryQuery()
    if (!base) return fk
    try {
      const rel = path.relative(base, fk)
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.replace(/\\/g, "/")
    } catch {
      // ignore
    }
    return fk
  }

  const getFileKeyCandidates = (fileLike: string): string[] => {
    const raw = String(fileLike ?? "").trim()
    if (!raw) return []
    const out = new Set<string>()
    const k1 = canonicalizeFileKey(raw)
    if (k1) out.add(k1)
    const uri = resolveAnyFileUri(raw)
    if (uri) {
      const k2 = canonicalizeFileKey(uri.fsPath)
      if (k2) out.add(k2)
    }
    return Array.from(out)
  }

  const buildPendingReviewDiffs = (): Array<{
    file: string
    fileKey: string
    additions: number
    deletions: number
    before: string
    after: string
  }> => {
    // Fold all pending edits across requestIds into one net diff per fileKey.
    const byFileKey = new Map<string, { file: string; before: string; after: string; requestId?: string }>()
    for (const [uriKey, pending] of Array.from(editNavPendingDiffByUri.entries())) {
      const file = String(pending?.file ?? "").trim()
      if (!file) continue

      // Prefer the stable fileKey recorded when the URI was first resolved.
      // This avoids subtle issues where canonicalizeFileKey() can drift if the base directory changes,
      // and prevents unrelated files from being folded together.
      const fileKey = editFileKeyByUriKey.get(uriKey) ?? canonicalizeFileKey(file)
      if (!fileKey) continue

      const requestId = String(pending?.requestId ?? "").trim() || undefined

      const baselineFromPending = typeof pending.before === "string" ? pending.before : ""
      const baselineFromMap = editPendingBaselineByFileKey.has(fileKey) ? (editPendingBaselineByFileKey.get(fileKey) as string) : undefined
      const stableBefore = requestId ? getStableBeforeForRequest(requestId, fileKey) : undefined
      const reviewedBefore = editLastReviewedDocTextByFileKey.get(fileKey)
      const knownBefore = editLastKnownDocTextByFileKey.get(fileKey)

      const baseline =
        typeof baselineFromMap === "string"
          ? baselineFromMap
          : typeof stableBefore === "string"
            ? stableBefore
            : typeof reviewedBefore === "string"
              ? reviewedBefore
              : baselineFromPending

      // After text:
      // - Prefer the open editor buffer when it is dirty (unsaved user edits).
      // - Otherwise prefer disk (authoritative for apply_patch + external edits).
      // - Fall back to last-known cache, then pending.after.
      const afterFromKnown = editLastKnownDocTextByFileKey.get(fileKey)
      let afterFromOpen: string | undefined
      let openIsDirty: boolean | undefined
      try {
        const fkCanon = fileKey
        const open = vscode.workspace.textDocuments.find((d) => {
          try {
            const dk = d?.uri?.scheme === "file" ? canonicalizeFileKey(d.uri.fsPath) : ""
            return Boolean(dk) && dk === fkCanon
          } catch {
            return false
          }
        })
        if (open) {
          afterFromOpen = open.getText()
          openIsDirty = Boolean((open as any)?.isDirty)
        }
      } catch {
        // ignore
      }
      let existsOnDisk = true
      try {
        existsOnDisk = Boolean(fileKey) && path.isAbsolute(fileKey) ? fs.existsSync(fileKey) : true
      } catch {
        existsOnDisk = true
      }

      const afterFromDisk = existsOnDisk ? tryReadTextFileSync(fileKey) : ""
      const afterFromPending = typeof pending.after === "string" ? pending.after : ""

      const after = (() => {
        const open = typeof afterFromOpen === "string" ? afterFromOpen : undefined
        const disk = typeof afterFromDisk === "string" ? afterFromDisk : undefined
        const known = typeof afterFromKnown === "string" ? afterFromKnown : undefined
        if (typeof open === "string" && openIsDirty) return open
        if (typeof disk === "string") {
          // If the doc is open but not dirty, and disk differs, prefer disk (apply_patch/external edits).
          if (typeof open === "string" && !openIsDirty && disk !== open) return disk
          if (!open) return disk
        }
        if (typeof open === "string") return open
        return known ?? afterFromPending
      })()

      byFileKey.set(fileKey, { file, before: baseline, after, requestId })
    }

    // If we lost per-URI pending records (or they were never populated), still try to
    // surface pending diffs from the stable fileKey baselines + last-known content.
    for (const [fileKey, baseline] of Array.from(editPendingBaselineByFileKey.entries())) {
      const fk = String(fileKey ?? "").trim()
      if (!fk) continue
      if (byFileKey.has(fk)) continue

      const before = typeof baseline === "string" ? baseline : ""
      const afterBest = editLastKnownDocTextByFileKey.get(fk)
      let afterFromOpen: string | undefined
      let openIsDirty: boolean | undefined
      try {
        const fkCanon = fk
        const open = vscode.workspace.textDocuments.find((d) => {
          try {
            const dk = d?.uri?.scheme === "file" ? canonicalizeFileKey(d.uri.fsPath) : ""
            return Boolean(dk) && dk === fkCanon
          } catch {
            return false
          }
        })
        if (open) {
          afterFromOpen = open.getText()
          openIsDirty = Boolean((open as any)?.isDirty)
        }
      } catch {
        // ignore
      }
      let existsOnDisk = true
      try {
        existsOnDisk = Boolean(fk) && path.isAbsolute(fk) ? fs.existsSync(fk) : true
      } catch {
        existsOnDisk = true
      }

      const disk = existsOnDisk ? tryReadTextFileSync(fk) : ""
      const open = typeof afterFromOpen === "string" ? afterFromOpen : undefined
      const known = typeof afterBest === "string" ? afterBest : undefined
      const after = (() => {
        if (typeof open === "string" && openIsDirty) return open
        if (typeof disk === "string") {
          if (typeof open === "string" && !openIsDirty && disk !== open) return disk
          if (!open) return disk
        }
        return open ?? known ?? ""
      })()
      const file = describeFileFromKey(fk)
      if (!file) continue
      byFileKey.set(fk, { file, before, after })
    }

    const diffs: Array<{ file: string; fileKey: string; additions: number; deletions: number; before: string; after: string }> = []
    for (const [fileKey, rec] of Array.from(byFileKey.entries())) {
      const before = typeof rec.before === "string" ? rec.before : ""
      const after = typeof rec.after === "string" ? rec.after : ""
      const stats = computeAddDelStats(before, after)
      diffs.push({ file: rec.file, fileKey, additions: stats.additions, deletions: stats.deletions, before, after })
    }
    return diffs
  }

  const postPendingEditsReviewBar = (summary?: string) => {
    if (transport() !== "acp") return
    const pendingAll = buildPendingReviewDiffs()

    // Safety: prune stale/no-op pending state (net diff is empty).
    // This prevents showing `1 file changed +0 -0` and avoids future refresh work.
    try {
      const noopFileKeys = new Set(pendingAll.filter((d: any) => String(d?.before ?? "") === String(d?.after ?? "")).map((d: any) => String(d?.fileKey ?? "").trim()).filter(Boolean))
      if (noopFileKeys.size) {
        for (const fk of noopFileKeys) {
          editPendingBaselineByFileKey.delete(fk)
          editPendingRequestIdsByFileKey.delete(fk)
        }

        for (const [uriKey, p] of Array.from(editNavPendingDiffByUri.entries())) {
          try {
            const fk = editFileKeyByUriKey.get(uriKey) ?? canonicalizeFileKey(String(p?.file ?? "").trim())
            if (!fk || !noopFileKeys.has(fk)) continue

            editNavPendingDiffByUri.delete(uriKey)

            const rid = String(p?.requestId ?? "").trim()
            if (rid) {
              const set = editNavPendingUrisByRequestId.get(rid)
              if (set) {
                set.delete(uriKey)
                if (set.size === 0) editNavPendingUrisByRequestId.delete(rid)
                else editNavPendingUrisByRequestId.set(rid, set)
              }
            }

            // Best-effort: clear any in-editor nav/overlays that might still be attached.
            clearEditNavForUriKey(uriKey)
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    const pending = pendingAll.filter((d: any) => String(d?.before ?? "") !== String(d?.after ?? ""))
    if (!pending.length) {
      editsDevLog("postPendingEditsReviewBar:clear", { sessionId: EDITS_REVIEW_SESSION_ID }, { verbose: true })
      post({ type: "editReviewClear", requestId: EDITS_REVIEW_SESSION_ID })
      return
    }

    const files = pending
      .map((d: any) => {
        const relativePath = String(d?.file ?? "").trim()
        if (!relativePath) return null
        const additions = Number(d?.additions ?? 0)
        const deletions = Number(d?.deletions ?? 0)
        const editCount = Math.max(0, additions + deletions)

        const before = typeof d?.before === "string" ? d.before : ""
        const after = typeof d?.after === "string" ? d.after : ""
        const existsNow = Boolean(resolveAnyFileUri(relativePath))
        const changeType = before === "" && after !== "" ? "A" : after === "" && before !== "" && !existsNow ? "D" : "M"

        return { relativePath, editCount, additions, deletions, changeType }
      })
      .filter(Boolean) as Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number; changeType?: string }>

    const diffStats = {
      filesChanged: files.length,
      totalFilesChanged: files.length,
      additions: pending.reduce((sum: number, d: any) => sum + Number(d?.additions ?? 0), 0),
      deletions: pending.reduce((sum: number, d: any) => sum + Number(d?.deletions ?? 0), 0),
    }

    post({
      type: "editReviewRequest",
      requestId: EDITS_REVIEW_SESSION_ID,
      summary: summary ?? "Files changed",
      files,
      diffStats,
      canPreview: files.length > 0,
    })
  }

  const findPendingReviewDiffForFile = (fileLike: string): { diff?: any; requestId?: string } => {
    const file = String(fileLike ?? "").trim()
    if (!file) return {}
    const keyCandidates = getFileKeyCandidates(file)
    if (!keyCandidates.length) return {}

    const diffs = buildPendingReviewDiffs()
    const diff =
      diffs.find((d) => {
        const fk = String(d?.fileKey ?? "").trim()
        return fk && keyCandidates.includes(fk)
      }) ||
      diffs.find((d) => {
        const fk = canonicalizeFileKey(String(d?.file ?? "").trim())
        return fk && keyCandidates.includes(fk)
      }) ||
      diffs.find((d) => String(d?.file ?? "").trim() === file)

    let requestId: string | undefined
    for (const fk of keyCandidates) {
      const chain = editPendingRequestIdsByFileKey.get(fk)
      if (chain && chain.length) {
        requestId = chain[chain.length - 1]
        break
      }
    }
    return { diff, requestId }
  }

  const computeChangedAfterRange = (before: string, after: string): { startLine: number; endLine: number } | undefined => {
    const a = String(after ?? "").split(/\r?\n/)
    const b = String(before ?? "").split(/\r?\n/)
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    if (start >= a.length && start >= b.length) return
    let endA = a.length - 1
    let endB = b.length - 1
    while (endA >= start && endB >= start && a[endA] === b[endB]) {
      endA--
      endB--
    }
    if (endA < start) endA = start
    return { startLine: start, endLine: endA }
  }

  const revealAndHighlightEdit = async (diff: any) => {
    const file = String(diff?.file ?? "").trim()
    if (!file) return
    const uri = resolveAnyFileUri(file)
    if (!uri) return
    try {
      const doc = await vscode.workspace.openTextDocument(uri)
      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })

      const before = typeof diff?.before === "string" ? diff.before : ""
      const after = typeof diff?.after === "string" ? diff.after : ""
      const r = computeChangedAfterRange(before, after)
      if (!r) return

      const startLine = Math.max(0, Math.min(r.startLine, doc.lineCount - 1))
      const endLine = Math.max(0, Math.min(r.endLine, doc.lineCount - 1))
      const endChar = doc.lineAt(endLine).text.length
      const range = new vscode.Range(startLine, 0, endLine, endChar)

      const deco = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      })
      editor.setDecorations(deco, [range])
      setTimeout(() => {
        try {
          deco.dispose()
        } catch {
          // ignore
        }
      }, 4000)
    } catch {
      // ignore
    }
  }

  const openChangedFileForDiff = async (diff: any, opts?: { requestId?: string; hunkIndex?: number }) => {
    const file = String(diff?.file ?? "").trim()
    if (!file) return

    const before = typeof diff?.before === "string" ? diff.before : ""
    const after = typeof diff?.after === "string" ? diff.after : ""

    let uri = resolveAnyFileUri(file)
    if (!uri) uri = resolveProjectFileUri(file, getDirectoryQuery(), { mustExist: false })

    try {
      let doc: vscode.TextDocument
      if (uri) {
        try {
          doc = await vscode.workspace.openTextDocument(uri)
        } catch {
          doc = await vscode.workspace.openTextDocument({ content: after || before })
        }
      } else {
        doc = await vscode.workspace.openTextDocument({ content: after || before })
      }

      const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false })

      // Preserve the earliest baseline for stable hunk navigation as diffs arrive incrementally.
      // IMPORTANT: ACP diff payloads may include *partial* before/after snippets (not the full file).
      // Always compute hunks against the actual opened document text when available.
      const uriKey = doc.uri.toString()
      const existing = editNavByUri.get(uriKey)
      const fileKey = canonicalizeFileKey(file)

      const baselineFromPending = fileKey ? editPendingBaselineByFileKey.get(fileKey) : undefined
      const baselineFromExisting = existing && existing.fileKey === fileKey && typeof existing.beforeText === "string" ? existing.beforeText : undefined
      const baselineBefore =
        typeof baselineFromPending === "string"
          ? baselineFromPending
          : typeof baselineFromExisting === "string"
            ? baselineFromExisting
            : before

      const afterForHunks = !doc.isUntitled ? editor.document.getText() : after || before

      editsDevLog(
        "openChangedFileForDiff:hunksInput",
        { uriKey, file, fileKey, baselineLen: baselineBefore.length, afterLen: String(afterForHunks ?? "").length, diffAfterLen: after.length, isUntitled: doc.isUntitled },
        { verbose: true },
      )

      const hunks = computeEditHunks(baselineBefore, afterForHunks)
      if (!hunks.length) {
        await revealAndHighlightEdit(diff)
        return
      }

      editNavByUri.set(uriKey, { hunks, requestId: opts?.requestId, file, fileKey, beforeText: baselineBefore })

      const desiredIndexRaw = Number(opts?.hunkIndex ?? 0)
      const desiredIndex = Number.isFinite(desiredIndexRaw) ? desiredIndexRaw : 0
      const clamped = Math.max(0, Math.min(desiredIndex, hunks.length - 1))
      activeEditNav = { uriKey, index: clamped }

      applyEditNavToEditor(editor, hunks, clamped)
      noteLastKnownDocText(fileKey, editor.document.getText())
      try {
        editNavCodeLensEmitter?.fire()
      } catch {
        // ignore
      }
      updateEditNavStatusBar()
      updateEditReviewEditorContext()
    } catch {
      // ignore
    }
  }

  const getLatestReviewDiffs = async (): Promise<any[]> => {
    if (transport() === "acp") return Array.isArray(state.acp?.lastEditDiffs) ? state.acp!.lastEditDiffs! : []
    return await getLatestSessionDiffs(state)
  }

  const handleEditReviewAction = async (input: { requestId: string; action: "preview" | "keep" | "undo"; file?: string }) => {
    const requestId = String(input.requestId ?? "").trim()
    const action = input.action
    const file = String(input.file ?? "").trim()
    if (!requestId) return
    const fileKeyInput = file ? canonicalizeFileKey(file) : ""

    const mode = transport()
    if (mode !== "acp" && !state.sessionId) {
      if (action === "keep") {
        post({ type: "editReviewClear", requestId })
        return
      }
      vscode.window.showWarningMessage("尚未创建会话，无法处理 edits 操作。")
      return
    }
    // Copilot-like: the webview "Files changed" bar is session-level.
    // When actions come from that bar, treat requestId as a synthetic session id.
    if (mode === "acp" && requestId === EDITS_REVIEW_SESSION_ID) {
      const pendingDiffs = buildPendingReviewDiffs()

      if (action === "preview") {
        post({
          type: "editPreviewData",
          requestId,
          diffs: pendingDiffs.map((d: any) => ({
            file: String(d?.file ?? "").trim(),
            additions: Number(d?.additions ?? 0),
            deletions: Number(d?.deletions ?? 0),
            before: typeof d?.before === "string" ? d.before : "",
            after: typeof d?.after === "string" ? d.after : "",
          })),
        })
        return
      }

      if (action === "keep") {
        const target = fileKeyInput ? [fileKeyInput] : pendingDiffs.map((d: any) => String(d?.fileKey ?? "").trim()).filter(Boolean)
        const uniqueFileKeys = Array.from(new Set(target)).filter(Boolean)

        for (const fk of uniqueFileKeys) {
          const chain = editPendingRequestIdsByFileKey.get(fk) ?? []
          for (const rid of chain) getProcessedFilesForEditReview(rid).add(fk)

          // Remove pending diffs for this file only.
          const uriKeys: string[] = []
          for (const [uriKey, pending] of Array.from(editNavPendingDiffByUri.entries())) {
            const pendingFk = editFileKeyByUriKey.get(uriKey) ?? (pending?.file ? canonicalizeFileKey(pending.file) : "")
            if (pendingFk && pendingFk === fk) uriKeys.push(uriKey)
          }

          for (const uriKey of uriKeys.length ? uriKeys : []) {
            for (const rid of chain) removePendingForFileInRequest(uriKey, fk, rid)
            clearEditNavForUriKey(uriKey)
          }

          // If we couldn't find a pending uriKey, still clear request chain + baseline.
          if (!uriKeys.length && chain.length) {
            const next = chain.filter(Boolean)
            for (const rid of next) {
              const cur = editPendingRequestIdsByFileKey.get(fk) ?? []
              const filtered = cur.filter((x) => x !== rid)
              if (filtered.length) editPendingRequestIdsByFileKey.set(fk, filtered)
              else {
                editPendingRequestIdsByFileKey.delete(fk)
                editPendingBaselineByFileKey.delete(fk)
              }
            }
          }
        }

        postPendingEditsReviewBar("Files changed")
        return
      }

      if (action === "undo") {
        // Undo all pending edits across all files by restoring the earliest baseline.
        const diffsToUndo = fileKeyInput
          ? pendingDiffs.filter((d: any) => String(d?.fileKey ?? "").trim() === fileKeyInput)
          : pendingDiffs

        if (!diffsToUndo.length) {
          vscode.window.showWarningMessage("未找到可撤销的 edits diff。")
          post({ type: "editReviewClear", requestId: EDITS_REVIEW_SESSION_ID })
          return
        }

          try {
            for (const d of diffsToUndo) {
              const f = String(d?.file ?? "").trim()
              const fk = String(d?.fileKey ?? "").trim() || canonicalizeFileKey(f)
              if (!f || !fk) continue

              const before = typeof d?.before === "string" ? d.before : ""
              let uri = resolveAnyFileUri(f)
              if (!uri) uri = resolveProjectFileUri(f, getDirectoryQuery(), { mustExist: false })
              if (!uri) continue

              if (before === "") {
                try {
                  await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false })
                } catch {
                  // ignore
                }
              } else {
                try {
                  const dirUri = vscode.Uri.file(path.dirname(uri.fsPath))
                  await vscode.workspace.fs.createDirectory(dirUri)
                } catch {
                  // ignore
                }
                await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before))
              }

              const chain = editPendingRequestIdsByFileKey.get(fk) ?? []
              for (const rid of chain) getProcessedFilesForEditReview(rid).add(fk)

              // Remove pending diffs for this file only.
              const uriKey = uri.toString()
              for (const rid of chain) removePendingForFileInRequest(uriKey, fk, rid)
              clearEditNavForUriKey(uriKey)
            }

            vscode.window.setStatusBarMessage("已撤销更改", 3000)
            postPendingEditsReviewBar("Files changed")
            return
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            vscode.window.showErrorMessage(`撤销失败：${message}`)
            return
          }
      }
    }

    const diffsAll =
      mode === "acp"
        ? (state.acp?.diffsByRequestId.get(requestId) ?? state.acp?.lastEditDiffs ?? [])
        : await getLatestSessionDiffs(state)

    if (action === "preview") {
      const diffsFiltered = file
        ? diffsAll.filter((d: any) => {
            const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
            return fk && fk === fileKeyInput
          })
        : diffsAll
      post({
        type: "editPreviewData",
        requestId,
        diffs: diffsFiltered.map((d: any) => ({
          file: String(d?.file ?? "").trim(),
          additions: Number(d?.additions ?? 0),
          deletions: Number(d?.deletions ?? 0),
          before: typeof d?.before === "string" ? d.before : "",
          after: typeof d?.after === "string" ? d.after : "",
        })),
      })
      return
    }

    if (action === "keep") {
      if (!file) {
        // Copilot-like: keep all just dismisses the UI.
        post({ type: "editReviewClear", requestId })
        clearPendingEditNavForRequest(requestId)
        return
      }

      const processed = getProcessedFilesForEditReview(requestId)
      if (fileKeyInput) processed.add(fileKeyInput)

      if (mode === "acp") {
        const remaining = diffsAll.filter((d: any) => {
          const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
          return fk && !processed.has(fk)
        })
        state.acp!.lastEditDiffs = remaining
      }

      refreshEditReviewUiFromDiffs(requestId, diffsAll, { summary: "Files changed" })
      return
    }

    if (action === "undo") {
      if (!file) {
        // Undo all
        if (mode === "acp") {
          const diffs = diffsAll
          if (!diffs.length) {
            vscode.window.showWarningMessage("未找到可撤销的 edits diff。")
            return
          }
          try {
            for (const d of diffs) {
              const f = String(d?.file ?? "").trim()
              if (!f) continue
              const before = typeof d?.before === "string" ? d.before : ""
              const after = typeof d?.after === "string" ? d.after : ""

              let uri = resolveAnyFileUri(f)
              if (!uri) uri = resolveProjectFileUri(f, getDirectoryQuery(), { mustExist: false })
              if (!uri) continue

              // If the edit created a new file, undo should remove it.
              if (before === "" && after !== "") {
                try {
                  await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false })
                } catch {
                  // ignore
                }
                continue
              }

              try {
                const dirUri = vscode.Uri.file(path.dirname(uri.fsPath))
                await vscode.workspace.fs.createDirectory(dirUri)
              } catch {
                // ignore
              }
              await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before))
            }
            vscode.window.setStatusBarMessage("已撤销更改", 3000)
            post({ type: "editReviewClear", requestId })
            state.acp?.diffsByRequestId.delete(requestId)
            clearPendingEditNavForRequest(requestId)
            return
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            vscode.window.showErrorMessage(`撤销失败：${message}`)
            return
          }
        }

        const messageID = String(state.lastEditMessageId ?? "").trim() || String(state.assistantMessageId ?? "").trim()
        if (!messageID) {
          vscode.window.showWarningMessage("未找到可撤销的编辑来源（messageID）。")
          return
        }
        try {
          await revertMessage(state, state.sessionId!, messageID)
          post({ type: "editReviewClear", requestId })
          clearPendingEditNavForRequest(requestId)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`撤销失败：${message}`)
        }
        return
      }

      // Undo single file
      if (mode !== "acp") {
        vscode.window.showWarningMessage("当前 transport 不支持单文件撤销，请使用“撤销全部”。")
        return
      }

      const diff = diffsAll.find((d: any) => String(d?.file ?? "").trim() === file)
      const diffByKey = fileKeyInput
        ? diffsAll.find((d: any) => {
            const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
            return fk && fk === fileKeyInput
          })
        : undefined
      const diffToUse = diffByKey || diff
      if (!diffToUse) {
        vscode.window.showWarningMessage(`未找到可撤销的 diff：${file}`)
        return
      }
      try {
        const before = typeof diffToUse?.before === "string" ? diffToUse.before : ""
        const after = typeof diffToUse?.after === "string" ? diffToUse.after : ""

        let uri = resolveAnyFileUri(file)
        if (!uri) uri = resolveProjectFileUri(file, getDirectoryQuery(), { mustExist: false })
        if (uri) {
          if (before === "" && after !== "") {
            try {
              await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false })
            } catch {
              // ignore
            }
          } else {
            try {
              const dirUri = vscode.Uri.file(path.dirname(uri.fsPath))
              await vscode.workspace.fs.createDirectory(dirUri)
            } catch {
              // ignore
            }
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before))
          }
        }

        const processed = getProcessedFilesForEditReview(requestId)
        if (fileKeyInput) processed.add(fileKeyInput)

        const remaining = diffsAll.filter((d: any) => {
          const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
          return fk && !processed.has(fk)
        })
        state.acp!.lastEditDiffs = remaining

        vscode.window.setStatusBarMessage("已撤销文件更改", 2500)
        refreshEditReviewUiFromDiffs(requestId, diffsAll, { summary: "Files changed" })
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        vscode.window.showErrorMessage(`撤销失败：${message}`)
        return
      }
    }
  }

  // Allow editor overlay actions (file-level Keep/Undo) to reuse the same handler.
  dispatchEditReviewActionFromEditor = async (input: { requestId: string; action: "keep" | "undo"; file?: string }) => {
    await handleEditReviewAction({ requestId: input.requestId, action: input.action, file: input.file })
  }

  const refreshEditReviewUiFromDiffs = (requestId: string, diffsAll: any[], opts?: { summary?: string }) => {
    const processed = getProcessedFilesForEditReview(requestId)
    const remainingDiffs = diffsAll.filter((d: any) => {
      const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
      if (!fk) return false
      return !processed.has(fk)
    })

    if (!remainingDiffs.length) {
      post({ type: "editReviewClear", requestId })
      clearPendingEditNavForRequest(requestId)
      if (transport() === "acp") {
        // Session-level bar may still have pending edits from other requestIds.
        const pending = buildPendingReviewDiffs()
        if (!pending.length) {
          editsDevLog("refreshEditReviewUiFromDiffs:sessionClear", { rid: requestId }, { verbose: true })
          post({ type: "editReviewClear", requestId: EDITS_REVIEW_SESSION_ID })
        }
        else {
          const files = pending
            .map((d: any) => {
              const relativePath = String(d?.file ?? "").trim()
              if (!relativePath) return null
              const additions = Number(d?.additions ?? 0)
              const deletions = Number(d?.deletions ?? 0)
              const editCount = Math.max(0, additions + deletions)

              const before = typeof d?.before === "string" ? d.before : ""
              const after = typeof d?.after === "string" ? d.after : ""
              const existsNow = Boolean(resolveAnyFileUri(relativePath))
              const changeType = before === "" && after !== "" ? "A" : after === "" && before !== "" && !existsNow ? "D" : "M"
              return { relativePath, editCount, additions, deletions, changeType }
            })
            .filter(Boolean) as Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number; changeType?: string }>

          const diffStats = {
            filesChanged: files.length,
            totalFilesChanged: files.length,
            additions: pending.reduce((sum: number, d: any) => sum + Number(d?.additions ?? 0), 0),
            deletions: pending.reduce((sum: number, d: any) => sum + Number(d?.deletions ?? 0), 0),
          }

          editsDevLog(
            "refreshEditReviewUiFromDiffs:sessionPost",
            {
              rid: requestId,
              sessionId: EDITS_REVIEW_SESSION_ID,
              pendingMapTotal: editNavPendingDiffByUri.size,
              pendingFileKeys: pending.map((d: any) => String(d?.fileKey ?? "").trim()).filter(Boolean).slice(0, 8),
              pendingFiles: files.map((f: any) => String(f?.relativePath ?? "").trim()).filter(Boolean).slice(0, 8),
              pendingCount: files.length,
              additions: diffStats.additions,
              deletions: diffStats.deletions,
            },
            { verbose: true },
          )

          post({
            type: "editReviewRequest",
            requestId: EDITS_REVIEW_SESSION_ID,
            summary: opts?.summary ?? "Files changed",
            files,
            diffStats,
            canPreview: files.length > 0,
          })
        }
      }
      return
    }

    // Cache diffs so editor-side status bar actions can appear even when users open files manually.
    cachePendingEditNavFromDiffs(requestId, remainingDiffs, (file) => {
      let uri = resolveAnyFileUri(file)
      if (!uri) uri = resolveProjectFileUri(file, getDirectoryQuery(), { mustExist: false })
      return uri
    })

    if (transport() === "acp") {
      const pending = buildPendingReviewDiffs()
      if (!pending.length) {
        editsDevLog("refreshEditReviewUiFromDiffs:sessionClear", { rid: requestId }, { verbose: true })
        post({ type: "editReviewClear", requestId: EDITS_REVIEW_SESSION_ID })
        return
      }

      const files = pending
        .map((d: any) => {
          const relativePath = String(d?.file ?? "").trim()
          if (!relativePath) return null
          const additions = Number(d?.additions ?? 0)
          const deletions = Number(d?.deletions ?? 0)
          const editCount = Math.max(0, additions + deletions)

          const before = typeof d?.before === "string" ? d.before : ""
          const after = typeof d?.after === "string" ? d.after : ""
          const existsNow = Boolean(resolveAnyFileUri(relativePath))
          const changeType = before === "" && after !== "" ? "A" : after === "" && before !== "" && !existsNow ? "D" : "M"

          return { relativePath, editCount, additions, deletions, changeType }
        })
        .filter(Boolean) as Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number; changeType?: string }>

      const diffStats = {
        filesChanged: files.length,
        totalFilesChanged: files.length,
        additions: pending.reduce((sum: number, d: any) => sum + Number(d?.additions ?? 0), 0),
        deletions: pending.reduce((sum: number, d: any) => sum + Number(d?.deletions ?? 0), 0),
      }

      editsDevLog(
        "refreshEditReviewUiFromDiffs:sessionPost",
        {
          rid: requestId,
          sessionId: EDITS_REVIEW_SESSION_ID,
          pendingMapTotal: editNavPendingDiffByUri.size,
          pendingFileKeys: pending.map((d: any) => String(d?.fileKey ?? "").trim()).filter(Boolean).slice(0, 8),
          pendingFiles: files.map((f: any) => String(f?.relativePath ?? "").trim()).filter(Boolean).slice(0, 8),
          pendingCount: files.length,
          additions: diffStats.additions,
          deletions: diffStats.deletions,
        },
        { verbose: true },
      )

      post({
        type: "editReviewRequest",
        requestId: EDITS_REVIEW_SESSION_ID,
        summary: opts?.summary ?? "Files changed",
        files,
        diffStats,
        canPreview: files.length > 0,
      })

      return
    }

    const totalFilesChanged = new Set(
      diffsAll
        .map((d: any) => (typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)))
        .filter((f: string) => Boolean(f))
    ).size

    const files = remainingDiffs
      .map((d: any) => {
        const relativePath = String(d?.file ?? "").trim()
        const additions = Number(d?.additions ?? 0)
        const deletions = Number(d?.deletions ?? 0)
        const editCount = Math.max(0, additions + deletions)
        if (!relativePath) return null

        const before = typeof d?.before === "string" ? d.before : ""
        const after = typeof d?.after === "string" ? d.after : ""
        const exists = Boolean(resolveAnyFileUri(relativePath))
        const changeType = !exists && after === "" && before !== "" ? "D" : before === "" && exists ? "A" : "M"

        return { relativePath, editCount, additions, deletions, changeType }
      })
      .filter(Boolean) as Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number; changeType?: string }>

    const diffStats = {
      filesChanged: files.length,
      totalFilesChanged,
      // Copilot-like: header stats should reflect the whole batch, not only remaining files.
      additions: diffsAll.reduce((sum: number, d: any) => sum + Number(d?.additions ?? 0), 0),
      deletions: diffsAll.reduce((sum: number, d: any) => sum + Number(d?.deletions ?? 0), 0),
    }

    post({
      type: "editReviewRequest",
      requestId,
      summary: opts?.summary ?? "Files changed",
      files,
      diffStats,
      canPreview: files.length > 0,
    })
  }

  // Prefer an existing opencode terminal port, otherwise fall back to last known server base URL.
  const discovered = discoverOpencodeServerBaseUrlFromTerminal()
  const lastBaseUrl = context.globalState.get<string>(LAST_SERVER_BASE_URL_KEY)
  if (discovered) {
    state.baseUrlOverride = discovered
    void context.globalState.update(LAST_SERVER_BASE_URL_KEY, discovered)
  } else if (lastBaseUrl) {
    state.baseUrlOverride = lastBaseUrl
  }

  let webviewIsReady = false
  const outboundQueue: WebviewOutboundMessage[] = []

  const rawPost = (msg: WebviewOutboundMessage) => void webview.postMessage(msg)
  const post = (msg: WebviewOutboundMessage) => {
    if (webviewIsReady) rawPost(msg)
    else outboundQueue.push(msg)
  }
  const flushOutboundQueue = () => {
    if (!webviewIsReady) return
    while (outboundQueue.length) rawPost(outboundQueue.shift()!)
  }

  const transport = () => getTransportMode()

  const readChatUiConfig = (): ChatUiConfig => {
    // These settings belong to VS Code's built-in Chat/Agent UI. Opentride uses a webview,
    // so we mirror a small subset to align the UX with user expectations.
    const cfg = vscode.workspace.getConfiguration("chat")

    const rawThinkingStyle = cfg.get<any>("agent.thinkingStyle")
    const thinkingStyle = typeof rawThinkingStyle === "string" ? rawThinkingStyle.trim() : undefined

    const rawCollapsedTools = cfg.get<any>("agent.thinking.collapsedTools")
    let collapsedTools: boolean | undefined
    if (typeof rawCollapsedTools === "boolean") {
      collapsedTools = rawCollapsedTools
    } else if (typeof rawCollapsedTools === "string") {
      const v = rawCollapsedTools.trim().toLowerCase()
      if (v === "never" || v === "false" || v === "off" || v === "disabled") collapsedTools = false
      else if (v === "always" || v === "true" || v === "on" || v === "enabled") collapsedTools = true
    }

    const rawGenerateTitles = cfg.get<any>("agent.thinking.generateTitles")
    const generateTitles = typeof rawGenerateTitles === "boolean" ? rawGenerateTitles : undefined

    const rawTerminalTools = cfg.get<any>("agent.thinking.terminalTools")
    const terminalTools = typeof rawTerminalTools === "boolean" ? rawTerminalTools : undefined

    const rawTerminalOutputLocation = cfg.get<any>("tools.terminal.outputLocation")
    const terminalOutputLocation = typeof rawTerminalOutputLocation === "string" ? rawTerminalOutputLocation.trim() : undefined

    const rawTerminalEnableAutoApprove = cfg.get<any>("tools.terminal.enableAutoApprove")
    const terminalEnableAutoApprove = typeof rawTerminalEnableAutoApprove === "boolean" ? rawTerminalEnableAutoApprove : undefined

    const rawTerminalIgnoreDefaultAutoApproveRules = cfg.get<any>("tools.terminal.ignoreDefaultAutoApproveRules")
    const terminalIgnoreDefaultAutoApproveRules = typeof rawTerminalIgnoreDefaultAutoApproveRules === "boolean" ? rawTerminalIgnoreDefaultAutoApproveRules : undefined

    const rawTerminalAutoApproveWorkspaceNpmScripts = cfg.get<any>("tools.terminal.autoApproveWorkspaceNpmScripts")
    const terminalAutoApproveWorkspaceNpmScripts = typeof rawTerminalAutoApproveWorkspaceNpmScripts === "boolean" ? rawTerminalAutoApproveWorkspaceNpmScripts : undefined

    const rawTerminalBlockDetectedFileWrites = cfg.get<any>("tools.terminal.blockDetectedFileWrites")
    const terminalBlockDetectedFileWrites =
      rawTerminalBlockDetectedFileWrites === "never" || rawTerminalBlockDetectedFileWrites === "outsideWorkspace" || rawTerminalBlockDetectedFileWrites === "all"
        ? rawTerminalBlockDetectedFileWrites
        : undefined

    const rawTerminalAutoApprove = cfg.get<any>("tools.terminal.autoApprove")
    let terminalAutoApprove: Record<string, unknown> | undefined
    if (rawTerminalAutoApprove && typeof rawTerminalAutoApprove === "object" && !Array.isArray(rawTerminalAutoApprove)) {
      try {
        terminalAutoApprove = JSON.parse(JSON.stringify(rawTerminalAutoApprove)) as Record<string, unknown>
      } catch {
        terminalAutoApprove = undefined
      }
    }

    // Best-effort: derive the merged non-default rules (user/workspace) so we can emulate
    // `chat.tools.terminal.ignoreDefaultAutoApproveRules` similarly to VS Code.
    let terminalAutoApproveNonDefault: Record<string, unknown> | undefined
    try {
      const insp = cfg.inspect<any>("tools.terminal.autoApprove") as any
      const mergeObjects = (a: any, b: any): any => {
        if (!b || typeof b !== "object" || Array.isArray(b)) return a
        const out: any = { ...(a && typeof a === "object" ? a : {}) }
        for (const [k, v] of Object.entries(b)) out[k] = v
        return out
      }
      // `inspect()` can expose different buckets depending on VS Code version/environment.
      // Merge in increasing precedence order to approximate VS Code's config layering.
      const merged = [
        insp?.userValue,
        insp?.globalValue,
        insp?.userLocalValue,
        insp?.userRemoteValue,
        insp?.workspaceValue,
        insp?.workspaceFolderValue,
      ].reduce((acc, cur) => mergeObjects(acc, cur), undefined as any)
      if (merged && typeof merged === "object" && !Array.isArray(merged) && Object.keys(merged).length) {
        terminalAutoApproveNonDefault = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>
      }
    } catch {
      terminalAutoApproveNonDefault = undefined
    }

    const rawTerminalAutoReplyToPrompts = cfg.get<any>("tools.terminal.autoReplyToPrompts")
    const terminalAutoReplyToPrompts = typeof rawTerminalAutoReplyToPrompts === "boolean" ? rawTerminalAutoReplyToPrompts : undefined

    return {
      thinkingStyle,
      collapsedTools,
      terminalTools,
      generateTitles,
      terminalOutputLocation,
      terminalAutoApprove,
      terminalAutoApproveNonDefault,
      terminalAutoReplyToPrompts,
      terminalEnableAutoApprove,
      terminalIgnoreDefaultAutoApproveRules,
      terminalAutoApproveWorkspaceNpmScripts,
      terminalBlockDetectedFileWrites,
    }
  }

  const postChatUiConfig = () => {
    try {
      post({ type: "chatConfig", config: readChatUiConfig() })
    } catch {
      // ignore
    }
  }

  const chatConfigDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
    if (
      e.affectsConfiguration("chat.agent.thinkingStyle") ||
      e.affectsConfiguration("chat.agent.thinking.collapsedTools") ||
      e.affectsConfiguration("chat.agent.thinking.generateTitles") ||
      e.affectsConfiguration("chat.agent.thinking.terminalTools") ||
      e.affectsConfiguration("chat.tools.terminal.outputLocation") ||
      e.affectsConfiguration("chat.tools.terminal.autoApprove") ||
      e.affectsConfiguration("chat.tools.terminal.ignoreDefaultAutoApproveRules") ||
      e.affectsConfiguration("chat.tools.terminal.autoApproveWorkspaceNpmScripts") ||
      e.affectsConfiguration("chat.tools.terminal.blockDetectedFileWrites") ||
      e.affectsConfiguration("chat.tools.terminal.autoReplyToPrompts") ||
      e.affectsConfiguration("chat.tools.terminal.enableAutoApprove") ||
      e.affectsConfiguration("chat.agent.thinking")
    ) {
      postChatUiConfig()
    }
  })

  const withTimeout = async <T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
    let t: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          t = setTimeout(
            () => reject(new Error(`${label} timed out after ${timeoutMs}ms (see Opencode output for ACP stderr)`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (t) clearTimeout(t)
    }
  }

  const getAcpInitializeTimeoutMs = (): number => {
    const cfg = vscode.workspace.getConfiguration("opencode")
    const raw = Number(cfg.get<any>("acpInitializeTimeoutMs"))
    if (Number.isFinite(raw) && raw > 0) return Math.max(1_000, Math.floor(raw))
    return 60_000
  }

  const getAcpNewSessionTimeoutMs = (): number => {
    const cfg = vscode.workspace.getConfiguration("opencode")
    const raw = Number(cfg.get<any>("acpNewSessionTimeoutMs"))
    if (Number.isFinite(raw) && raw > 0) return Math.max(1_000, Math.floor(raw))
    return 60_000
  }

  const resolveLocalOpencodeAcpSpawn = (projectCwd: string): { command: string; args: string[] } | undefined => {
    try {
      const repoRootUri = getOpentrideRepoRootFromExtension(context) ?? getOpentrideRepoRootFromWorkspace()
      const repoRoot = repoRootUri?.fsPath
      if (!repoRoot) return

      const opencodePkg = path.resolve(repoRoot, "packages", "opencode")
      const entry = path.resolve(opencodePkg, "src", "index.ts")
      if (!fs.existsSync(entry)) return

      // If bun isn't available, fall back to global `opencode` command.
      if (!findBunExecutable() && !hasBunOnPath()) return

      // bun run --cwd <opencodePkg> src/index.ts acp --cwd <project>
      const args = ["run", "--cwd", opencodePkg, "src/index.ts", "acp", "--cwd", projectCwd]
      return { command: "bun", args }
    } catch {
      return
    }
  }

  // --- Copilot-like: automatic active editor context chips ---
  type ContextEntry = {
    id: string
    kind: "auto-active-file" | "file"
    uri: vscode.Uri
    label: string
    title: string
    badge?: string
    iconPath?: string
  }

  const AUTO_ACTIVE_FILE_CONTEXT_ID = "auto:active-file"
  let suppressedAutoActiveFileKey: string | undefined
  const contextById = new Map<string, ContextEntry>()

  const normalizeRelPath = (p: string): string => {
    const v = String(p ?? "").replaceAll("\\\\", "/").trim()
    return v.replace(/^\/+/, "")
  }

  type WorkspaceFileIndex = {
    builtAt: number
    relPaths: string[]
    building?: Promise<void>
  }

  const WORKSPACE_FILE_INDEX_TTL_MS = 45_000
  const WORKSPACE_FILE_INDEX_MAX_ITEMS = 8000
  const WORKSPACE_FILE_INDEX_EXCLUDE = "**/{node_modules,.git,dist,build,out,.vscode-test}/**"

  let workspaceFileIndex: WorkspaceFileIndex | undefined

  const ensureWorkspaceFileIndex = async (): Promise<WorkspaceFileIndex> => {
    const now = Date.now()
    if (workspaceFileIndex && now - workspaceFileIndex.builtAt <= WORKSPACE_FILE_INDEX_TTL_MS) return workspaceFileIndex
    if (workspaceFileIndex?.building) {
      await workspaceFileIndex.building
      return workspaceFileIndex
    }

    workspaceFileIndex = workspaceFileIndex || { builtAt: 0, relPaths: [] }
    const building = (async () => {
      try {
        const uris = await vscode.workspace.findFiles("**/*", WORKSPACE_FILE_INDEX_EXCLUDE, WORKSPACE_FILE_INDEX_MAX_ITEMS)
        const relPaths = uris
          .map((u) => normalizeRelPath(String(vscode.workspace.asRelativePath(u, false))))
          .filter(Boolean)
        workspaceFileIndex = { builtAt: Date.now(), relPaths }
      } catch {
        workspaceFileIndex = { builtAt: Date.now(), relPaths: [] }
      }
    })().finally(() => {
      if (workspaceFileIndex?.building === building) workspaceFileIndex.building = undefined
    })

    workspaceFileIndex.building = building
    await building
    return workspaceFileIndex
  }

  const canonicalizeFileContextId = (uri: vscode.Uri): { id: string; relative: string } => {
    const relativeRaw = vscode.workspace.asRelativePath(uri, false)
    const relative = normalizeRelPath(String(relativeRaw || uri.fsPath))
    const key = process.platform === "win32" ? relative.toLowerCase() : relative
    return { id: `file:${key}`, relative }
  }

  const inferContextBadgeText = (relativePath: string): string => {
    const p = String(relativePath || "").trim()
    const base = (p.split(/[\\/]/).pop() || "").toLowerCase()
    const ext = (base.split(".").pop() || "").toLowerCase()
    if (base === "package.json" || ext === "json") return "{}"
    if (ext === "css" || ext === "scss" || ext === "less") return "#"
    if (ext === "js" || ext === "jsx") return "JS"
    if (ext === "ts" || ext === "tsx") return "TS"
    if (ext === "md" || ext === "markdown") return "MD"
    if (ext === "yml" || ext === "yaml") return "YAML"
    if (ext === "py") return "PY"
    if (ext === "go") return "GO"
    if (ext === "rs") return "RS"
    if (ext === "java") return "JAVA"
    return ""
  }

  const toContextChip = (id: string, kind: ContextEntry["kind"], uri: vscode.Uri): ContextEntry => {
    const relative = vscode.workspace.asRelativePath(uri, false)
    const label = path.basename(relative || uri.fsPath)
    const badge = inferContextBadgeText(relative)
    return {
      id,
      kind,
      uri,
      label,
      title: relative || uri.fsPath,
      badge: badge || undefined,
      iconPath: "file",
    }
  }

  const postContextChips = () => {
    const items: ContextEntry[] = []
    const activeUriKey = vscode.window.activeTextEditor?.document?.uri?.toString()
    const auto = contextById.get(AUTO_ACTIVE_FILE_CONTEXT_ID)

    const manual = Array.from(contextById.values())
      .filter((e) => e.id !== AUTO_ACTIVE_FILE_CONTEXT_ID)
      .sort((a, b) => a.label.localeCompare(b.label))

    // If the active file is already manually added, do not show a duplicate auto chip.
    if (auto) {
      const { id: fileId } = canonicalizeFileContextId(auto.uri)
      const hasManual = contextById.has(fileId)
      if (!hasManual) items.push(auto)
    }
    items.push(...manual)

    const withActiveMarker = (c: ContextEntry) => {
      const isActive = Boolean(activeUriKey && c.uri.toString() === activeUriKey)
      const label = isActive && !String(c.label).includes("（当前）") ? `${c.label}（当前）` : c.label
      const title = isActive && !String(c.title).startsWith("当前打开的文件：") ? `当前打开的文件：${c.title}` : c.title
      return { label, title }
    }

    post({
      type: "contextChips",
      items: items.map((c) => {
        const x = withActiveMarker(c)
        return {
          id: c.id,
          label: x.label,
          badge: c.badge,
          title: x.title,
          iconPath: c.iconPath,
        }
      }),
    })
  }

  const updateAutoActiveFileContextFromEditor = (editor: vscode.TextEditor | undefined) => {
    const uri = editor?.document?.uri
    if (!uri || uri.scheme !== "file") {
      contextById.delete(AUTO_ACTIVE_FILE_CONTEXT_ID)
      postContextChips()
      return
    }

    const key = uri.toString()
    if (suppressedAutoActiveFileKey && suppressedAutoActiveFileKey !== key) {
      suppressedAutoActiveFileKey = undefined
    }

    if (suppressedAutoActiveFileKey === key) {
      contextById.delete(AUTO_ACTIVE_FILE_CONTEXT_ID)
      postContextChips()
      return
    }

    contextById.set(AUTO_ACTIVE_FILE_CONTEXT_ID, toContextChip(AUTO_ACTIVE_FILE_CONTEXT_ID, "auto-active-file", uri))
    postContextChips()
  }

  const tryReadEditorContextSnippet = (editor: vscode.TextEditor, maxChars: number): { header: string; languageId: string; text: string } | undefined => {
    const doc = editor.document
    const relative = vscode.workspace.asRelativePath(doc.uri, false)
    const languageId = String(doc.languageId || "").trim() || "text"

    const selection = editor.selection
    const visible = Array.isArray(editor.visibleRanges) && editor.visibleRanges.length ? editor.visibleRanges[0] : undefined

    const truncate = (s: string) => {
      const t = String(s || "")
      if (t.length <= maxChars) return t
      return t.slice(0, Math.max(0, maxChars - 32)) + "\n…(truncated)"
    }

    if (selection && !selection.isEmpty) {
      const text = doc.getText(selection)
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1
      return {
        header: `Selected code from ${relative} (L${startLine}-${endLine}):`,
        languageId,
        text: truncate(text),
      }
    }

    if (visible) {
      const text = doc.getText(visible)
      const startLine = visible.start.line + 1
      const endLine = visible.end.line + 1
      return {
        header: `Visible code from ${relative} (L${startLine}-${endLine}):`,
        languageId,
        text: truncate(text),
      }
    }

    const full = doc.getText()
    return {
      header: `File ${relative}:`,
      languageId,
      text: truncate(full),
    }
  }

  const tryReadFileHeadSnippet = async (uri: vscode.Uri, maxLines: number, maxChars: number): Promise<{ header: string; languageId: string; text: string } | undefined> => {
    try {
      if (uri.scheme !== "file") return
      const stat = await vscode.workspace.fs.stat(uri)
      // Avoid slurping huge files into the prompt.
      if (stat.size > 1024 * 512) {
        const rel = vscode.workspace.asRelativePath(uri, false)
        return { header: `File ${rel} (too large to inline):`, languageId: "text", text: "(omitted)" }
      }

      const doc = await vscode.workspace.openTextDocument(uri)
      const rel = vscode.workspace.asRelativePath(uri, false)
      const languageId = String(doc.languageId || "").trim() || "text"
      const endLine = Math.max(0, Math.min(doc.lineCount - 1, Math.max(0, maxLines - 1)))
      const endChar = doc.lineAt(endLine).text.length
      const range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(endLine, endChar))
      let text = doc.getText(range)
      if (text.length > maxChars) {
        text = text.slice(0, Math.max(0, maxChars - 32)) + "\n…(truncated)"
      }
      return { header: `File ${rel} (head):`, languageId, text }
    } catch {
      return
    }
  }

  const formatContextBlock = (snippet: { header: string; languageId: string; text: string }) => {
    const lang = snippet.languageId || "text"
    const body = snippet.text || ""
    return `${snippet.header}\n\n\`\`\`${lang}\n${body}\n\`\`\``
  }

  const buildPromptParts = async (userText: string): Promise<Array<{ type: "text"; text: string }>> => {
    const parts: Array<{ type: "text"; text: string }> = []
    const blocks: string[] = []

    const auto = contextById.get(AUTO_ACTIVE_FILE_CONTEXT_ID)
    if (auto) {
      const active = vscode.window.activeTextEditor
      if (active && active.document.uri.toString() === auto.uri.toString()) {
        const snippet = tryReadEditorContextSnippet(active, 20000)
        if (snippet) blocks.push(formatContextBlock(snippet))
      } else {
        const snippet = await tryReadFileHeadSnippet(auto.uri, 160, 20000)
        if (snippet) blocks.push(formatContextBlock(snippet))
      }
    }

    const manual = Array.from(contextById.values()).filter((e) => e.id !== AUTO_ACTIVE_FILE_CONTEXT_ID)
    for (const e of manual) {
      const snippet = await tryReadFileHeadSnippet(e.uri, 120, 16000)
      if (snippet) blocks.push(formatContextBlock(snippet))
      else blocks.push(`File ${e.title}: (unavailable)`) 
    }

    if (blocks.length) {
      parts.push({ type: "text", text: `Context:\n\n${blocks.join("\n\n")}\n` })
    }
    parts.push({ type: "text", text: userText })
    return parts
  }

  const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    updateAutoActiveFileContextFromEditor(editor)
  })

  const pendingPermissionByRequestId = new Map<string, (optionId: string | undefined) => void>()
  const pendingQuestionByRequestId = new Map<string, (answers: string[][] | undefined) => void>()
  const pendingPermissionTitleByRequestId = new Map<string, string>()
  const pendingQuestionTitleByRequestId = new Map<string, string>()

  const pendingEditApprovalByRequestId = new Map<
    string,
    {
      resolve: (action: "apply" | "cancel" | undefined) => void
      diffs: Array<{ file: string; additions: number; deletions: number; before: string; after: string }>
      title?: string
    }
  >()

  const requestPermissionFromWebview = async (req: any): Promise<string | undefined> => {
    const chatCfg = readChatUiConfig()

    const isTerminalPermission = (() => {
      const kind = String(req?.toolCall?.kind ?? "").trim().toLowerCase()
      const title = String(req?.toolCall?.title ?? "").trim().toLowerCase()
      return kind.includes("terminal") || kind.includes("run") || title.includes("terminal") || title.includes("run")
    })()

    const extractCommandLine = (): string => {
      const raw = req?.toolCall?.rawInput
      if (!raw) return ""
      if (typeof raw === "string") return raw.trim()
      if (typeof raw !== "object") return String(raw).trim()

      const o: any = raw
      const cmdLine = typeof o.commandLine === "string" ? o.commandLine : typeof o.command === "string" ? o.command : typeof o.cmd === "string" ? o.cmd : ""
      const args = Array.isArray(o.args) ? o.args.map((x: any) => String(x ?? "").trim()).filter(Boolean) : []
      const parts = [String(cmdLine ?? "").trim(), ...args].filter(Boolean)
      if (parts.length) return parts.join(" ").trim()
      return safeJsonPreview(raw)
    }

    const shouldAutoApproveTerminal = await (async () => {
      if (!isTerminalPermission) return false
      if (chatCfg.terminalEnableAutoApprove === false) return false

      const commandLine = String(extractCommandLine() ?? "").trimStart()
      if (!commandLine) return false

      terminalAutoApproveDevLog("eval-start", {
        commandLine: commandLine.length > 800 ? commandLine.slice(0, 800) + "…" : commandLine,
        ignoreDefaults: chatCfg.terminalIgnoreDefaultAutoApproveRules === true,
        blockDetectedFileWrites: chatCfg.terminalBlockDetectedFileWrites,
        autoApproveWorkspaceNpmScripts: chatCfg.terminalAutoApproveWorkspaceNpmScripts,
      })

      const logDecision = (payload: Record<string, unknown>) => {
        terminalAutoApproveDevLog("decision", payload)
      }

      // Choose which rule set to use, best-effort emulating VS Code.
      const ignoreDefaults = chatCfg.terminalIgnoreDefaultAutoApproveRules === true
      let rules = (ignoreDefaults ? chatCfg.terminalAutoApproveNonDefault : chatCfg.terminalAutoApprove) ?? undefined
      // VS Code: deprecated `chat.agent.terminal.autoApprove` is merged into the new object.
      try {
        const dep = vscode.workspace.getConfiguration("chat").get<any>("agent.terminal.autoApprove")
        if (dep && typeof dep === "object" && !Array.isArray(dep) && rules && typeof rules === "object" && !Array.isArray(rules)) {
          rules = { ...(rules as any), ...(dep as any) }
        }
      } catch {
        // ignore
      }

      const extractCwdFromRawInput = (): string => {
        const raw = req?.toolCall?.rawInput
        if (!raw || typeof raw !== "object") return ""
        const o: any = raw
        const candidates = [o.cwd, o.workingDirectory, o.workingDir, o.currentDirectory]
        for (const c of candidates) {
          const s = typeof c === "string" ? c.trim() : ""
          if (s) return s
        }
        return ""
      }
      if (!rules || typeof rules !== "object" || Array.isArray(rules)) return false

      terminalAutoApproveDevLog(
        "rules-selected",
        {
          ignoreDefaults,
          ruleCount: Object.keys(rules as any).length,
        },
        { verbose: true },
      )

      const transientEnvVarRegex = /^[A-Z_][A-Z0-9_]*=/i

      const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")

      const neverMatchRegex = /(?!.*)/

      const convertAutoApproveEntryToRegex = (value: string): { regex: RegExp; regexCaseInsensitive: RegExp } => {
        const doConvert = (v: string): RegExp => {
          const m = v.match(/^\/(?<pattern>.+)\/(?<flags>[dgimsuvy]*)$/)
          const pattern = (m as any)?.groups?.pattern
          if (pattern) {
            let flags = String((m as any)?.groups?.flags ?? "")
            flags = flags.replaceAll("g", "")
            if (pattern === ".*") return new RegExp(pattern)
            try {
              return new RegExp(pattern, flags || undefined)
            } catch {
              return neverMatchRegex
            }
          }

          if (v === "") return neverMatchRegex

          if (v.includes("/") || v.includes("\\")) {
            let p = v.replace(/[/\\]/g, "%%PATH_SEP%%")
            p = escapeRegExp(p)
            p = p.replace(/%%PATH_SEP%%*/g, "[/\\\\]")
            const sanitized = `^(?:\\.[/\\\\])?${p}`
            return new RegExp(sanitized)
          }

          const sanitized = escapeRegExp(v)
          return new RegExp(`^${sanitized}\\b`)
        }

        const regex = doConvert(value)
        const flags = regex.flags || ""
        if (flags.includes("i")) return { regex, regexCaseInsensitive: regex }
        try {
          return { regex, regexCaseInsensitive: new RegExp(regex.source, flags + "i") }
        } catch {
          return { regex, regexCaseInsensitive: regex }
        }
      }

      type AutoApproveRule = {
        regex: RegExp
        regexCaseInsensitive: RegExp
        sourceText: string
      }

      const denyListRules: AutoApproveRule[] = []
      const allowListRules: AutoApproveRule[] = []
      const denyListCommandLineRules: AutoApproveRule[] = []
      const allowListCommandLineRules: AutoApproveRule[] = []

      for (const [keyRaw, value] of Object.entries(rules)) {
        const key = String(keyRaw ?? "").trim()
        if (!key) continue
        if (value === null) continue

        const { regex, regexCaseInsensitive } = convertAutoApproveEntryToRegex(key)

        if (typeof value === "boolean") {
          if (value === true) allowListRules.push({ regex, regexCaseInsensitive, sourceText: key })
          else if (value === false) denyListRules.push({ regex, regexCaseInsensitive, sourceText: key })
          continue
        }

        if (value && typeof value === "object") {
          const approve = (value as any).approve
          const matchCommandLine = (value as any).matchCommandLine
          if (typeof approve === "boolean") {
            const target = matchCommandLine === true ? (approve ? allowListCommandLineRules : denyListCommandLineRules) : approve ? allowListRules : denyListRules
            target.push({ regex, regexCaseInsensitive, sourceText: key })
          }
        }
      }

      // Copilot-like conservative default: allow safe PowerShell read-only cmdlets.
      // This intentionally does NOT auto-approve explicit file-writing cmdlets like Out-File.
      // Deny-first ordering is preserved since denyListRules is checked before allowListRules.
      {
        const builtin = "/^Get-[a-z0-9]/i"
        const alreadyPresent = denyListRules.some((r) => r.sourceText === builtin) || allowListRules.some((r) => r.sourceText === builtin)
        if (!alreadyPresent) {
          const { regex, regexCaseInsensitive } = convertAutoApproveEntryToRegex(builtin)
          allowListRules.push({ regex, regexCaseInsensitive, sourceText: builtin })
        }
      }

      const isPowerShellShellString = (shellRaw: unknown): boolean => {
        const s = String(shellRaw ?? "").trim()
        if (!s) return false
        try {
          if (process.platform === "win32") {
            const base = path.win32.basename(s).replace(/\.exe$/i, "")
            return /^(?:powershell|pwsh)(?:-preview)?$/i.test(base)
          }
          const base = path.posix.basename(s)
          return /^(?:powershell|pwsh)(?:-preview)?$/i.test(base)
        } catch {
          const t = s.toLowerCase()
          return t.includes("pwsh") || t.includes("powershell")
        }
      }

      const resolveShellStringFromRawInput = (): string => {
        const raw = req?.toolCall?.rawInput
        if (!raw || typeof raw !== "object") return ""
        const o: any = raw
        const candidates = [o.shell, o.shellPath, o.executable, o.program, o.terminal, o.terminalProfile?.path]
        for (const c of candidates) {
          const s = typeof c === "string" ? c.trim() : ""
          if (s) return s
        }
        return ""
      }

      const looksLikePowerShellCommand = (cmd: string): boolean => {
        const t = cmd.trimStart()
        if (!t) return false
        const first = t.split(/\s+/)[0]
        if (!first) return false
        if (first.startsWith("(") || first.startsWith("$")) return true
        if (/^[a-z]+-[a-z0-9]+$/i.test(first)) return true
        return /^(get|set|write|out|select|where|format|sort|measure|compare|start|stop|remove|new|add|clear|copy|move|push|pop|join|split)-/i.test(first)
      }

      const commandMatchesRule = (rule: AutoApproveRule, cmd: string): boolean => {
        const shell = resolveShellStringFromRawInput()
        const isPwsh = isPowerShellShellString(shell) || looksLikePowerShellCommand(cmd)
        const re = isPwsh ? rule.regexCaseInsensitive : rule.regex
        if (re.test(cmd)) return true
        if (isPwsh && cmd.startsWith("(")) {
          // PowerShell: allow ignoring leading '(' in sub-expression commands.
          return rule.regexCaseInsensitive.test(cmd.slice(1))
        }
        return false
      }

      type ApprovalExplain = {
        kind: "approved" | "denied" | "noMatch"
        reason: string
        matchedRule?: string
      }

      const explainCommandLineApproval = (line: string): ApprovalExplain => {
        for (const rule of denyListCommandLineRules) {
          if (rule.regex.test(line)) return { kind: "denied", reason: "denyCommandLineRule", matchedRule: rule.sourceText }
        }
        for (const rule of allowListCommandLineRules) {
          if (rule.regex.test(line)) return { kind: "approved", reason: "allowCommandLineRule", matchedRule: rule.sourceText }
        }
        return { kind: "noMatch", reason: "noCommandLineRule" }
      }

      const explainCommandApproval = async (cmd: string): Promise<ApprovalExplain> => {
        const trimmed = String(cmd ?? "").trimStart()
        if (!trimmed) return { kind: "noMatch", reason: "empty" }
        if (transientEnvVarRegex.test(trimmed)) return { kind: "denied", reason: "transientEnvVarPrefix" }

        for (const rule of denyListRules) {
          if (commandMatchesRule(rule, trimmed)) return { kind: "denied", reason: "denyRule", matchedRule: rule.sourceText }
        }
        for (const rule of allowListRules) {
          if (commandMatchesRule(rule, trimmed)) return { kind: "approved", reason: "allowRule", matchedRule: rule.sourceText }
        }

        if (chatCfg.terminalAutoApproveWorkspaceNpmScripts) {
          const parseRunScript = (s: string): { scriptName: string } | undefined => {
            const parts = s.trim().split(/\s+/).filter(Boolean)
            if (parts.length < 3) return undefined

            const tool = String(parts[0] ?? "").trim().toLowerCase()
            if (tool !== "npm" && tool !== "yarn" && tool !== "pnpm") return undefined

            // Allow flags between tool and `run`, e.g. `npm --silent run test`
            let i = 1
            while (i < parts.length && String(parts[i]).startsWith("-")) i++
            if (i >= parts.length) return undefined
            if (String(parts[i] ?? "").toLowerCase() !== "run") return undefined
            i++
            if (i >= parts.length) return undefined
            const name = String(parts[i] ?? "").trim()
            if (!name || name.startsWith("-")) return undefined
            return { scriptName: name }
          }

          const run = parseRunScript(trimmed)
          if (run) {
            try {
              const scripts = await (async () => {
                // Cache within a short window to avoid repeated workspace scans.
                const now = Date.now()
                const cacheAny: any = (requestPermissionFromWebview as any)
                const cacheKey = "__opencodeTerminalNpmScriptsCache"
                const cached = cacheAny[cacheKey] as { expiresAt: number; scripts: Set<string> } | undefined
                if (cached && cached.expiresAt > now) return cached.scripts

                const uris = await vscode.workspace.findFiles("**/package.json", "**/node_modules/**", 50)
                const found = new Set<string>()
                for (const uri of uris) {
                  try {
                    const buf = await vscode.workspace.fs.readFile(uri)
                    const json = JSON.parse(Buffer.from(buf).toString("utf8"))
                    const scriptsObj = json?.scripts
                    if (scriptsObj && typeof scriptsObj === "object") {
                      for (const k of Object.keys(scriptsObj)) found.add(String(k))
                    }
                  } catch {
                    // ignore
                  }
                }
                cacheAny[cacheKey] = { expiresAt: now + 10_000, scripts: found }
                return found
              })()

              if (scripts.has(run.scriptName)) return { kind: "approved", reason: "workspaceNpmScript", matchedRule: run.scriptName }
              return { kind: "noMatch", reason: "workspaceNpmScriptNotFound", matchedRule: run.scriptName }
            } catch {
              // ignore
            }
          }
        }

        return { kind: "noMatch", reason: "noRule" }
      }

      type ParsedCommandLine = {
        subCommands: string[]
        inlineCommands: string[]
        fileWriteTargets: Array<{ rawTarget: string; absoluteTarget?: string; isNullDevice?: boolean; hasInterpolation?: boolean; isStreamRedirect?: boolean }>
      }

      const parseCommandLine = (line: string, opts: { isPowerShell: boolean; cwd?: string }): ParsedCommandLine => {
        const subCommands: string[] = []
        const inlineCommands: string[] = []
        const fileWriteTargets: ParsedCommandLine["fileWriteTargets"] = []

        let quote: "'" | '"' | null = null
        let escapeNext = false
        let parenDepth = 0
        let braceDepth = 0
        let bracketDepth = 0

        let cur = ""
        const pushSub = () => {
          const t = cur.trim()
          if (t) subCommands.push(t)
          cur = ""
        }

        const tokenizePowerShellCommand = (text: string): string[] => {
          const s = String(text ?? "")
          const tokens: string[] = []
          let cur = ""
          let quote: '"' | "'" | undefined
          let esc = false

          const push = () => {
            const t = cur.trim()
            if (t) tokens.push(t)
            cur = ""
          }

          for (let i = 0; i < s.length; i++) {
            const ch = s[i]
            if (esc) {
              cur += ch
              esc = false
              continue
            }

            // PowerShell escape character
            if (!quote && ch === "`") {
              esc = true
              continue
            }
            if (quote) {
              if (ch === quote) {
                quote = undefined
                cur += ch
                continue
              }
              cur += ch
              continue
            }
            if (ch === "'" || ch === '"') {
              quote = ch as any
              cur += ch
              continue
            }

            if (/\s/.test(ch)) {
              push()
              continue
            }
            cur += ch
          }

          push()
          return tokens
        }

        const detectPowerShellFileWriteTargets = (cmd: string): string[] => {
          const raw = String(cmd ?? "").trim()
          if (!raw) return []

          // Trim common invocation prefixes.
          const s = raw.replace(/^(?:\s*(?:&|\.)\s+)+/, "").trim()
          if (!s) return []
          const tokens = tokenizePowerShellCommand(s)
          const nameToken = String(tokens[0] ?? "").trim()
          const nameLower = nameToken.toLowerCase()
          const cmdName = nameLower.includes("\\") ? nameLower.split("\\").pop() ?? nameLower : nameLower

          // .NET file write helpers (common in scripts)
          // Examples:
          //   [System.IO.File]::WriteAllText('out.txt','hi')
          //   [IO.File]::AppendAllText("out.txt","hi")
          const dotNetWrite = s.match(/\[(?:system\.)?(?:io\.)?file\]::(writealltext|writealllines|appendalltext)\s*\(\s*(['"])([^'"]+)\2/i)
          if (dotNetWrite?.[3]) return [String(dotNetWrite[3]).trim()].filter(Boolean)

          // Only target common, obviously file-writing cmdlets.
          // We keep this conservative; if a target looks dynamic, recordFileWriteTarget will mark interpolation.
          const targets: string[] = []

          const captureParamValue = (name: string): string | undefined => {
            // Supports: -Name value  OR  -Name:value
            const re = new RegExp(`(?:^|\\s)-${name}(?::|\\s+)("[^"]*"|'[^']*'|[^\\s]+)`, "i")
            const m = s.match(re)
            const v = m?.[1]
            return v ? String(v).trim() : undefined
          }

          const captureFirstPositional = (): string | undefined => {
            const parts = tokenizePowerShellCommand(s)
            if (parts.length < 2) return undefined
            // Find first positional token after cmd name (skip parameters and their immediate values).
            for (let i = 1; i < parts.length; i++) {
              const tok = String(parts[i] ?? "").trim()
              if (!tok) continue
              if (tok.startsWith("-")) {
                // Skip param value if present and not another param.
                const next = String(parts[i + 1] ?? "").trim()
                if (next && !next.startsWith("-")) i++
                continue
              }
              return tok
            }
            return undefined
          }

          const pickPathLike = (...vals: Array<string | undefined>): string | undefined => {
            for (const v of vals) {
              const t = String(v ?? "").trim()
              if (t) return t
            }
            return undefined
          }

          // Avoid mis-detecting Windows sc.exe verbs when user typed `sc`.
          if (cmdName === "sc") {
            const verb = String(tokens[1] ?? "").toLowerCase()
            const scExeVerbs = new Set([
              "query",
              "qc",
              "start",
              "stop",
              "create",
              "delete",
              "config",
              "failure",
              "description",
              "sdshow",
              "sdset",
              "showsid",
              "setsid",
              "getdisplayname",
              "getkeyname",
              "enumdepend",
            ])
            if (verb && scExeVerbs.has(verb)) return []
          }

          if (cmdName === "out-file") {
            targets.push(pickPathLike(captureParamValue("filepath"), captureParamValue("path"), captureFirstPositional()) || "")
          } else if (cmdName === "set-content" || cmdName === "sc") {
            targets.push(pickPathLike(captureParamValue("literalpath"), captureParamValue("path"), captureFirstPositional()) || "")
          } else if (cmdName === "add-content" || cmdName === "ac") {
            targets.push(pickPathLike(captureParamValue("literalpath"), captureParamValue("path"), captureFirstPositional()) || "")
          } else if (cmdName === "tee-object" || cmdName === "tee") {
            // Writes pipeline output to a file.
            targets.push(pickPathLike(captureParamValue("filepath"), captureParamValue("path"), captureFirstPositional()) || "")
          } else if (cmdName === "new-item" || cmdName === "ni") {
            // Only treat as file write when explicitly creating a file.
            if (/(?:^|\s)-(?:itemtype|type)\s+file\b/i.test(s)) {
              targets.push(pickPathLike(captureParamValue("literalpath"), captureParamValue("path"), captureFirstPositional()) || "")
            }
          } else if (cmdName === "invoke-webrequest" || cmdName === "iwr" || cmdName === "wget") {
            // Common download-to-file pattern.
            targets.push(pickPathLike(captureParamValue("outfile")) || "")
          } else if (cmdName === "start-transcript") {
            // Writes a transcript log file.
            targets.push(pickPathLike(captureParamValue("path"), captureParamValue("literalpath"), captureFirstPositional()) || "")
          } else if (cmdName === "export-csv") {
            targets.push(pickPathLike(captureParamValue("path"), captureParamValue("literalpath"), captureFirstPositional()) || "")
          } else if (cmdName === "export-clixml") {
            targets.push(pickPathLike(captureParamValue("path"), captureParamValue("literalpath"), captureFirstPositional()) || "")
          } else if (cmdName === "export-pfxcertificate") {
            targets.push(pickPathLike(captureParamValue("filepath"), captureParamValue("path"), captureFirstPositional()) || "")
          }

          return targets.map((t) => String(t ?? "").trim()).filter(Boolean)
        }

        const stripSurroundingQuotes = (text: string): string => {
          if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
            return text.slice(1, -1)
          }
          return text
        }

        const readParenGroup = (start: number, opener: string): { inner: string; end: number } | undefined => {
          if (line.slice(start, start + 2) !== `${opener}(`) return undefined
          let depth = 0
          let q: "'" | '"' | null = null
          let esc = false
          let i = start + 2
          const begin = i
          while (i < line.length) {
            const ch = line[i]
            if (esc) {
              esc = false
              i++
              continue
            }
            if (ch === "\\" && q !== "'") {
              esc = true
              i++
              continue
            }
            if (q) {
              if (ch === q) q = null
              i++
              continue
            }
            if (ch === "'" || ch === '"') {
              q = ch as any
              i++
              continue
            }
            if (ch === "(") depth++
            else if (ch === ")") {
              if (depth === 0) {
                const inner = line.slice(begin, i)
                return { inner, end: i + 1 }
              }
              depth--
            }
            i++
          }
          return undefined
        }

        const atTopLevel = () => parenDepth === 0 && braceDepth === 0 && bracketDepth === 0

        const recordFileWriteTarget = (raw: string) => {
          const rawTarget = String(raw ?? "").trim()
          if (!rawTarget) return
          const stripped = stripSurroundingQuotes(rawTarget)

          // Redirecting to another stream (eg `2>&1`) is not a file write.
          if (/^&\d+$/.test(stripped) || /^\d+$/.test(stripped)) {
            fileWriteTargets.push({ rawTarget: stripped, isStreamRedirect: true })
            return
          }

          // Null devices are considered safe.
          if (/^(nul|\/dev\/null|\$null)$/i.test(stripped)) {
            fileWriteTargets.push({ rawTarget: stripped, isNullDevice: true })
            return
          }

          const hasInterpolation = /[$\(\){}`]/.test(stripped) || stripped.includes("$(") || stripped.includes("<(") || stripped.includes(">(")
          if (hasInterpolation) {
            fileWriteTargets.push({ rawTarget: stripped, hasInterpolation: true })
            return
          }

          // Absolute
          if (path.isAbsolute(stripped)) {
            fileWriteTargets.push({ rawTarget: stripped, absoluteTarget: stripped })
            return
          }

          // Relative - resolve against cwd when possible
          if (opts.cwd) {
            try {
              fileWriteTargets.push({ rawTarget: stripped, absoluteTarget: path.resolve(opts.cwd, stripped) })
              return
            } catch {
              // fallthrough
            }
          }

          // Unknown relative target
          fileWriteTargets.push({ rawTarget: stripped })
        }

        const tryReadRedirectionTargetAt = (i: number): { end: number } | undefined => {
          // Supports patterns like:
          //   > file, >> file, 2> file, 2>> file
          // PowerShell also supports:
          //   *> file, *>> file (all streams)
          // and ignores stream redirects handled by target parsing (e.g. 2>&1)
          let j = i
          // optional leading all-stream marker
          if (opts.isPowerShell && line[j] === "*") j++
          // optional leading fd digits
          while (j < line.length && /\d/.test(line[j])) j++
          if (j >= line.length || line[j] !== ">") return undefined
          j++
          if (j < line.length && line[j] === ">") j++
          // skip whitespace
          while (j < line.length && /\s/.test(line[j])) j++
          if (j >= line.length) return { end: j }

          // read one token; allow quoted token
          let token = ""
          let tq: "'" | '"' | null = null
          let esc = false
          while (j < line.length) {
            const ch = line[j]
            if (esc) {
              token += ch
              esc = false
              j++
              continue
            }
            if (ch === "\\" && tq !== "'") {
              token += ch
              esc = true
              j++
              continue
            }
            if (tq) {
              token += ch
              if (ch === tq) tq = null
              j++
              continue
            }
            if (ch === "'" || ch === '"') {
              tq = ch as any
              token += ch
              j++
              continue
            }
            if (/\s/.test(ch) || ch === "|" || ch === ";" || ch === "&") break
            token += ch
            j++
          }
          recordFileWriteTarget(token)
          return { end: j }
        }

        for (let i = 0; i < line.length; i++) {
          const ch = line[i]
          const next2 = line.slice(i, i + 2)

          if (escapeNext) {
            cur += ch
            escapeNext = false
            continue
          }

          // Escaping rules: bash uses backslash, PowerShell uses backtick. We only apply this
          // outside single-quotes for safety.
          if (quote !== "'") {
            if (!opts.isPowerShell && ch === "\\") {
              cur += ch
              escapeNext = true
              continue
            }
            if (opts.isPowerShell && ch === "`") {
              cur += ch
              escapeNext = true
              continue
            }
          }

          if (quote) {
            cur += ch
            if (ch === quote) quote = null
            continue
          }
          if (ch === "'" || ch === '"') {
            quote = ch as any
            cur += ch
            continue
          }

          // Track depth so we don't split inside subshells/grouping.
          if (ch === "(") parenDepth++
          else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1)
          else if (ch === "{") braceDepth++
          else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1)
          else if (ch === "[") bracketDepth++
          else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1)

          // Redirections at top-level
          // Support `> file`, `>> file`, `2>file`, `2>>file`.
          // PowerShell also supports `*> file` / `*>> file`.
          if (atTopLevel() && (ch === ">" || /\d/.test(ch) || (opts.isPowerShell && ch === "*"))) {
            const r = tryReadRedirectionTargetAt(i)
            if (r) {
              // Keep the text in the current sub-command to avoid creating a gap.
              cur += line.slice(i, r.end)
              i = r.end - 1
              continue
            }
          }

          // Inline groups: $(...), <(...), >(...)
          if (quote !== "'" && (ch === "$" || ch === "<" || ch === ">")) {
            const grp = readParenGroup(i, ch)
            if (grp) {
              const inner = String(grp.inner ?? "").trim()
              if (inner) inlineCommands.push(inner)
              cur += line.slice(i, grp.end)
              i = grp.end - 1
              continue
            }
          }

          // Backticks: bash/zsh command substitution. Ignore on PowerShell.
          if (!opts.isPowerShell && quote !== "'" && ch === "`") {
            let j = i + 1
            let inner = ""
            let innerEsc = false
            while (j < line.length) {
              const c2 = line[j]
              if (innerEsc) {
                inner += c2
                innerEsc = false
                j++
                continue
              }
              if (c2 === "\\") {
                innerEsc = true
                j++
                continue
              }
              if (c2 === "`") break
              inner += c2
              j++
            }
            if (j < line.length) {
              const t = inner.trim()
              if (t) inlineCommands.push(t)
              cur += line.slice(i, j + 1)
              i = j
              continue
            }
          }

          // Split by operators at top-level
          if (atTopLevel() && (next2 === "&&" || next2 === "||")) {
            pushSub()
            i += 1
            continue
          }
          if (atTopLevel() && (ch === ";" || ch === "\n" || ch === "|")) {
            pushSub()
            continue
          }

          cur += ch
        }
        pushSub()

        if (opts.isPowerShell) {
          // Heuristic detection for PowerShell file-writing cmdlets.
          for (const c of subCommands) {
            for (const t of detectPowerShellFileWriteTargets(c)) recordFileWriteTarget(t)
          }
          for (const c of inlineCommands) {
            for (const t of detectPowerShellFileWriteTargets(c)) recordFileWriteTarget(t)
          }
        }

        return {
          subCommands,
          inlineCommands,
          fileWriteTargets,
        }
      }

      const shell = resolveShellStringFromRawInput()
      const isPwshShell = isPowerShellShellString(shell)
      const cwdRaw = extractCwdFromRawInput()
      const parsed = parseCommandLine(commandLine, { isPowerShell: isPwshShell, cwd: cwdRaw || undefined })

      terminalAutoApproveDevLog(
        "parsed",
        {
          shell: shell || undefined,
          isPowerShell: isPwshShell,
          cwd: cwdRaw || undefined,
          subCommands: parsed.subCommands,
          inlineCommands: parsed.inlineCommands,
          fileWriteTargets: parsed.fileWriteTargets,
        },
        { verbose: true },
      )

      // Apply blockDetectedFileWrites (best-effort, but errs on safety).
      const blockWrites = chatCfg.terminalBlockDetectedFileWrites
      if (blockWrites && blockWrites !== "never") {
        const writes = parsed.fileWriteTargets.filter((t) => !t.isStreamRedirect)
        if (writes.length > 0) {
          const hasOnlyNullDevices = writes.every((t) => t.isNullDevice)
          if (!hasOnlyNullDevices) {
            if (blockWrites === "all") {
              terminalAutoApproveDevLog("blocked", { reason: "blockDetectedFileWrites=all", writes })
              logDecision({ result: false, reason: "blocked:fileWrite:all" })
              return false
            }

            if (blockWrites === "outsideWorkspace") {
              const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []
              if (folders.length === 0) {
                terminalAutoApproveDevLog("blocked", { reason: "noWorkspaceFolders", writes })
                logDecision({ result: false, reason: "blocked:noWorkspaceFolders" })
                return false
              }

              for (const w of writes) {
                if (w.isNullDevice) continue
                if (w.hasInterpolation) {
                  terminalAutoApproveDevLog("blocked", { reason: "interpolatedFileWriteTarget", write: w })
                  logDecision({ result: false, reason: "blocked:interpolatedFileWriteTarget" })
                  return false
                }

                const abs = w.absoluteTarget
                if (!abs) {
                  // Unknown target (eg relative path without cwd)
                  terminalAutoApproveDevLog("blocked", { reason: "unknownFileWriteTarget", write: w })
                  logDecision({ result: false, reason: "blocked:unknownFileWriteTarget" })
                  return false
                }
                if (/[$\(\){}`]/.test(abs)) {
                  terminalAutoApproveDevLog("blocked", { reason: "suspiciousFileWriteTarget", write: w })
                  logDecision({ result: false, reason: "blocked:suspiciousFileWriteTarget" })
                  return false
                }

                const absNorm = path.resolve(abs)
                const inside = folders.some((root) => {
                  try {
                    const rootNorm = path.resolve(root)
                    return absNorm === rootNorm || absNorm.startsWith(rootNorm + path.sep)
                  } catch {
                    return false
                  }
                })
                if (!inside) {
                  terminalAutoApproveDevLog("blocked", { reason: "fileWriteOutsideWorkspace", write: w, workspaceFolders: folders })
                  logDecision({ result: false, reason: "blocked:fileWriteOutsideWorkspace" })
                  return false
                }
              }

              terminalAutoApproveDevLog(
                "file-write-check",
                { result: "notBlocked", reason: "allWritesInsideWorkspace", blockWrites, writes },
                { verbose: true },
              )
            }
          }
        }
      }
      const subCommands = Array.from(new Set([...parsed.subCommands, ...parsed.inlineCommands])).filter(Boolean)
      if (subCommands.length === 0) {
        logDecision({ result: false, reason: "noSubCommands" })
        return false
      }

      const subCommandExplains = await Promise.all(subCommands.map((c) => explainCommandApproval(c)))
      const commandLineExplain = explainCommandLineApproval(commandLine)

      terminalAutoApproveDevLog(
        "rule-eval",
        {
          subCommands: subCommands.map((c, i) => ({ cmd: c, ...subCommandExplains[i] })),
          commandLine: commandLineExplain,
        },
        { verbose: true },
      )

      if (subCommandExplains.some((r) => r.kind === "denied")) {
        logDecision({ result: false, reason: "denied:subCommand" })
        return false
      }
      if (commandLineExplain.kind === "denied") {
        logDecision({ result: false, reason: "denied:commandLine" })
        return false
      }

      const allSubCommandsApproved = subCommandExplains.every((r) => r.kind === "approved")
      const commandLineApproved = commandLineExplain.kind === "approved"
      const result = allSubCommandsApproved || commandLineApproved

      logDecision({
        result,
        allSubCommandsApproved,
        commandLineApproved,
        commandLine: commandLineExplain,
      })

      return result
    })()

    if (shouldAutoApproveTerminal) {
      const options: any[] = Array.isArray(req?.options) ? req.options : []
      const pick = (() => {
        if (!options.length) return undefined
        const norm = (s: any) => String(s ?? "").trim().toLowerCase()

        const preferred = options.find((o: any) => norm(o?.kind) === "allow")
        if (preferred?.optionId) return String(preferred.optionId).trim()

        const byName = options.find((o: any) => {
          const n = norm(o?.name)
          return n.includes("allow") || n.includes("允许") || n.includes("yes") || n === "y" || n.includes("continue")
        })
        if (byName?.optionId) return String(byName.optionId).trim()

        const first = options[0]
        return first?.optionId ? String(first.optionId).trim() : undefined
      })()

      return pick
    }

    const toolCallId = String(req?.toolCall?.toolCallId ?? "").trim()
    const requestId = toolCallId || `perm-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const title = formatPermissionTitle(req)
    const options: any[] = Array.isArray(req?.options) ? req.options : []

    pendingPermissionTitleByRequestId.set(requestId, title)
    try {
      logLine(state, `acp permission requested: requestId=${requestId} title=${title} options=${Array.isArray(req?.options) ? req.options.length : 0}`)
    } catch {
      // ignore
    }
    post({ type: "chatSetStatus", status: "thinking", detail: "Waiting for approval…" })
    post({ type: "chatProgress", id: `perm:${requestId}`, text: `Waiting for approval… ${title}`, status: "running" })

    post({
      type: "permissionRequest",
      requestId,
      title,
      inputPreview: safeJsonPreview(req?.toolCall?.rawInput),
      options: options
        .map((o: any) => ({
          optionId: String(o?.optionId ?? "").trim(),
          name: String(o?.name ?? "").trim(),
          kind: o?.kind ? String(o.kind) : undefined,
        }))
        .filter((o: any) => o.optionId && o.name),
    })

    const timeoutMs = 5 * 60 * 1000

    return await new Promise<string | undefined>((resolve) => {
      pendingPermissionByRequestId.set(requestId, resolve)
      setTimeout(() => {
        const cur = pendingPermissionByRequestId.get(requestId)
        if (cur !== resolve) return
        pendingPermissionByRequestId.delete(requestId)
        pendingPermissionTitleByRequestId.delete(requestId)
        post({ type: "permissionClear", requestId })
        post({ type: "chatProgress", id: `perm:${requestId}`, text: `Approval timed out/cancelled: ${title}`, status: "error" })
        resolve(undefined)
      }, timeoutMs)
    })
  }

  const requestQuestionFromWebview = async (req: any): Promise<string[][] | undefined> => {
    const requestId = String(req?.id ?? "").trim() || `q-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const rawQuestions = Array.isArray(req?.questions) ? req.questions : []

    try {
      const chatCfg = readChatUiConfig()
      if (chatCfg.terminalAutoReplyToPrompts) {
        // Minimal safe heuristic: auto-reply only to simple `Confirm? y/n` prompts.
        if (rawQuestions.length === 1) {
          const q0: any = rawQuestions[0]
          const qText = String(q0?.question ?? q0?.header ?? "").trim().toLowerCase()
          const optsRaw = Array.isArray(q0?.options) ? q0.options : []
          const labels = optsRaw.map((o: any) => String(o?.label ?? "").trim().toLowerCase()).filter(Boolean)

          const hasY = labels.includes("y") || labels.includes("yes")
          const hasN = labels.includes("n") || labels.includes("no")
          const looksLikeConfirm = qText.includes("confirm") || qText.includes("y/n") || qText.includes("y ") || qText.includes(" y")

          if (hasY && hasN && looksLikeConfirm) {
            const answer = labels.includes("y") ? "y" : labels.includes("yes") ? "yes" : "y"
            return [[answer]]
          }
        }
      }
    } catch {
      // ignore
    }

    const questions = rawQuestions
      .map((q: any) => {
        const header = typeof q?.header === "string" ? q.header.trim() : ""
        const question = String(q?.question ?? "").trim() || header
        if (!question) return null
        const multiple = Boolean(q?.multiple)
        const customAllowed = q?.custom === false ? false : true
        const options = Array.isArray(q?.options)
          ? q.options
              .map((o: any) => {
                const label = String(o?.label ?? "").trim()
                if (!label) return null
                const description = typeof o?.description === "string" ? o.description.trim() : ""
                return description ? { label, description } : { label }
              })
              .filter(Boolean)
          : []

        return {
          header: header || undefined,
          question,
          multiple: multiple || undefined,
          customAllowed: customAllowed || undefined,
          options: options.length ? (options as any) : undefined,
        }
      })
      .filter(Boolean) as Array<{
      header?: string
      question: string
      multiple?: boolean
      customAllowed?: boolean
      options?: Array<{ label: string; description?: string }>
    }>

    const title = questions.length > 1 ? `需要输入（${questions.length}）` : "需要输入"

    pendingQuestionTitleByRequestId.set(requestId, title)
    try {
      logLine(state, `acp question requested: requestId=${requestId} title=${title} questions=${Array.isArray(req?.questions) ? req.questions.length : 0}`)
    } catch {
      // ignore
    }
    post({ type: "chatSetStatus", status: "thinking", detail: "Waiting for input…" })
    post({ type: "chatProgress", id: `q:${requestId}`, text: `Waiting for input… ${title}`, status: "running" })

    post({
      type: "questionRequest",
      requestId,
      title,
      questions,
    })

    const timeoutMs = 10 * 60 * 1000
    return await new Promise<string[][] | undefined>((resolve) => {
      pendingQuestionByRequestId.set(requestId, resolve)
      setTimeout(() => {
        const cur = pendingQuestionByRequestId.get(requestId)
        if (cur !== resolve) return
        pendingQuestionByRequestId.delete(requestId)
        pendingQuestionTitleByRequestId.delete(requestId)
        post({ type: "questionClear", requestId })
        post({ type: "chatProgress", id: `q:${requestId}`, text: `Input timed out/cancelled: ${title}`, status: "error" })
        resolve(undefined)
      }, timeoutMs)
    })
  }

  const requestEditApprovalFromWebview = async (req: any): Promise<"apply" | "cancel" | undefined> => {
    const requestId = String(req?.requestId ?? "").trim() || `edit-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const diffs = Array.isArray(req?.diffs) ? req.diffs : []
    const title = String(req?.title ?? req?.summary ?? "待确认的更改").trim() || "待确认的更改"

    const files = diffs
      .map((d: any) => {
        const relativePath = String(d?.file ?? "").trim()
        const additions = Number(d?.additions ?? 0)
        const deletions = Number(d?.deletions ?? 0)
        const editCount = Math.max(0, additions + deletions)
        return relativePath ? { relativePath, editCount, additions, deletions } : null
      })
      .filter(Boolean) as Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number }>

    const diffStats = {
      filesChanged: files.length,
      totalFilesChanged: files.length,
      additions: diffs.reduce((sum: number, d: any) => sum + Number(d?.additions ?? 0), 0),
      deletions: diffs.reduce((sum: number, d: any) => sum + Number(d?.deletions ?? 0), 0),
    }

    post({ type: "chatSetStatus", status: "thinking", detail: "Waiting for edit approval…" })
    post({ type: "chatProgress", id: `edit:${requestId}`, text: `Waiting for edit approval… ${title}`, status: "running" })

    post({
      type: "editApprovalRequest",
      requestId,
      summary: title,
      files,
      diffStats,
      canPreview: diffs.length > 0,
    })

    const timeoutMs = 10 * 60 * 1000
    return await new Promise<"apply" | "cancel" | undefined>((resolve) => {
      pendingEditApprovalByRequestId.set(requestId, {
        resolve,
        diffs: diffs
          .map((d: any) => ({
            file: String(d?.file ?? "").trim(),
            additions: Number(d?.additions ?? 0),
            deletions: Number(d?.deletions ?? 0),
            before: typeof d?.before === "string" ? d.before : "",
            after: typeof d?.after === "string" ? d.after : "",
          }))
          .filter((d: any) => d.file),
        title,
      })

      setTimeout(() => {
        const cur = pendingEditApprovalByRequestId.get(requestId)
        if (!cur || cur.resolve !== resolve) return
        pendingEditApprovalByRequestId.delete(requestId)
        post({ type: "editApprovalClear", requestId })
        post({ type: "chatProgress", id: `edit:${requestId}`, text: `Edit approval timed out/cancelled: ${title}`, status: "error" })
        resolve("cancel")
      }, timeoutMs)
    })
  }

  const sink: WebviewSink = (msg) => post(msg)
  const activeView: ActiveChatView = { send: sink, requestPermissionFromWebview, requestEditApprovalFromWebview }
  activeChatViews.add(activeView)

  const ensureAcpConnected = async () => {
    if (state.acp?.connection && state.acp?.sessionId) return

    // Best-effort cleanup of any previous ACP process.
    if (state.acp?.process && !state.acp.process.killed) {
      try {
        state.acp.process.kill()
      } catch {
        // ignore
      }
    }

    let cwd = getDirectoryQuery() || process.cwd()
    try {
      if (!cwd || !fs.existsSync(cwd)) {
        const fallback = process.cwd()
        logLine(state, `acp cwd does not exist; falling back: ${String(cwd)} -> ${fallback}`)
        cwd = fallback
      }
    } catch {
      // ignore
    }

    // Prefer the repo-local opencode (bun) to avoid global npm shims
    // which may be missing the correct platform binary.
    const local = resolveLocalOpencodeAcpSpawn(cwd)
    const command = local?.command ?? getAcpCommand()
    const args = local?.args ? [...local.args] : [...getAcpArgs()]

    // Ensure the opencode runtime receives a --cwd pointing at the project.
    // When using bun run wrapper, there is already a --cwd for bun itself;
    // we still need to pass --cwd to opencode after the "acp" subcommand.
    const ensureOpencodeCwdArg = () => {
      const idx = args.lastIndexOf("acp")
      if (idx >= 0) {
        for (let i = idx + 1; i < args.length; i++) {
          if (args[i] === "--cwd") return
        }
        args.push("--cwd", cwd)
        return
      }
      if (!args.includes("--cwd")) args.push("--cwd", cwd)
    }
    ensureOpencodeCwdArg()

    logLine(state, `acp spawn: ${command} ${args.join(" ")}`)

    const connected = await createAcpConnected(
      {
        command,
        args,
        cwd,
        env: {
          OPENCODE_CALLER: "vscode",
        },
        onStderr: (chunkText) => {
          const text = String(chunkText ?? "")
          if (!text.trim()) return
          // Keep raw lines to help diagnose boot/auth failures.
          for (const line of text.split(/\r?\n/)) {
            const l = line.trimEnd()
            if (l) logLine(state, `[acp] ${l}`)
          }
        },
      },
      {
        onSessionUpdate: async (n) => {
          const params: any = n
          const sessionId = String(params?.sessionId ?? "")
          if (state.acp?.sessionId && sessionId && state.acp.sessionId !== sessionId) return
          const update: any = params?.update
          const kind = String(update?.sessionUpdate ?? "")

          // ACP may emit updates during initialize/newSession (e.g. provider/tool warmup)
          // even when the user hasn't sent a prompt. Don't surface those as "thinking details".
          // We only render turn-related updates once a user turn has started, or when late tool
          // updates are still attached to the most recent turn (activeEditRequestId).
          const hasTurnContext = Boolean(state.acp?.activeTurnId || state.acp?.activeEditRequestId)
          if (!hasTurnContext) {
            if (
              kind === "agent_message_chunk" ||
              kind === "agent_thought_chunk" ||
              kind === "tool_call" ||
              kind === "tool_call_update"
            ) {
              return
            }
          }

          const touchAcpActivity = () => {
            if (!state.acp) return
            state.acp.lastUpdateAtMs = Date.now()
            if (state.acp.turnEndTimer) {
              try {
                clearTimeout(state.acp.turnEndTimer)
              } catch {
                // ignore
              }
            }

            // ACP doesn't emit a reliable "done" signal for a prompt.
            // End the turn only after a QUIET window with no updates and no running tools.
            // In practice, tool calls can start after short lulls (e.g. model thinking),
            // so keep this window comfortably > 1s to avoid placing checkpoints mid-turn.
            state.acp.turnEndTimer = setTimeout(() => {
              try {
                if (!state.isBusy) return
                if (!state.acp) return
                const last = state.acp.lastUpdateAtMs ?? 0
                if (Date.now() - last < 2200) return
                const running = state.acp.runningToolCallIds
                if (running && running.size > 0) return

                // Heuristic: ACP can have long silent gaps between tool calls.
                // If the most recent activity was a tool update and we haven't
                // seen any assistant output since, delay turn-end a bit longer
                // to avoid generating mid-turn checkpoints.
                {
                  const toolChainGraceMs = 30_000
                  const lastTool = state.acp.lastToolUpdateAtMs ?? 0
                  const lastAssistant = state.acp.lastAssistantChunkAtMs ?? 0
                  if (lastTool && lastAssistant <= lastTool && Date.now() - lastTool < toolChainGraceMs) {
                    touchAcpActivity()
                    return
                  }
                }

                // Commit the streamed assistant text to a minimal transcript snapshot.
                try {
                  const text = typeof state.turnAssistantText === "string" ? state.turnAssistantText : ""
                  if (text) {
                    if (!state.transcript) state.transcript = []
                    state.transcript.push({ kind: "chat", role: "assistant", text })
                  }
                  state.turnAssistantText = ""
                } catch {
                  // ignore
                }

                // Copilot-like: checkpoint at the end of a turn that produced diffs.
                try {
                  const all: any[] = []
                  for (const ds of state.acp.diffsByRequestId.values()) {
                    if (Array.isArray(ds) && ds.length) all.push(...ds)
                  }
                  const merged = mergeDiffsByFile([], normalizeDiffs(all))
                  if (merged.length) {
                    const key = computeCheckpointKey(state, merged)
                    if (key && key !== state.lastCheckpointKey) {
                      state.lastCheckpointKey = key
                      if (!state.checkpointsById) state.checkpointsById = new Map()
                      if (!state.transcript) state.transcript = []
                      const checkpointId = `cp:${Date.now()}:${Math.random().toString(16).slice(2)}`
                      const transcriptIndex = Number.isFinite(state.turnStartTranscriptIndex as any)
                        ? Math.max(0, state.turnStartTranscriptIndex as number)
                        : state.transcript.length
                      state.checkpointsById.set(checkpointId, {
                        id: checkpointId,
                        createdAtMs: Date.now(),
                        transport: "acp",
                        snapshotDiffs: merged,
                        transcriptIndex,
                      })
                      state.transcript.push({ kind: "checkpoint", checkpointId })
                      post({ type: "chatCheckpoint", checkpointId })
                    }
                  }
                } catch {
                  // ignore
                }

                post({ type: "chatAssistantEnd" })
                post({ type: "chatSetStatus", status: "idle" })
                state.isBusy = false
                state.didEmitThinkingTranscriptForTurn = false
                state.didLogFirstAssistantDelta = false
                state.acp.activeTurnId = undefined
                // Keep activeEditRequestId so late tool updates/diffs still group into one review batch.
                // It will be replaced when the next user message starts a new ACP turn.

                // Best-effort: generate a one-line completion summary after the turn ends.
                void maybeGenerateAndPostTurnSummary(post, state)
              } catch {
                // ignore
              }
            }, 2500)
          }

          const emitReference = (uriRaw: any, titleRaw?: any) => {
            const uri = String(uriRaw ?? "").trim()
            if (!uri) return
            if (state.seenReferenceUris.has(uri)) return
            state.seenReferenceUris.add(uri)
            const title = typeof titleRaw === "string" ? titleRaw.trim() : ""
            post({ type: "chatReference", uri, title: title || undefined })
          }

          if (kind === "agent_message_chunk") {
            touchAcpActivity()
            if (state.acp) state.acp.lastAssistantChunkAtMs = Date.now()
            const content = update?.content
            if (content?.type === "text" && typeof content.text === "string") {
              state.isBusy = true
              if (!state.didEmitThinkingTranscriptForTurn) state.didEmitThinkingTranscriptForTurn = true
              // Copilot-like: transition to Thinking once model starts streaming.
              post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
              try {
                state.turnAssistantText = String(state.turnAssistantText ?? "") + content.text
              } catch {
                // ignore
              }
              post({ type: "chatAssistantDelta", delta: content.text })
            }
            return
          }

          if (kind === "agent_thought_chunk") {
            touchAcpActivity()
            if (state.acp) state.acp.lastAssistantChunkAtMs = Date.now()
            const content = update?.content
            if (content?.type === "text" && typeof content.text === "string") {
              state.isBusy = true
              state.didEmitThinkingTranscriptForTurn = true
              post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
              post({ type: "chatThinkingDelta", delta: content.text })
            } else {
              state.isBusy = true
              post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
            }
            return
          }

          if (kind === "tool_call" || kind === "tool_call_update") {
            touchAcpActivity()
            if (state.acp) state.acp.lastToolUpdateAtMs = Date.now()
            const toolCallId = String(update?.toolCallId ?? "")
            if (!toolCallId) return
            const status = String(update?.status ?? "")
            const titleRaw = String(update?.title ?? "")
            const nameRaw = String(update?.name ?? (update as any)?.toolName ?? (update as any)?.tool ?? "")
            const cachedName = state.acp?.toolNameById.get(toolCallId)
            const titleAsName = /^[a-zA-Z0-9_.:-]{2,60}$/.test(titleRaw.trim()) ? titleRaw.trim() : ""
            const toolName = String(cachedName || nameRaw.trim() || titleAsName || "tool")
            const displayTitle = String(titleRaw.trim() || toolName)

            if (!state.acp) return

            // Update fs-capture context for the FileSystemWatcher fallback.
            try {
              acpCaptureActiveEditRequestId = state.acp.activeEditRequestId
              acpCaptureRunningToolCallIds = state.acp.runningToolCallIds ? new Set(state.acp.runningToolCallIds) : undefined
            } catch {
              // ignore
            }
            const started = state.acp.toolStartedAtMs.get(toolCallId)

            // Best-effort baseline capture for tools that write files.
            // Some ACP runtimes only attach rawInput after the initial tool_call event.
            // Capture baselines as soon as we can see any file candidates, but only
            // before completion (otherwise we might miss the true "before" state).
            try {
              const isDone = status === "completed" || status === "failed"
              const already = acpToolFileBaselinesByToolCallId.has(toolCallId)
              if (!isDone && !already) {
                const rawInput = update?.rawInput
                const fromInput = getCandidateFilePathsFromToolInput(rawInput)
                const fromTitle = getCandidateFilePathsFromToolInput({ title: displayTitle, name: toolName })
                const candidates = Array.from(new Set([...fromInput, ...fromTitle])).filter(Boolean)
                if (candidates.length) {
                  const baselines: Array<{ rawPath: string; relativePath: string; fileKey: string; before: string }> = []
                  for (const rawPath of candidates.slice(0, 24)) {
                    let uri = resolveCandidateFileUriBestEffort(rawPath, getDirectoryQuery())
                    if (!uri) uri = resolveAnyFileUri(rawPath)
                    if (!uri) {
                      const relGuess = tryToRelativePath(rawPath) || rawPath
                      uri = resolveProjectFileUri(relGuess, getDirectoryQuery(), { mustExist: false })
                    }
                    if (!uri) continue

                    const fileKey = canonicalizeFileKey(uri.fsPath)
                    if (!fileKey) continue

                    const relativePath = tryToRelativePath(uri.fsPath) || tryToRelativePath(rawPath) || rawPath

                    const beforeFromKnown = editLastKnownDocTextByFileKey.get(fileKey)
                    let before = typeof beforeFromKnown === "string" ? beforeFromKnown : ""
                    if (typeof before !== "string") before = ""

                    if (!before) {
                      const text = await readTextFileBestEffort(uri)
                      if (typeof text === "string") before = text
                    }

                    baselines.push({ rawPath, relativePath, fileKey, before })
                  }
                  if (baselines.length) {
                    acpToolFileBaselinesByToolCallId.set(toolCallId, baselines)
                    try {
                      const files = baselines
                        .map((b) => String(b?.relativePath ?? "").trim())
                        .filter(Boolean)
                        .slice(0, 6)
                      logLine(
                        state,
                        `acp baselines captured: tool=${toolName} status=${status} toolCallId=${toolCallId} files=${baselines.length}${files.length ? ` (${files.join(", ")}${baselines.length > files.length ? ", …" : ""})` : ""}`,
                      )
                    } catch {
                      // ignore
                    }
                  }
                }
              }
            } catch {
              // ignore
            }

            if (!started) {
              state.acp.toolStartedAtMs.set(toolCallId, Date.now())
              state.acp.toolNameById.set(toolCallId, toolName)
              state.isBusy = true
              state.acp.runningToolCallIds?.add(toolCallId)

              try {
                logLine(state, `acp tool begin: tool=${toolName} status=${status} toolCallId=${toolCallId}`)
              } catch {
                // ignore
              }

              // Copilot-like: do NOT surface tool names in the composer status line.
              // Tool details belong in the message transcript.
              post({ type: "chatSetStatus", status: "running-tools", detail: "Running tools…" })
              post({
                type: "chatToolInvocationBegin",
                invocationId: toolCallId,
                toolName,
                inputPreview: safeJsonPreview(update?.rawInput),
              })
            }

            if (status === "completed" || status === "failed") {
              // Mark this tool as finished before we possibly end the turn.
              state.acp.runningToolCallIds?.delete(toolCallId)
              const startedAt = state.acp.toolStartedAtMs.get(toolCallId)
              const durationMs = startedAt ? Math.max(0, Date.now() - startedAt) : undefined
              const content: any[] = Array.isArray(update?.content) ? update.content : []
              const textBlocks = content
                .filter((c) => c && c.type === "content" && c.content && c.content.type === "text" && typeof c.content.text === "string")
                .map((c) => c.content.text)
              const outputFull = textBlocks.join("\n").trim() || (typeof update?.rawOutput?.output === "string" ? update.rawOutput.output : "")

              if (status === "failed") {
                try {
                  const msg = outputFull ? truncate(outputFull, 2000) : "(no output)"
                  logLine(state, `acp tool failed: tool=${toolName} toolCallId=${toolCallId} ${msg}`)
                } catch {
                  // ignore
                }
              }

              try {
                logLine(state, `acp tool end: tool=${toolName} status=${status} toolCallId=${toolCallId} durMs=${durationMs ?? "-"}`)
              } catch {
                // ignore
              }

              // Collect edit diffs when present.
              const diffBlocks = content.filter((c) => c && c.type === "diff")

              // Stable-before capture: if a read tool completed, record the current on-disk text
              // as the baseline for this requestId so later write tools can synthesize diffs.
              try {
                if (toolName === "read" && state.acp) {
                  const requestIdForStable =
                    state.acp.activeEditRequestId ||
                    (state.acp.activeTurnId
                      ? `acp-turn:${state.acp.sessionId ?? ""}:${state.acp.activeTurnId}`
                      : `acp-edit-${toolCallId}`)

                  const candidatesFromInput = getCandidateFilePathsFromToolInput(update?.rawInput)
                  const candidatesFromOutput = getCandidateFilePathsFromToolOutput(outputFull)
                  const candidates = Array.from(new Set([...candidatesFromInput, ...candidatesFromOutput])).filter(Boolean)

                  for (const rawPath of candidates.slice(0, 24)) {
                    let uri = resolveCandidateFileUriBestEffort(rawPath, getDirectoryQuery())
                    if (!uri) uri = resolveAnyFileUri(rawPath)
                    if (!uri) {
                      const relGuess = tryToRelativePath(rawPath) || rawPath
                      uri = resolveProjectFileUri(relGuess, getDirectoryQuery(), { mustExist: false })
                    }
                    if (!uri) continue

                    const fileKey = canonicalizeFileKey(uri.fsPath)
                    if (!fileKey) continue

                    const text = await readTextFileBestEffort(uri)
                    if (typeof text !== "string") continue
                    noteStableBeforeForRequest(requestIdForStable, fileKey, text)
                  }
                }
              } catch {
                // ignore
              }
              if (diffBlocks.length) {
                const diffs = diffBlocks.map((d: any) => {
                  const file =
                    typeof d.path === "string"
                      ? d.path
                      : typeof d.file === "string"
                        ? d.file
                        : typeof d.relativePath === "string"
                          ? d.relativePath
                          : typeof d.uri === "string"
                            ? d.uri
                            : ""

                  const before =
                    typeof d.oldText === "string"
                      ? d.oldText
                      : typeof d.before === "string"
                        ? d.before
                        : typeof d.originalText === "string"
                          ? d.originalText
                          : ""
                  const after =
                    typeof d.newText === "string"
                      ? d.newText
                      : typeof d.after === "string"
                        ? d.after
                        : typeof d.text === "string"
                          ? d.text
                          : ""

                  const stats = computeAddDelStats(before, after)
                  return {
                    file: String(file),
                    fileKey: canonicalizeFileKey(file),
                    additions: stats.additions,
                    deletions: stats.deletions,
                    before,
                    after,
                  }
                })
                .filter((x: any) => String(x?.file ?? "").trim())
                state.acp.lastEditDiffs = diffs

                // Group edits for this turn into one review request.
                const requestId =
                  state.acp.activeEditRequestId ||
                  (state.acp.activeTurnId
                    ? `acp-turn:${state.acp.sessionId ?? ""}:${state.acp.activeTurnId}`
                    : `acp-edit-${toolCallId}`)

                const prev = state.acp.diffsByRequestId.get(requestId) ?? []
                const merged = mergeDiffsByFile(prev, diffs)
                state.acp.lastEditDiffs = merged

                try {
                  const files = Array.from(new Set(merged.map((d: any) => String(d?.file ?? "").trim()).filter(Boolean)))
                  logLine(state, `acp diffs merged: requestId=${requestId} files=${files.length}${files.length ? ` (${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""})` : ""}`)
                } catch {
                  // ignore
                }

                // Cache diffs for preview/undo actions.
                state.acp.diffsByRequestId.set(requestId, merged)

                // If diffs change incrementally, do NOT reset the whole processed set.
                // Only clear processed state for files whose diff content changed.
                try {
                  const changedFiles = computeChangedFilesBetweenDiffs(prev, merged)
                  if (changedFiles.size) {
                    const processed = getProcessedFilesForEditReview(requestId)
                    for (const f of changedFiles) processed.delete(f)
                  }
                } catch {
                  // ignore
                }

                try {
                  const key = computeFilesKey(merged)
                  state.editReviewLastFilesKeyByRequestId.set(requestId, key)
                } catch {
                  // ignore
                }

                const processed = getProcessedFilesForEditReview(requestId)
                const remainingDiffs = merged.filter((d) => {
                  const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
                  if (!fk) return false
                  return !processed.has(fk)
                })

                // Keep UI up to date using the shared helper (session-level for ACP).
                refreshEditReviewUiFromDiffs(requestId, merged, { summary: "Files changed" })

                if (remainingDiffs.length) {
                  post({ type: "editPreviewData", requestId, diffs: remainingDiffs })

                  // Copilot-like: open the changed file with inline hunks so editor-side actions appear.
                  void openChangedFileForDiff(remainingDiffs[0], { requestId, hunkIndex: 0 })
                }
              }

              // If ACP tool calls didn't provide diff blocks, fall back to baseline-based diffs.
              // This enables Files changed + hunks for tools that directly write files.
              if (!diffBlocks.length) {
                try {
                  const baselines = acpToolFileBaselinesByToolCallId.get(toolCallId) ?? []
                  if (!baselines.length) {
                    try {
                      const candidatesFromInput = getCandidateFilePathsFromToolInput(update?.rawInput)
                      const candidatesFromOutput = getCandidateFilePathsFromToolOutput(outputFull)
                      const fsChanges = acpFsChangesByToolCallId.get(toolCallId)
                      const candidatesFromFs = fsChanges ? Array.from(fsChanges.values()).map((c) => String(c?.fsPath ?? "").trim()).filter(Boolean) : []
                      const candidates = Array.from(new Set([...candidatesFromInput, ...candidatesFromOutput, ...candidatesFromFs])).filter(Boolean)
                      logLine(
                        state,
                        `acp diffs missing: tool=${toolName} status=${status} toolCallId=${toolCallId} baselines=0 candidates=${candidates.length}${candidates.length ? ` (${candidates.slice(0, 8).join(", ")}${candidates.length > 8 ? ", …" : ""})` : ""} fsChanges=${fsChanges?.size ?? 0} (in=${candidatesFromInput.length} out=${candidatesFromOutput.length})`,
                      )

                      // Fallback: if we can infer target files but didn't capture baselines (e.g. rawInput only arrives at completion),
                      // synthesize a best-effort diff using last-known snapshots as "before".
                      if (candidates.length && state.acp) {
                        const fallbackRequestId =
                          state.acp.activeEditRequestId ||
                          (state.acp.activeTurnId
                            ? `acp-turn:${state.acp.sessionId ?? ""}:${state.acp.activeTurnId}`
                            : `acp-edit-${toolCallId}`)

                        const diffs = await synthesizeDiffsFromCandidates(fallbackRequestId, candidates)

                        if (!diffs.length) {
                          try {
                            const sample = String(candidates[0] ?? "").trim()
                            let uri = resolveCandidateFileUriBestEffort(sample, getDirectoryQuery())
                            if (!uri) uri = resolveAnyFileUri(sample)
                            const fk = uri ? canonicalizeFileKey(uri.fsPath) : canonicalizeFileKey(sample)
                            const stableHit = fk ? Boolean(getStableBeforeForRequest(fallbackRequestId, fk)) : false
                            const reviewedLen = fk ? (editLastReviewedDocTextByFileKey.get(fk)?.length ?? 0) : 0
                            const knownLen = fk ? (editLastKnownDocTextByFileKey.get(fk)?.length ?? 0) : 0
                            logLine(
                              state,
                              `acp synthesize empty: requestId=${fallbackRequestId} tool=${toolName} toolCallId=${toolCallId} candidates=${candidates.length} sample=${sample}${uri ? ` uri=${uri.fsPath}` : ""} stableBefore=${stableHit ? 1 : 0} reviewedLen=${reviewedLen} knownLen=${knownLen}`,
                            )
                          } catch {
                            // ignore
                          }
                        }

                        if (diffs.length) {
                          const prev = state.acp.diffsByRequestId.get(fallbackRequestId) ?? []
                          const merged = mergeDiffsByFile(prev, diffs)
                          state.acp.lastEditDiffs = merged
                          state.acp.diffsByRequestId.set(fallbackRequestId, merged)

                          try {
                            const changedFiles = computeChangedFilesBetweenDiffs(prev, merged)
                            if (changedFiles.size) {
                              const processed = getProcessedFilesForEditReview(fallbackRequestId)
                              for (const f of changedFiles) processed.delete(f)
                            }
                          } catch {
                            // ignore
                          }

                          try {
                            const key = computeFilesKey(merged)
                            state.editReviewLastFilesKeyByRequestId.set(fallbackRequestId, key)
                          } catch {
                            // ignore
                          }

                          refreshEditReviewUiFromDiffs(fallbackRequestId, merged, { summary: "Files changed" })

                          const processed = getProcessedFilesForEditReview(fallbackRequestId)
                          const remainingDiffs = merged.filter((d: any) => {
                            const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
                            if (!fk) return false
                            return !processed.has(fk)
                          })
                          if (remainingDiffs.length) {
                            post({ type: "editPreviewData", requestId: fallbackRequestId, diffs: remainingDiffs })
                            void openChangedFileForDiff(remainingDiffs[0], { requestId: fallbackRequestId, hunkIndex: 0 })
                          }
                        }
                      }
                    } catch {
                      // ignore
                    }
                  }
                  if (baselines.length && state.acp) {
                    const fallbackRequestId =
                      state.acp.activeEditRequestId ||
                      (state.acp.activeTurnId
                        ? `acp-turn:${state.acp.sessionId ?? ""}:${state.acp.activeTurnId}`
                        : `acp-edit-${toolCallId}`)

                    const diffs: any[] = []
                    for (const b of baselines) {
                      const relativePath = String(b.relativePath ?? "").trim()
                      const fileKey = String(b.fileKey ?? "").trim() || canonicalizeFileKey(relativePath)
                      if (!relativePath || !fileKey) continue

                      let uri = resolveAnyFileUri(b.rawPath)
                      if (!uri) uri = resolveProjectFileUri(relativePath, getDirectoryQuery(), { mustExist: false })

                      const stableBefore = getStableBeforeForRequest(fallbackRequestId, fileKey)
                      let before = typeof stableBefore === "string" ? stableBefore : typeof b.before === "string" ? b.before : ""
                      if (!before) {
                        const fromReviewed = editLastReviewedDocTextByFileKey.get(fileKey)
                        const fromKnown = editLastKnownDocTextByFileKey.get(fileKey)
                        if (typeof fromReviewed === "string") before = fromReviewed
                        else if (typeof fromKnown === "string") before = fromKnown
                      }

                      // Choose an after candidate that actually differs from the computed before.
                      // apply_patch may update the on-disk file before the editor buffer refreshes.
                      const afterFromKnown = editLastKnownDocTextByFileKey.get(fileKey)
                      let afterFromOpen: string | undefined
                      try {
                        const fkCanon = fileKey
                        const open = vscode.workspace.textDocuments.find((d) => {
                          try {
                            const dk = d?.uri?.scheme === "file" ? canonicalizeFileKey(d.uri.fsPath) : ""
                            return Boolean(dk) && dk === fkCanon
                          } catch {
                            return false
                          }
                        })
                        if (open) afterFromOpen = open.getText()
                      } catch {
                        // ignore
                      }

                      let afterFromDisk: string | undefined
                      if (uri) {
                        const text = await readTextFileBestEffort(uri)
                        if (typeof text === "string") afterFromDisk = text
                        else {
                          // If we can't read (binary/large), skip this file.
                          continue
                        }
                      } else {
                        // If not resolvable, skip.
                        continue
                      }

                      const after = (() => {
                        const open = typeof afterFromOpen === "string" ? afterFromOpen : undefined
                        const known = typeof afterFromKnown === "string" ? afterFromKnown : undefined
                        const disk = typeof afterFromDisk === "string" ? afterFromDisk : undefined
                        if (typeof open === "string" && open !== before) return open
                        if (typeof known === "string" && known !== before) return known
                        if (typeof disk === "string" && disk !== before) return disk
                        return open ?? known ?? disk
                      })()

                      if (before === after) continue
                      const stats = computeAddDelStats(before, after)
                      diffs.push({ file: relativePath, fileKey, additions: stats.additions, deletions: stats.deletions, before, after })
                    }

                    // If baselines exist but diffs are empty (baseline captured too late),
                    // fall back to synthesizing diffs from candidates inferred from output/input/fs.
                    if (!diffs.length) {
                      try {
                        const files = baselines
                          .map((b) => String(b?.relativePath ?? "").trim())
                          .filter(Boolean)
                          .slice(0, 6)
                        logLine(
                          state,
                          `acp baseline diffs empty: requestId=${fallbackRequestId} tool=${toolName} toolCallId=${toolCallId} files=${baselines.length}${files.length ? ` (${files.join(", ")}${baselines.length > files.length ? ", …" : ""})` : ""}`,
                        )
                      } catch {
                        // ignore
                      }
                      try {
                        const fsChanges = acpFsChangesByToolCallId.get(toolCallId)
                        const candidatesFromFs = fsChanges ? Array.from(fsChanges.values()).map((c) => String(c?.fsPath ?? "").trim()).filter(Boolean) : []
                        const candidates = Array.from(
                          new Set([
                            ...baselines.map((b) => String(b.relativePath ?? "").trim()).filter(Boolean),
                            ...getCandidateFilePathsFromToolInput(update?.rawInput),
                            ...getCandidateFilePathsFromToolOutput(outputFull),
                            ...candidatesFromFs,
                          ]),
                        ).filter(Boolean)
                        diffs.push(...(await synthesizeDiffsFromCandidates(fallbackRequestId, candidates)))
                      } catch {
                        // ignore
                      }
                    }

                    if (diffs.length) {
                      const prev = state.acp.diffsByRequestId.get(fallbackRequestId) ?? []
                      const merged = mergeDiffsByFile(prev, diffs)
                      state.acp.lastEditDiffs = merged
                      state.acp.diffsByRequestId.set(fallbackRequestId, merged)

                      try {
                        const changedFiles = computeChangedFilesBetweenDiffs(prev, merged)
                        if (changedFiles.size) {
                          const processed = getProcessedFilesForEditReview(fallbackRequestId)
                          for (const f of changedFiles) processed.delete(f)
                        }
                      } catch {
                        // ignore
                      }

                      try {
                        const key = computeFilesKey(merged)
                        state.editReviewLastFilesKeyByRequestId.set(fallbackRequestId, key)
                      } catch {
                        // ignore
                      }

                      refreshEditReviewUiFromDiffs(fallbackRequestId, merged, { summary: "Files changed" })

                      const processed = getProcessedFilesForEditReview(fallbackRequestId)
                      const remainingDiffs = merged.filter((d: any) => {
                        const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
                        if (!fk) return false
                        return !processed.has(fk)
                      })

                      if (remainingDiffs.length) {
                        post({ type: "editPreviewData", requestId: fallbackRequestId, diffs: remainingDiffs })
                        void openChangedFileForDiff(remainingDiffs[0], { requestId: fallbackRequestId, hunkIndex: 0 })
                      }
                    }
                  }

                  // If we couldn't capture baselines, but we observed fs changes during this tool,
                  // synthesize diffs from those events (safe strategy: always include new files;
                  // include changes/deletes only when we have a trusted baseline snapshot).
                  if (!baselines.length && state.acp) {
                    const fallbackRequestId =
                      state.acp.activeEditRequestId ||
                      (state.acp.activeTurnId
                        ? `acp-turn:${state.acp.sessionId ?? ""}:${state.acp.activeTurnId}`
                        : `acp-edit-${toolCallId}`)

                    const changes = acpFsChangesByToolCallId.get(toolCallId)
                    const diffs: any[] = []
                    if (changes && changes.size) {
                      for (const [uriKey, ch] of Array.from(changes.entries()).slice(0, 24)) {
                        try {
                          const fsPath = String(ch?.fsPath ?? "").trim()
                          if (!fsPath || shouldIgnoreFsPathForAcpEdits(fsPath)) continue

                          const relativePath = tryToRelativePath(fsPath)
                          const file = relativePath || fsPath
                          const fileKey = canonicalizeFileKey(file)
                          if (!fileKey) continue

                          const beforeFromReviewed = editLastReviewedDocTextByFileKey.get(fileKey)
                          const beforeFromKnown = editLastKnownDocTextByFileKey.get(fileKey)
                          const beforeTrusted = typeof beforeFromReviewed === "string" ? beforeFromReviewed : typeof beforeFromKnown === "string" ? beforeFromKnown : undefined

                          let before = ""
                          let after = ""

                          if (ch.kind === "create") {
                            before = ""
                            const uri = vscode.Uri.file(fsPath)
                            const text = await readTextFileBestEffort(uri)
                            if (typeof text !== "string") continue
                            after = text
                          } else if (ch.kind === "delete") {
                            if (typeof beforeTrusted !== "string") continue
                            before = beforeTrusted
                            after = ""
                          } else {
                            // change
                            if (typeof beforeTrusted !== "string") continue
                            before = beforeTrusted
                            const uri = vscode.Uri.file(fsPath)
                            const text = await readTextFileBestEffort(uri)
                            if (typeof text !== "string") continue
                            after = text
                          }

                          if (before === after) continue
                          const stats = computeAddDelStats(before, after)
                          diffs.push({ file, fileKey, additions: stats.additions, deletions: stats.deletions, before, after })
                        } catch {
                          // ignore
                        }
                      }
                    }

                    if (diffs.length) {
                      const prev = state.acp.diffsByRequestId.get(fallbackRequestId) ?? []
                      const merged = mergeDiffsByFile(prev, diffs)
                      state.acp.lastEditDiffs = merged
                      state.acp.diffsByRequestId.set(fallbackRequestId, merged)

                      try {
                        const changedFiles = computeChangedFilesBetweenDiffs(prev, merged)
                        if (changedFiles.size) {
                          const processed = getProcessedFilesForEditReview(fallbackRequestId)
                          for (const f of changedFiles) processed.delete(f)
                        }
                      } catch {
                        // ignore
                      }

                      try {
                        const key = computeFilesKey(merged)
                        state.editReviewLastFilesKeyByRequestId.set(fallbackRequestId, key)
                      } catch {
                        // ignore
                      }

                      refreshEditReviewUiFromDiffs(fallbackRequestId, merged, { summary: "Files changed" })

                      const processed = getProcessedFilesForEditReview(fallbackRequestId)
                      const remainingDiffs = merged.filter((d: any) => {
                        const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
                        if (!fk) return false
                        return !processed.has(fk)
                      })

                      if (remainingDiffs.length) {
                        post({ type: "editPreviewData", requestId: fallbackRequestId, diffs: remainingDiffs })
                        void openChangedFileForDiff(remainingDiffs[0], { requestId: fallbackRequestId, hunkIndex: 0 })
                      }
                    }
                  }
                } catch {
                  // ignore
                } finally {
                  try {
                    acpToolFileBaselinesByToolCallId.delete(toolCallId)
                    acpFsChangesByToolCallId.delete(toolCallId)
                  } catch {
                    // ignore
                  }
                }
              } else {
                try {
                  acpToolFileBaselinesByToolCallId.delete(toolCallId)
                } catch {
                  // ignore
                }
              }

              // IMPORTANT: Even if we failed to compute per-request diffs (e.g. baseline captured too late),
              // keep the session-level "Files changed" bar in sync by recomputing from the earliest pending
              // baselines vs the latest after text (open/known/disk).
              try {
                postPendingEditsReviewBar("Files changed")
              } catch {
                // ignore
              }

              post({
                type: "chatToolInvocationEnd",
                invocationId: toolCallId,
                ok: status === "completed",
                durationMs,
                outputPreview: truncate(outputFull, 2000),
                outputFull: outputFull || undefined,
                toolName,
              })

              // Turn summary hints.
              try {
                recordTurnStep(state, formatToolStepForSummary(toolName, update?.rawInput, status === "completed"))
              } catch {
                // ignore
              }

              // Keep thinking state unless the turn ends via debounce.
              if (state.isBusy) post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
              touchAcpActivity()
              return
            }

            // in_progress/pending
            state.isBusy = true
            post({ type: "chatSetStatus", status: "running-tools", detail: "Running tools…" })
            touchAcpActivity()
            return
          }

          if (kind === "plan") {
            touchAcpActivity()
            const entries: any[] = Array.isArray(update?.entries) ? update.entries : []
            const line = entries.map((e) => `${e.status}: ${e.content}`).join("\n")
            if (line) post({ type: "chatProgress", text: line, status: "done" })
            return
          }

          // Best-effort: surface references/context when runtimes provide them.
          const refs =
            (Array.isArray(update?.references) ? update.references : null) ||
            (Array.isArray(update?.items) ? update.items : null) ||
            (Array.isArray(update?.refs) ? update.refs : null) ||
            []

          if (kind === "reference" || kind === "references" || kind === "context" || refs.length) {
            for (const r of refs) {
              if (!r) continue
              emitReference(r.uri ?? r.url ?? r.href ?? r.path, r.title ?? r.name ?? r.label)
            }
            if (refs.length) return
          }
        },

        onExtMethod: async (method, params) => {
          const m = String(method ?? "").trim()
          const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>
          try {
            logLine(state, `[acp] extMethod: ${m} ${truncate(safeJsonPreview(p), 500)}`)
          } catch {
            // ignore
          }

          const key = m.toLowerCase()
          const looksLikeQuestion =
            key.includes("question") ||
            key.includes("prompt") ||
            key.includes("input") ||
            key.includes("confirm") ||
            key.includes("ask") ||
            key.includes("user")

          if (!looksLikeQuestion) return {}

          const requestId = `acp-ext:${m}:${Date.now()}-${Math.random().toString(16).slice(2)}`

          const titleRaw =
            (typeof (p as any).title === "string" && (p as any).title) ||
            (typeof (p as any).header === "string" && (p as any).header) ||
            (typeof (p as any).name === "string" && (p as any).name) ||
            "需要输入"
          const promptRaw =
            (typeof (p as any).prompt === "string" && (p as any).prompt) ||
            (typeof (p as any).question === "string" && (p as any).question) ||
            (typeof (p as any).text === "string" && (p as any).text) ||
            ""

          const questionsRaw = Array.isArray((p as any).questions) ? (p as any).questions : null
          const optionsRaw = Array.isArray((p as any).options) ? (p as any).options : null

          const questions = (() => {
            if (Array.isArray(questionsRaw) && questionsRaw.length) {
              return questionsRaw
                .map((q: any) => {
                  const header = typeof q?.header === "string" ? q.header.trim() : ""
                  const question = String(q?.question ?? "").trim() || header
                  if (!question) return null
                  const multiple = Boolean(q?.multiple)
                  const customAllowed = q?.customAllowed === false ? false : q?.custom === false ? false : true
                  const opts = Array.isArray(q?.options)
                    ? q.options
                        .map((o: any) => {
                          const label = String(o?.label ?? o?.name ?? o?.value ?? "").trim()
                          if (!label) return null
                          const description = typeof o?.description === "string" ? o.description.trim() : ""
                          return description ? { label, description } : { label }
                        })
                        .filter(Boolean)
                    : []
                  return {
                    header: header || undefined,
                    question,
                    multiple: multiple || undefined,
                    customAllowed: customAllowed || undefined,
                    options: opts.length ? opts : undefined,
                  }
                })
                .filter(Boolean)
            }

            const opts = Array.isArray(optionsRaw)
              ? optionsRaw
                  .map((o: any) => {
                    const label = String(o?.label ?? o?.name ?? o?.value ?? o ?? "").trim()
                    if (!label) return null
                    const description = typeof o?.description === "string" ? o.description.trim() : ""
                    return description ? { label, description } : { label }
                  })
                  .filter(Boolean)
              : []

            const qText = String(promptRaw || titleRaw || "需要输入").trim() || "需要输入"
            return [
              {
                header: String(titleRaw || "").trim() || undefined,
                question: qText,
                multiple: undefined,
                customAllowed: true,
                options: opts.length ? opts : undefined,
              },
            ]
          })()

          const answers = await requestQuestionFromWebview({ id: requestId, questions })
          if (!answers) {
            return { cancelled: true }
          }

          const first = answers?.[0]?.[0]
          return {
            answers,
            answer: typeof first === "string" ? first : "",
          }
        },

        onRequestPermission: async (req) => {
          // Plan mode: best-effort auto-deny non-plan file writes without prompting.
          try {
            if (isPlanMode()) {
              const tool = req?.toolCall ?? {}
              const kind = String(tool?.kind ?? tool?.name ?? tool?.title ?? "").toLowerCase()
              const raw = tool?.rawInput && typeof tool.rawInput === "object" ? (tool.rawInput as any) : undefined
              const targetPath = typeof raw?.path === "string" ? raw.path : typeof raw?.filepath === "string" ? raw.filepath : ""
              const looksWriteLike = /write|edit|apply_patch|patch|fs\.writetextfile|writetextfile/.test(kind)
              if (looksWriteLike && targetPath && !canWritePathUnderCurrentMode(targetPath)) {
                const hasReject = Array.isArray(req?.options) && req.options.some((o: any) => String(o?.optionId) === "reject")
                if (hasReject) return { outcome: { outcome: "selected", optionId: "reject" } }
                return { outcome: { outcome: "cancelled" } }
              }
            }
          } catch {
            // ignore
          }

          let optionId = await requestPermissionFromWebview(req)
          if (!optionId) {
            const title = formatPermissionTitle(req)
            optionId = await promptPermissionChoice(req.options ?? [], title)
          }

          const toolCallId = String(req?.toolCall?.toolCallId ?? "").trim()
          if (toolCallId) post({ type: "permissionClear", requestId: toolCallId })

          if (!optionId) return { outcome: { outcome: "cancelled" } }
          return { outcome: { outcome: "selected", optionId } }
        },
        canWriteTextFile: async ({ path: absPath }) => {
          return canWritePathUnderCurrentMode(absPath)
        },
        onRequestEditApproval: async (req) => {
          const action = await requestEditApprovalFromWebview(req)
          return action
        },

        onDidApplyEdits: async (evt) => {
          const fallbackId = String(evt?.requestId ?? "").trim() || `acp-write-${Date.now()}`
          const diffsRaw: any[] = Array.isArray(evt?.diffs) ? evt.diffs : []
          if (!diffsRaw.length) return
          if (!state.acp) return

          // Copilot-like: group all applied edits for the current turn under one requestId.
          const requestId = state.acp.activeEditRequestId || fallbackId

          const diffs = diffsRaw
            .map((d: any) => ({
              file: String(d?.file ?? "").trim(),
              fileKey: canonicalizeFileKey(String(d?.file ?? "").trim()),
              additions: Number(d?.additions ?? 0),
              deletions: Number(d?.deletions ?? 0),
              before: typeof d?.before === "string" ? d.before : "",
              after: typeof d?.after === "string" ? d.after : "",
            }))
            .filter((d) => d.file)

          if (!diffs.length) return

          const prev = state.acp.diffsByRequestId.get(requestId) ?? []
          const merged = mergeDiffsByFile(prev, diffs)
          state.acp.lastEditDiffs = merged
          state.acp.diffsByRequestId.set(requestId, merged)

          try {
            const files = Array.from(new Set(merged.map((d: any) => String(d?.file ?? "").trim()).filter(Boolean)))
            logLine(state, `acp applied diffs merged: requestId=${requestId} files=${files.length}${files.length ? ` (${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""})` : ""}`)
          } catch {
            // ignore
          }

          // Only clear processed state for files whose diff content changed.
          try {
            const changedFiles = computeChangedFilesBetweenDiffs(prev, merged)
            if (changedFiles.size) {
              const processed = getProcessedFilesForEditReview(requestId)
              for (const f of changedFiles) processed.delete(f)
            }
          } catch {
            // ignore
          }

          try {
            const key = computeFilesKey(merged)
            state.editReviewLastFilesKeyByRequestId.set(requestId, key)
          } catch {
            // ignore
          }

          refreshEditReviewUiFromDiffs(requestId, merged, { summary: "Files changed" })
          post({ type: "editPreviewData", requestId, diffs: merged })

          // Open first changed file with inline hunks so editor UI shows.
          void openChangedFileForDiff(merged[0], { requestId, hunkIndex: 0 })
        },
      },
    )

    const rejectOnAcpExit = (label: string) =>
      new Promise<never>((_, reject) => {
        const proc = connected.process
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          reject(new Error(`${label} failed: ACP process exited (code=${code ?? "null"} signal=${signal ?? "null"})`))
        }
        const onError = (err: any) => {
          const msg = typeof err?.message === "string" ? err.message : String(err)
          reject(new Error(`${label} failed: ACP process error: ${msg}`))
        }
        try {
          proc.once("exit", onExit)
          proc.once("error", onError)
        } catch {
          // ignore
        }
      })

    state.acp = {
      process: connected.process,
      connection: connected.connection,
      sessionId: undefined,
      initialized: false,
      turnSeq: 0,
      activeTurnId: undefined,
      activeEditRequestId: undefined,
      lastUpdateAtMs: undefined,
      turnEndTimer: undefined,
      runningToolCallIds: new Set(),
      toolStartedAtMs: new Map(),
      toolNameById: new Map(),
      diffsByRequestId: new Map(),
    }

    post({ type: "chatSetStatus", status: "working", detail: "Connecting (ACP)…" })

    const initRes: any = await withTimeout<any>(
      Promise.race([
        connected.connection.initialize({
      protocolVersion: 1,
      clientInfo: {
        name: "opencode-vscode",
        version: String(context.extension.packageJSON?.version ?? "0"),
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
        _meta: {
          "terminal-auth": true,
          "agent-mode": String(state.activeAgentProfileId ?? ""),
          "fs-write-policy": isPlanMode() ? "plans-only" : "all",
        },
      },
        } as any),
        rejectOnAcpExit("ACP initialize"),
      ]),
      getAcpInitializeTimeoutMs(),
      "ACP initialize",
    )

    state.acp.initialized = true
    logLine(state, `acp initialized: protocol=${initRes?.protocolVersion ?? "?"}`)

    const sessionRes: any = await withTimeout<any>(
      Promise.race([
        connected.connection.newSession({
        cwd,
        mcpServers: [],
        } as any),
        rejectOnAcpExit("ACP newSession"),
      ]),
      getAcpNewSessionTimeoutMs(),
      "ACP newSession",
    )

    state.acp.sessionId = String(sessionRes?.sessionId ?? "").trim() || undefined
    if (!state.acp.sessionId) throw new Error("ACP newSession returned empty sessionId")

    // Populate Agent menu + sync persisted profile selection.
    try {
      const modes: any[] = Array.isArray(sessionRes?.modes?.availableModes) ? sessionRes.modes.availableModes : []
      const currentModeId = String(sessionRes?.modes?.currentModeId ?? "").trim()
      postAgentsMenu(modes.map((m: any) => ({ id: String(m?.id ?? m?.name ?? ""), name: String(m?.name ?? m?.id ?? "") })))

      const desired = String(state.activeAgentProfileId ?? "").trim()
      const sessionId = state.acp.sessionId

      if (desired && desired !== currentModeId) {
        try {
          await connected.connection.setSessionMode({ sessionId, modeId: desired } as any)
          state.activeAgentProfileId = desired
        } catch {
          // If the desired mode doesn't exist, fall back to server-selected.
          state.activeAgentProfileId = currentModeId || desired
        }
      } else {
        state.activeAgentProfileId = currentModeId || desired || state.activeAgentProfileId
      }

      const finalMode = String(state.activeAgentProfileId ?? "").trim()
      if (finalMode) {
        void context.globalState.update(ACTIVE_AGENT_PROFILE_ID_KEY, finalMode)
        postAgentProfile(finalMode)
      }
    } catch {
      // ignore
    }

    const rawModelsAny = (() => {
      const direct = sessionRes?.models
      if (Array.isArray(direct)) return direct

      // Some servers may nest under models.availableModels or similar.
      const nested = sessionRes?.models?.availableModels
      if (Array.isArray(nested)) return nested

      const alt = sessionRes?.availableModels
      if (Array.isArray(alt)) return alt

      // Some servers may return an object map: { [modelId]: { name, ... } }
      if (direct && typeof direct === "object" && !Array.isArray(direct)) {
        const entries = Object.entries(direct as Record<string, any>)
        return entries.map(([k, v]) => ({ id: k, name: v?.name ?? v?.displayName ?? "" }))
      }

      return []
    })()

    const lmModelsParsed = rawModelsAny
      .map((m: any) => {
        if (typeof m === "string") {
          const id = String(m).trim()
          return { id, name: "" }
        }
        const id = String(m?.modelId ?? m?.id ?? m?.model ?? "").trim()
        const name = String(m?.name ?? m?.displayName ?? "").trim()
        return { id, name }
      })
      .filter((m: any) => m.id)

    // Fallback: if ACP doesn't return models, use CLI output.
    const lmModels = lmModelsParsed.length ? lmModelsParsed : await getModelsViaCliFallback("acp")
    if (!lmModelsParsed.length && lmModels.length) {
      logLine(state, `acp newSession returned no models; using cli fallback (models=${lmModels.length})`)
    }

    if (state.acp) state.acp.modelsCache = lmModels

    if (lmModelsParsed.length) {
      noteLastKnownLmModels(lmModels, `acp · models=${lmModels.length}`)
    }

    const { filtered: visibleModels } = filterLmModelsForChat(context, lmModels)

    // Keep selection consistent with the visible list.
    if (visibleModels.length) {
      if (!state.selectedModelId || !visibleModels.some((m) => m.id === state.selectedModelId)) {
        state.selectedModelId = visibleModels[0].id
      }
    } else {
      // No visible models; do not force selection.
      if (state.selectedModelId && lmModels.some((m) => m.id === state.selectedModelId)) {
        // Keep as-is.
      }
    }

    post({ type: "lmModels", models: visibleModels, selectedModelId: state.selectedModelId })

    // Apply model selection if it matches ACP model IDs.
    if (state.selectedModelId && lmModelsParsed.some((m: any) => String(m?.id ?? "") === state.selectedModelId)) {
      try {
        await connected.connection.unstable_setSessionModel({ sessionId: state.acp.sessionId, modelId: state.selectedModelId } as any)
      } catch {
        // ignore
      }
    }

    post({ type: "chatSetStatus", status: "idle", detail: `ACP: ${cwd}` })
  }

  const sendLmModels = async () => {
    try {
      const baseUrl = getEffectiveServerBaseUrl(state)
      const url = new URL("/provider", baseUrl)
      const res = await fetchWithTimeout(url, { method: "GET" }, 8000)
      if (!res.ok) {
        const text = await safeReadText(res)
        throw new Error(`provider.list failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
      }
      const json = (await res.json()) as any
      const providers: any[] = Array.isArray(json?.all) ? json.all : []
      const connected = new Set<string>(Array.isArray(json?.connected) ? json.connected.map((x: any) => String(x)) : [])
      const defaults: Record<string, string> = json?.default && typeof json.default === "object" ? json.default : {}

      const models: Array<{ id: string; name?: string; vendor?: string; rightText?: string }> = []

      for (const p of providers) {
        const providerID = String(p?.id ?? "").trim()
        if (!providerID) continue
        const providerName = String(p?.name ?? providerID).trim()
        const providerModels = p?.models && typeof p.models === "object" ? p.models : {}
        const isConnected = connected.has(providerID)
        const keys = Object.keys(providerModels).sort((a, b) => a.localeCompare(b))
        for (const modelID of keys) {
          const meta = providerModels[modelID]
          const displayName = String(meta?.name ?? modelID).trim()
          models.push({
            id: `${providerID}/${modelID}`,
            name: displayName,
            vendor: providerName,
            rightText: isConnected ? "" : "未登录",
          })
        }
      }

      models.sort((a, b) => {
        const aConn = a.rightText ? 1 : 0
        const bConn = b.rightText ? 1 : 0
        if (aConn !== bConn) return aConn - bConn
        const av = String(a.vendor ?? "")
        const bv = String(b.vendor ?? "")
        const v = av.localeCompare(bv)
        if (v !== 0) return v
        return String(a.id).localeCompare(String(b.id))
      })

      const pickDefault = (): string | undefined => {
        const connectedProviders = providers
          .map((p) => String(p?.id ?? "").trim())
          .filter(Boolean)
          .filter((id) => connected.has(id))

        for (const pid of connectedProviders) {
          const def = String(defaults[pid] ?? "").trim()
          if (def) {
            const full = `${pid}/${def}`
            if (models.some((m) => m.id === full)) return full
          }
        }

        const firstConnected = models.find((m) => !m.rightText)?.id
        return firstConnected || models[0]?.id
      }

      noteLastKnownLmModels(models, `http+sse · server=${baseUrl} · models=${models.length}`)

      const { filtered: visibleModels } = filterLmModelsForChat(context, models)

      if (!state.selectedModelId || !visibleModels.some((m) => m.id === state.selectedModelId)) {
        // Prefer defaults among the visible list.
        const def = pickDefault()
        state.selectedModelId = def && visibleModels.some((m) => m.id === def) ? def : visibleModels[0]?.id
      }

      post({ type: "lmModels", models: visibleModels, selectedModelId: state.selectedModelId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      post({ type: "chatSetStatus", status: "error", detail: message })
    }
  }

  const ensureSseConnected = async () => {
    if (state.sseReady) return state.sseReady
    const baseUrl = getEffectiveServerBaseUrl(state)
    const directory = getDirectoryQuery()
    state.activeDirectory = directory || undefined

    logLine(state, `SSE connecting: ${new URL("/event", baseUrl).toString()} (directory=${directory || ""})`)

    const controller = new AbortController()
    state.sseAbort = controller

    let readyResolve: (() => void) | undefined
    let readyReject: ((err: any) => void) | undefined
    let readySettled = false
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    state.sseReady = ready

    ;(async () => {
      try {
        const url = new URL("/event", baseUrl)
        if (directory) url.searchParams.set("directory", directory)

        const res = await fetchWithTimeout(
          url,
          {
            method: "GET",
            headers: {
              Accept: "text/event-stream",
            },
            signal: controller.signal,
          },
          5000
        )

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status} ${res.statusText}`)
        }

        logLine(state, `SSE connected: ${url.toString()}`)

        if (!readySettled) {
          readySettled = true
          readyResolve?.()
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder("utf-8")
        let buffer = ""

        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let idx
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const rawEvent = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)

            const parsed = parseSseEvent(rawEvent)
            if (!parsed) continue
            handleEvent(post, state, parsed, {
              requestPermissionFromWebview,
              requestQuestionFromWebview,
            })
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return
        const message = err instanceof Error ? err.message : String(err)
        logLine(state, `SSE error: ${message}`)
        post({ type: "chatSetStatus", status: "error", detail: message })
        if (!readySettled) {
          readySettled = true
          readyReject?.(err)
        }
        await offerStartServer(context, state, post, message)
      } finally {
        if (state.sseAbort === controller) state.sseAbort = undefined
        if (state.sseReady === ready) state.sseReady = undefined
      }
    })()

    return ready
  }

  const onMessage = webview.onDidReceiveMessage(async (msg: WebviewInboundMessage) => {
    switch (msg.type) {
      case "webviewReady": {
        webviewIsReady = true
        rawPost({ type: "init", extensionName: "" })
        rawPost({ type: "host", host })
        // Mirror a subset of VS Code chat.agent.* settings into the webview UI.
        rawPost({ type: "chatConfig", config: readChatUiConfig() })

        // Seed agent UI from persisted selection (best-effort; ACP will update after newSession).
        postAgentsMenu()
        if (state.activeAgentProfileId) postAgentProfile(state.activeAgentProfileId)
        if (transport() === "acp") {
          post({ type: "chatSetStatus", status: "idle", detail: `ACP: ${getDirectoryQuery() || ""}` })
          logLine(state, `webviewReady (host=${host}) transport=acp cwd=${getDirectoryQuery() || ""}`)
        } else {
          post({ type: "chatSetStatus", status: "idle", detail: `Server: ${getEffectiveServerBaseUrl(state)}` })
          logLine(state, `webviewReady (host=${host}) transport=http+sse baseUrl=${getEffectiveServerBaseUrl(state)} directory=${getDirectoryQuery() || ""}`)
        }
        post({ type: "workspaceContext", workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath) })

        // Ensure init/host/status land before any queued outbound messages.
        flushOutboundQueue()

        // Copilot-like: auto-add active editor context to composer chips.
        updateAutoActiveFileContextFromEditor(vscode.window.activeTextEditor)

        if (transport() === "acp") {
          void ensureAcpConnected().catch((err) => {
            const message = err instanceof Error ? err.message : String(err)

            // Copilot-like: background connection attempts should not permanently show an error.
            // We only surface a hard error when the user actually sends a prompt and ACP fails.
            logLine(state, `acp auto-connect failed (background): ${message}`)
            post({ type: "chatSetStatus", status: "idle", detail: `ACP: ${getDirectoryQuery() || ""}` })
          })
        } else {
          void ensureSseConnected().catch(() => {
            // Errors are surfaced via chatSetStatus + offerStartServer.
          })
          void sendLmModels()
        }
        return
      }
      case "setActiveAgentProfile": {
        const id = String((msg as any)?.id ?? "").trim()
        if (!id) return
        state.activeAgentProfileId = id
        void context.globalState.update(ACTIVE_AGENT_PROFILE_ID_KEY, id)
        postAgentProfile(id)

        if (transport() === "acp") {
          try {
            await ensureAcpConnected()
            const sessionId = state.acp?.sessionId
            if (sessionId) await state.acp!.connection.setSessionMode({ sessionId, modeId: id } as any)
          } catch {
            // ignore
          }
        }
        return
      }
      case "requestWorkspaceContext": {
        post({ type: "workspaceContext", workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath) })
        return
      }
      case "cancel": {
        await abortCurrent(state)
        post({ type: "chatAssistantEnd" })
        post({ type: "chatSetStatus", status: "idle" })
        return
      }
      case "checkpointAction": {
        const action = msg.action
        const checkpointId = String((msg as any)?.checkpointId ?? "").trim()
        const redoToken = String((msg as any)?.redoToken ?? "").trim()
        if (!checkpointId) return
        if (state.isBusy) {
          vscode.window.showWarningMessage("正在运行中，无法还原/重做检查点。请先点击“停止”。")
          return
        }
        try {
          if (action === "restore") {
            await performCheckpointRestore(post, state, checkpointId)
          } else if (action === "redo") {
            await performCheckpointRedo(post, state, checkpointId, redoToken)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`检查点操作失败：${message}`)
        }
        return
      }
      case "questionAction": {
        const requestId = String(msg.requestId ?? "").trim()
        if (!requestId) return
        const resolve = pendingQuestionByRequestId.get(requestId)
        if (!resolve) return
        pendingQuestionByRequestId.delete(requestId)
        const title = pendingQuestionTitleByRequestId.get(requestId)
        pendingQuestionTitleByRequestId.delete(requestId)
        post({ type: "questionClear", requestId })

        const action = msg.action
        if (action === "reply" && Array.isArray(msg.answers)) {
          post({ type: "chatProgress", id: `q:${requestId}`, text: title ? `Input received: ${title}` : "Input received", status: "done" })
          resolve(msg.answers.map((a) => (Array.isArray(a) ? a.map((x) => String(x)) : [])).filter(Boolean))
        } else {
          post({ type: "chatProgress", id: `q:${requestId}`, text: title ? `Input rejected/cancelled: ${title}` : "Input rejected/cancelled", status: "error" })
          resolve(undefined)
        }
        return
      }
      case "permissionAction": {
        const requestId = String(msg.requestId ?? "").trim()
        const optionId = typeof msg.optionId === "string" ? msg.optionId.trim() : undefined
        if (!requestId) return
        const resolve = pendingPermissionByRequestId.get(requestId)
        if (!resolve) return
        pendingPermissionByRequestId.delete(requestId)
        const title = pendingPermissionTitleByRequestId.get(requestId)
        pendingPermissionTitleByRequestId.delete(requestId)
        post({ type: "permissionClear", requestId })

        if (!optionId) {
          post({ type: "chatProgress", id: `perm:${requestId}`, text: title ? `Approval cancelled: ${title}` : "Approval cancelled", status: "error" })
        } else if (optionId === "reject") {
          post({ type: "chatProgress", id: `perm:${requestId}`, text: title ? `Approval rejected: ${title}` : "Approval rejected", status: "error" })
        } else {
          post({ type: "chatProgress", id: `perm:${requestId}`, text: title ? `Approval granted (${optionId}): ${title}` : `Approval granted (${optionId})`, status: "done" })
        }
        resolve(optionId)
        return
      }
      case "chatUserMessage": {
        const text = String(msg.text ?? "").trim()
        if (!text) return

        // Any new user action invalidates the restore->redo offer.
        if (state.activeRedoOffer) {
          state.activeRedoOffer = undefined
          post({ type: "checkpointRedoClear" })
        }

        if (!state.transcript) state.transcript = []
        // Capture the transcript boundary for this turn BEFORE appending the user message.
        // This is used for Copilot-like checkpoint restore (rewind to before the turn).
        state.turnStartTranscriptIndex = state.transcript.length
        state.transcript.push({ kind: "chat", role: "user", text })
        state.turnAssistantText = ""

        post({ type: "chatAppend", role: "user", text })
        // Copilot-like: start with Working, then transition to Thinking when tools/progress start.
        post({ type: "chatSetStatus", status: "working", detail: "Working…" })
        post({ type: "chatAssistantStart" })

        // Turn-scoped state for one-line completion summaries.
        state.turnSeq = (state.turnSeq ?? 0) + 1
        state.turnUserText = text
        state.turnSummarySteps = []

        state.assistantMessageId = undefined
        state.isBusy = true
        state.didLogFirstAssistantDelta = false
        state.didEmitThinkingTranscriptForTurn = false

        // Copilot-like: references are scoped per turn (not per session).
        // Reset seen set so the same file can appear again on later turns.
        state.seenReferenceUris = new Set()

        // Copilot-like: if the user attached file context (chips) or used #file: tags,
        // surface them as "Used n references" even when no explicit tool/progress events occur.
        try {
          const normalizeRel = (p: string) => String(p ?? "").replaceAll("\\\\", "/").trim().replace(/^\/+/, "")
          const pushed = new Set<string>()
          const pushRef = (uriRaw: string) => {
            const u = String(uriRaw ?? "").trim()
            if (!u) return
            const key = process.platform === "win32" ? u.toLowerCase() : u
            if (pushed.has(key)) return
            pushed.add(key)
            if (state.seenReferenceUris.has(u)) return
            state.seenReferenceUris.add(u)
            post({ type: "chatReference", uri: u })
          }

          const auto = contextById.get(AUTO_ACTIVE_FILE_CONTEXT_ID)
          const manual = Array.from(contextById.values()).filter((e) => e.id !== AUTO_ACTIVE_FILE_CONTEXT_ID)

          // Include auto active file even when manual context exists,
          // but avoid duplicating it if the same file is already manually added.
          const entries: Array<any> = [...manual]
          if (auto) {
            try {
              const autoRel = normalizeRel(String(vscode.workspace.asRelativePath(auto.uri, false) || auto.title || ""))
              const hasSameManual = manual.some((m) => {
                const rel = normalizeRel(String(vscode.workspace.asRelativePath(m.uri, false) || m.title || ""))
                if (!autoRel || !rel) return false
                return process.platform === "win32" ? rel.toLowerCase() === autoRel.toLowerCase() : rel === autoRel
              })
              if (!hasSameManual) entries.push(auto)
            } catch {
              entries.push(auto)
            }
          }

          for (const e of entries) {
            if (!e?.uri) continue
            const rel = normalizeRel(String(vscode.workspace.asRelativePath(e.uri, false) || e.title || ""))
            pushRef(rel || String(e.title || "").trim())
          }

          // Best-effort parse: #file:<path> tokens in the user text.
          // This is used by the composer hash-suggest UX.
          const re = /#file:([^\s]+)/g
          let m: RegExpExecArray | null
          while ((m = re.exec(text))) {
            const rel = normalizeRel(m[1])
            if (rel) pushRef(rel)
          }
        } catch {
          // ignore
        }

        logLine(state, `prompt: ${truncate(text.replace(/\s+/g, " "), 200)}`)

        // Preflight short-circuit (ACP): if the user immediately asks to delete the random
        // content that was just inserted, but the file has already been reverted back to
        // the clean baseline, avoid triggering ACP apply_patch/grep retries.
        try {
          if (transport() === "acp" && isDeleteRecentlyAddedRandomContentRequest(text)) {
            const active = vscode.window.activeTextEditor
            const activeIsFile = Boolean(active && active.document?.uri?.scheme === "file")
            const activeDirty = Boolean(activeIsFile && (active!.document as any)?.isDirty)
                      const transcriptIndex = Number.isFinite(state.turnStartTranscriptIndex as any)
                        ? Math.max(0, state.turnStartTranscriptIndex as number)
                        : state.transcript.length
              activeIsFile && !activeDirty ? canonicalizeFileKey(active!.document.uri.fsPath) : undefined

            const candidate = pickRecentCleanBaselineCandidate({ preferredFileKey })
            if (candidate?.fileKey) {
              // Only short-circuit when we don't currently think there are pending edits for this file.
              const hasPending =
                editPendingRequestIdsByFileKey.has(candidate.fileKey) ||
                editNavPendingDiffByUri.has(candidate.uriKey) ||
                editNavByUri.has(candidate.uriKey)

              if (!hasPending) {
                const uri =
                  activeIsFile && preferredFileKey && candidate.fileKey === preferredFileKey
                    ? active!.document.uri
                    : vscode.Uri.parse(candidate.uriKey)

                const diskText = await readTextFileBestEffort(uri, 4 * 1024 * 1024)
                if (typeof diskText === "string" && fastTextSig(diskText) === candidate.sig) {
                  logLine(state, `shortcircuit: delete-random-content already clean file=${tryToRelativePath(uri.fsPath)}`)
                  post({
                    type: "chatAppend",
                    role: "assistant",
                    text: "你刚才已经执行了撤销/回滚，当前文件已回到基线状态，因此没有需要删除的随机内容。",
                  })
                  post({ type: "chatAssistantEnd" })
                  post({ type: "chatSetStatus", status: "idle" })
                  state.isBusy = false
                  state.didEmitThinkingTranscriptForTurn = false
                  state.didLogFirstAssistantDelta = false
                  state.assistantMessageId = undefined
                  return
                }
              }
            }
          }
        } catch {
          // ignore
        }

        try {
          const parts = await buildPromptParts(text)
          if (transport() === "acp") {
            await ensureAcpConnected()
            if (!state.acp?.sessionId) throw new Error("ACP session not initialized")

            // Start a new ACP turn. We don't get a reliable explicit "done" event,
            // so onSessionUpdate will end the turn via inactivity debounce.
            state.acp.turnSeq = (state.acp.turnSeq ?? 0) + 1
            state.acp.activeTurnId = String(state.acp.turnSeq)
            state.acp.activeEditRequestId = `acp-turn:${state.acp.sessionId}:${state.acp.activeTurnId}`
            state.acp.lastUpdateAtMs = Date.now()
            state.acp.lastToolUpdateAtMs = undefined
            state.acp.lastAssistantChunkAtMs = undefined
            state.acp.runningToolCallIds?.clear()
            if (state.acp.turnEndTimer) {
              try {
                clearTimeout(state.acp.turnEndTimer)
              } catch {
                // ignore
              }
              state.acp.turnEndTimer = undefined
            }

            // Ensure edit-review state is initialized for this turn.
            state.editReviewProcessedFilesByRequestId.set(state.acp.activeEditRequestId, new Set())
            state.editReviewLastFilesKeyByRequestId.set(state.acp.activeEditRequestId, "")

            await state.acp.connection.prompt({
              sessionId: state.acp.sessionId,
              prompt: parts,
            } as any)
          } else {
            await ensureSseConnected()
            await ensureSession(state)
            await promptAsync(state, state.sessionId!, parts)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logLine(state, `prompt error: ${message}`)
          post({ type: "chatAppend", role: "assistant", text: `Error: ${message}` })
          post({ type: "chatAssistantEnd" })
          post({ type: "chatSetStatus", status: "error", detail: message })
          state.isBusy = false
          if (transport() !== "acp") await offerStartServer(context, state, post, message)
        }
        return
      }
      case "editReviewAction": {
        const requestId = String(msg.requestId ?? "").trim()
        const action = msg.action
        const file = String((msg as any)?.file ?? "").trim()
        if (!requestId) return
        await handleEditReviewAction({ requestId, action, file })
        return
      }
      case "editApprovalAction": {
        const requestId = String(msg.requestId ?? "").trim()
        const action = msg.action
        if (!requestId) return
        const pending = pendingEditApprovalByRequestId.get(requestId)
        if (!pending) return

        if (action === "preview") {
          post({ type: "editPreviewData", requestId, diffs: pending.diffs })
          return
        }

        pendingEditApprovalByRequestId.delete(requestId)
        post({ type: "editApprovalClear", requestId })

        if (action === "apply") {
          post({ type: "chatProgress", id: `edit:${requestId}`, text: pending.title ? `Edit approved: ${pending.title}` : "Edit approved", status: "done" })
          pending.resolve("apply")
          return
        }

        post({ type: "chatProgress", id: `edit:${requestId}`, text: pending.title ? `Edit cancelled: ${pending.title}` : "Edit cancelled", status: "error" })
        pending.resolve("cancel")
        return
      }
      case "uiAction":
        await (async () => {
          const action = String(msg.action ?? "").trim()
          const payload = msg.payload
          if (!action) return

          if (action === "revealTerminal") {
            try {
              await vscode.commands.executeCommand("workbench.action.terminal.focus")
            } catch {
              // ignore
            }
            return
          }

          if (action === "setAgentProfile") {
            const id = String(payload?.id ?? "").trim()
            if (!id) return
            state.activeAgentProfileId = id
            void context.globalState.update(ACTIVE_AGENT_PROFILE_ID_KEY, id)
            postAgentProfile(id)

            if (transport() === "acp") {
              try {
                await ensureAcpConnected()
                const sessionId = state.acp?.sessionId
                if (sessionId) await state.acp!.connection.setSessionMode({ sessionId, modeId: id } as any)
              } catch {
                // ignore
              }
            }
            return
          }

          if (action === "removeContext") {
            const id = String(payload?.id ?? "").trim()
            if (!id) return
            const existing = contextById.get(id)
            if (id === AUTO_ACTIVE_FILE_CONTEXT_ID && existing) {
              suppressedAutoActiveFileKey = existing.uri.toString()
            }
            contextById.delete(id)
            postContextChips()
            return
          }

          if (action === "attachFileRef") {
            const ref = String(payload?.ref ?? "").trim()
            if (!ref) return
            const uri = resolveAnyFileUri(ref)
            if (!uri) {
              vscode.window.showWarningMessage(`找不到文件：${ref}`)
              return
            }
            const { id } = canonicalizeFileContextId(uri)
            contextById.set(id, toContextChip(id, "file", uri))
            postContextChips()
            return
          }

          if (action === "addContext") {
            const defaultUri = (vscode.workspace.workspaceFolders ?? [])[0]?.uri
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: true,
              canSelectFiles: true,
              canSelectFolders: false,
              openLabel: "添加到上下文",
              defaultUri,
            })
            if (!picked || !picked.length) return
            for (const uri of picked) {
              const { id } = canonicalizeFileContextId(uri)
              contextById.set(id, toContextChip(id, "file", uri))
            }
            postContextChips()
            return
          }

          if (action === "hashSuggest") {
            const prefixRaw = String(payload?.prefix ?? "")
            const prefix = prefixRaw.trim()

            const parseFileQuery = (p: string): string => {
              const t = String(p ?? "").trim()
              const lower = t.toLowerCase()
              if (lower.startsWith("file:")) return t.slice(5).trim()
              if (lower === "file") return ""
              if (lower.startsWith("file")) return t.slice(4).replace(/^[:\s]+/, "").trim()
              return t
            }

            const query = parseFileQuery(prefix)
            const maxItems = 24
            const items: Array<{ kind: "file"; label: string; detail?: string; insertText?: string }> = []
            const seen = new Set<string>()

            const pushUri = (uri: vscode.Uri | undefined) => {
              if (!uri) return
              // Only suggest real files.
              if (uri.scheme !== "file") return
              const relRaw = vscode.workspace.asRelativePath(uri, false)
              const rel = normalizeRelPath(String(relRaw ?? ""))
              if (!rel) return
              const key = rel.toLowerCase()
              if (seen.has(key)) return
              seen.add(key)

              const fileName = (rel.split("/").pop() || rel).trim()
              const dir = rel.split("/").slice(0, -1).join("/")
              items.push({
                kind: "file",
                label: fileName,
                detail: dir && dir !== "." ? dir : "",
                insertText: `#file:${rel}`,
              })
            }

            // Prefer currently visible/open files (Copilot-like “recently used”).
            pushUri(vscode.window.activeTextEditor?.document?.uri)
            for (const ed of vscode.window.visibleTextEditors ?? []) {
              pushUri(ed?.document?.uri)
              if (items.length >= maxItems) break
            }

            const escapeGlob = (s: string): string => {
              // minimatch special chars: \\ {} () [] * ?
              return s.replace(/[\\{}()[\]*?]/g, "\\\\$&")
            }

            const exclude = WORKSPACE_FILE_INDEX_EXCLUDE

            // If user typed something beyond #file, search the workspace.
            const qNorm = String(query ?? "").replaceAll("\\\\", "/").replace(/^\/+/, "").trim()

            // Copilot-like: typing just `#` (or `#file` with no query) should respond immediately.
            // Use a capped workspace list to ensure suggestions are not limited to open editors.
            if (!qNorm) {
              for (const doc of vscode.workspace.textDocuments ?? []) {
                pushUri(doc?.uri)
                if (items.length >= maxItems) break
              }

              // Always include some workspace files (not only opened ones).
              // Build cache in the background so subsequent filtering is fast.
              const index = await ensureWorkspaceFileIndex()
              for (const rel of index.relPaths) {
                if (items.length >= maxItems) break
                const key = rel.toLowerCase()
                if (seen.has(key)) continue
                seen.add(key)
                const fileName = (rel.split("/").pop() || rel).trim()
                const dir = rel.split("/").slice(0, -1).join("/")
                items.push({
                  kind: "file",
                  label: fileName,
                  detail: dir && dir !== "." ? dir : "",
                  insertText: `#file:${rel}`,
                })
              }

              post({ type: "hashSuggestions", items })
              return
            }

            if (items.length < maxItems) {
              const qLower = qNorm.toLowerCase()

              // Prefer cached workspace list for responsive filtering.
              const idx = await ensureWorkspaceFileIndex()
              const scored: Array<{ rel: string; score: number }> = []
              for (const rel of idx.relPaths) {
                const relLower = rel.toLowerCase()
                if (!relLower.includes(qLower)) continue
                const base = (relLower.split("/").pop() || relLower).trim()
                const score = base.startsWith(qLower) ? 0 : base.includes(qLower) ? 1 : 2
                scored.push({ rel, score })
              }
              scored.sort((a, b) => {
                if (a.score !== b.score) return a.score - b.score
                if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length
                return a.rel.localeCompare(b.rel)
              })

              for (const { rel } of scored) {
                if (items.length >= maxItems) break
                const key = rel.toLowerCase()
                if (seen.has(key)) continue
                seen.add(key)
                const fileName = (rel.split("/").pop() || rel).trim()
                const dir = rel.split("/").slice(0, -1).join("/")
                items.push({
                  kind: "file",
                  label: fileName,
                  detail: dir && dir !== "." ? dir : "",
                  insertText: `#file:${rel}`,
                })
              }

              // Fallback: glob search if cache is empty.
              if (items.length < maxItems && idx.relPaths.length === 0) {
                const pattern = qNorm.includes("/") ? `**/${escapeGlob(qNorm)}*` : `**/*${escapeGlob(qNorm)}*`
                try {
                  const uris = await vscode.workspace.findFiles(pattern, exclude, Math.max(40, maxItems * 4))
                  for (const uri of uris) {
                    if (items.length >= maxItems) break
                    pushUri(uri)
                  }
                } catch {
                  // ignore
                }
              }
            }

            post({ type: "hashSuggestions", items })
            return
          }

          if (action === "requestModels") {
            if (transport() === "acp") {
              try {
                await ensureAcpConnected()
                let cached = Array.isArray(state.acp?.modelsCache) ? state.acp!.modelsCache : []
                if (!cached.length) {
                  cached = await getModelsViaCliFallback("acp")
                  if (state.acp) state.acp.modelsCache = cached
                }
                const { filtered: visibleModels } = filterLmModelsForChat(context, cached)
                if (visibleModels.length) {
                  if (!state.selectedModelId || !visibleModels.some((m) => m.id === state.selectedModelId)) {
                    state.selectedModelId = visibleModels[0].id
                    const sessionId = state.acp?.sessionId
                    if (sessionId) {
                      try {
                        await state.acp!.connection.unstable_setSessionModel({ sessionId, modelId: state.selectedModelId } as any)
                      } catch {
                        // ignore
                      }
                    }
                  }
                }
                post({ type: "lmModels", models: visibleModels, selectedModelId: state.selectedModelId })
              } catch {
                // ignore
              }
              return
            }

            await sendLmModels()
            return
          }

          if (action === "openSettings") {
            OpencodeSettingsPanel.show(context, { initialPage: "models" })
            return
          }

          if (action === "openToolsSettings") {
            OpencodeSettingsPanel.show(context, { initialPage: "tools" })
            return
          }

          if (action === "setModel") {
            const id = String(payload?.id ?? "").trim()
            if (id) {
              state.selectedModelId = id
              post({ type: "chatSetStatus", status: "idle", detail: `Model: ${id}` })

              if (transport() === "acp" && state.acp?.sessionId) {
                try {
                  await state.acp.connection.unstable_setSessionModel({ sessionId: state.acp.sessionId, modelId: id } as any)
                } catch {
                  // ignore
                }
              }
            }
            return
          }

          if (action === "manageModels") {
            OpencodeSettingsPanel.show(context, { initialPage: "models" })
            return
          }

          if (action === "showChat") {
            await vscode.commands.executeCommand("opencode.openChatInSidebar")
            return
          }

          if (action === "moveToEditor" || action === "newChatEditor") {
            await openChat(context)
            return
          }

          if (action === "moveToNewWindow" || action === "newChatWindow") {
            await openChat(context, { moveToNewWindow: true })
            return
          }

          if (action === "openFile") {
            const rel = String(payload?.path ?? "").trim()
            if (!rel) return
            const uri = resolveProjectFileUri(rel, getDirectoryQuery())
            if (!uri) {
              vscode.window.showWarningMessage(`找不到文件：${rel}`)
              return
            }
            const doc = await vscode.workspace.openTextDocument(uri)
            await vscode.window.showTextDocument(doc, { preview: true })
            return
          }

          if (action === "openExternal") {
            const raw = String(payload?.url ?? "").trim()
            if (!raw) return
            try {
              const uri = vscode.Uri.parse(raw)
              await vscode.env.openExternal(uri)
            } catch {
              vscode.window.showWarningMessage(`无法打开链接：${raw}`)
            }
            return
          }

          if (action === "openChangedFile") {
            const file = String(payload?.file ?? "").trim()
            const requestId = String(payload?.requestId ?? "").trim()
            const hunkIndex = Number(payload?.hunkIndex)
            if (!file) return
            const fileKey = canonicalizeFileKey(file)
            const isSession = transport() === "acp" && requestId === EDITS_REVIEW_SESSION_ID

            let diff: any | undefined
            let requestIdToUse: string | undefined = requestId || undefined

            if (isSession) {
              const found = findPendingReviewDiffForFile(file)
              diff = found.diff
              requestIdToUse = found.requestId || undefined
            } else {
              const diffs =
                transport() === "acp" && requestId
                  ? state.acp?.diffsByRequestId.get(requestId) ?? (await getLatestReviewDiffs())
                  : await getLatestReviewDiffs()
              diff =
                diffs.find((d: any) => {
                  const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
                  return fk && fileKey && fk === fileKey
                }) || diffs.find((d: any) => String(d?.file ?? "").trim() === file)

              if (!diff) {
                const found = findPendingReviewDiffForFile(file)
                diff = found.diff
                requestIdToUse = requestIdToUse || found.requestId || undefined
              }
            }
            if (!diff) {
              vscode.window.showWarningMessage(`未找到 diff：${file}`)
              return
            }
            await openChangedFileForDiff(diff, {
              requestId: requestIdToUse,
              hunkIndex: Number.isFinite(hunkIndex) ? hunkIndex : undefined,
            })
            return
          }

          if (action === "openDiff") {
            const file = String(payload?.file ?? "").trim()
            if (!file) return
            const fileKey = canonicalizeFileKey(file)
            const diffs = await getLatestReviewDiffs()
            let diff =
              diffs.find((d: any) => {
                const fk = typeof d?.fileKey === "string" && d.fileKey.trim() ? String(d.fileKey).trim() : canonicalizeFileKey(d?.file)
                return fk && fileKey && fk === fileKey
              }) || diffs.find((d: any) => String(d?.file ?? "").trim() === file)
            if (!diff) {
              // Fallback: Copilot-like session-level pending edits may not be present in getLatestReviewDiffs().
              const found = findPendingReviewDiffForFile(file)
              diff = found.diff
            }
            if (!diff) {
              vscode.window.showWarningMessage(`未找到 diff：${file}`)
              return
            }
            await openDiffForFile(diff, getDirectoryQuery())
            return
          }

          if (action === "openAllDiffs") {
            let diffs = await getLatestReviewDiffs()
            if (!diffs.length) {
              // Fallback to pending session diffs when ACP doesn't surface diff blocks.
              diffs = buildPendingReviewDiffs()
            }
            const max = 15
            const items = diffs.slice(0, max)
            if (!items.length) {
              vscode.window.showInformationMessage("当前没有可打开的 diff。")
              return
            }
            if (diffs.length > max) {
              vscode.window.showInformationMessage(`文件较多（${diffs.length}），仅打开前 ${max} 个 diff。`)
            }
            for (const d of items) {
              try {
                await openDiffForFile(d, getDirectoryQuery())
              } catch {
                // ignore single failure, continue
              }
            }
            return
          }

          if (action === "openEditsReviewPanel") {
                // Copilot-like: do not open a separate edits panel with per-file Keep/Undo.
                // Users should review inline in the editor with the bottom-right status bar controls.
                vscode.window.showInformationMessage("请在编辑器中查看更改（底部状态栏提供保留/撤销与导航）。")
                return
          }
        })()
        return
    }
  })

  return new vscode.Disposable(() => {
    try {
      chatConfigDisposable.dispose()
    } catch {
      // ignore
    }
    try {
      activeChatViews.delete(activeView)
    } catch {
      // ignore
    }
    try {
      activeEditorDisposable.dispose()
    } catch {
      // ignore
    }
    try {
      onMessage.dispose()
    } catch {
      // ignore
    }
    try {
      void abortCurrent(state)
    } catch {
      // ignore
    }
    try {
      state.sseAbort?.abort()
    } catch {
      // ignore
    }
    try {
      if (state.acp?.process && !state.acp.process.killed) {
        state.acp.process.kill()
      }
    } catch {
      // ignore
    }
  })
}

function getHtml(context: vscode.ExtensionContext, webview: vscode.Webview, host: "editor" | "sidebar"): string {
  const nonce = getNonce()
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "main.css"))
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "main.js"))

  const svg = (name: string): string => {
    switch (name) {
      case "add":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/></svg>`
      case "chevron-down":
        return `<svg class="iconSvg iconChevronDown" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.2 6.2 8 10l3.8-3.8 1 1L8 12 3.2 7.2z"/></svg>`
      case "settings":
        return `<svg class="iconSvg iconStroke" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.1 2.2 7 1h2l.9 1.2 1.4.4 1.3-.6 1.4 1.4-.6 1.3.4 1.4 1.2.9v2l-1.2.9-.4 1.4.6 1.3-1.4 1.4-1.3-.6-1.4.4L9 15H7l-.9-1.2-1.4-.4-1.3.6-1.4-1.4.6-1.3-.4-1.4L1 9V7l1.2-.9.4-1.4-.6-1.3L3.4 2l1.3.6z"/><path d="M8 10.5A2.5 2.5 0 1 0 8 5.5a2.5 2.5 0 0 0 0 5z"/></svg>`
      case "ellipsis":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="4" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12" cy="8" r="1.2"/></svg>`
      case "arrow-left":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M7 3 2 8l5 5 1.4-1.4L5.8 9H14V7H5.8l2.6-2.6z"/></svg>`
      case "refresh":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M13 3v4H9l1.6-1.6A3.5 3.5 0 1 0 12 8h2A5 5 0 1 1 8 3c1.4 0 2.7.6 3.6 1.5L13 3z"/></svg>`
      case "search":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.5 2a4.5 4.5 0 1 1 0 9 4.4 4.4 0 0 1-2.7-.9L2 12l1 1 1.8-1.9A4.4 4.4 0 0 1 6.5 11a4.5 4.5 0 0 1 0-9zm0 1.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>`
      case "filter":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 3h12L9 8v5l-2-1V8z"/></svg>`
      case "layout":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/></svg>`
      case "clippy":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6.5 4.5v7a2 2 0 0 0 4 0v-7a3.5 3.5 0 0 0-7 0V12a5 5 0 0 0 10 0V6h-1.5v6a3.5 3.5 0 0 1-7 0V4.5a2 2 0 0 1 4 0v7a.5.5 0 0 1-1 0v-7z"/></svg>`
      case "tools":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10.7 2.3a4 4 0 0 0-4.4 5.7L2 12.3V14h1.7l4.3-4.3a4 4 0 0 0 5.7-4.4l-2.1 2.1-1.8-.4-.4-1.8z"/></svg>`
      case "redo":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M12 5V2l3 3-3 3V6H6a3 3 0 1 0 0 6h6v2H6A5 5 0 1 1 6 4h6z"/></svg>`
      case "send":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 2l12 6-12 6 2-5 6-1-6-1z"/></svg>`
      case "stop":
        return `<svg class="iconSvg" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4h8v8H4z"/></svg>`
      default:
        return ""
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title></title>
</head>

<body class="host-${host}">
  <div class="app">
    <div class="topbar" role="toolbar" aria-label="Chat toolbar">
      <div class="topbarLeft">
        <div class="topbarTitle">聊天</div>
      </div>
      <div class="topbarRight">
        <button class="icon ghost" id="btnTopNew" aria-label="New" title="New">
          ${svg("add")}
          ${svg("chevron-down")}
        </button>
        <button class="icon ghost" id="btnTopSettings" aria-label="Settings" title="Settings">
          ${svg("settings")}
        </button>
        <button class="icon ghost" id="btnTopMore" aria-label="More" title="More">
          ${svg("ellipsis")}
        </button>
      </div>
      <div class="menu menuTop hidden" id="topNewMenu" role="menu" aria-label="New menu">
        <button class="menuItem" data-action="newSession" role="menuitem">新建聊天</button>
        <button class="menuItem" data-action="newChatEditor" role="menuitem">新建聊天编辑器</button>
        <button class="menuItem" data-action="newChatWindow" role="menuitem">新聊天窗口</button>
      </div>
      <div class="menu menuTop hidden" id="topMoreMenu" role="menu" aria-label="More menu">
        <button class="menuItem" data-action="moveToEditor" role="menuitem">将聊天移动到编辑器区域</button>
        <button class="menuItem" data-action="moveToNewWindow" role="menuitem">将聊天移动到新窗口</button>
        <div class="menuDivider" role="separator"></div>
        <button class="menuItem" data-action="showChat" role="menuitem">显示聊天...</button>
        <div class="menuDivider" role="separator"></div>
        <button class="menuItem" data-action="showChatDebug" role="menuitem">显示聊天调试视图</button>
        <button class="menuItem" data-action="defaultView" role="menuitem">默认显示视图</button>
      </div>
    </div>

    <div class="sessions" id="sessions" role="region" aria-label="Sessions">
      <div class="sessionNav hidden" id="sessionNav" role="toolbar" aria-label="Session navigation">
        <button class="icon ghost" id="btnSessionBack" aria-label="Back" title="Back">
          ${svg("arrow-left")}
        </button>
        <div class="sessionNavTitle" id="sessionNavTitle"></div>
      </div>
      <div class="sessionsHeader">
        <div class="sessionsHeaderLeft" id="sessionsHeaderText">RECENT SESSIONS</div>
        <div class="sessionsHeaderRight" id="sessionsHeaderActions">
          <button class="icon ghost hidden" id="btnSessionsRefresh" aria-label="Refresh" title="Refresh">${svg("refresh")}</button>
          <button class="icon ghost hidden" id="btnSessionsSearch" aria-label="Search" title="Search">${svg("search")}</button>
          <button class="icon ghost hidden" id="btnSessionsFilter" aria-label="Filter" title="Filter">${svg("filter")}</button>
          <button class="icon ghost" id="btnSessionsView" aria-label="View" title="View">${svg("layout")}</button>
        </div>
      </div>
      <div class="sessionsList" id="sessionsList"></div>
      <button class="sessionsToggle ghost" id="btnSessionsToggle">Show All Sessions</button>
    </div>

    <div class="approval hidden" id="approval" role="region" aria-label="Edit approval">
      <div class="approval-text" id="approvalText"></div>
      <div class="approval-files" id="approvalFiles"></div>
      <div class="approval-actions">
        <button class="ghost" id="approvalPreview">Preview</button>
        <button id="approvalApply">Apply</button>
        <button class="ghost" id="approvalCancel">Cancel</button>
      </div>
    </div>

    <div class="messages" id="messages" role="log" aria-live="polite"></div>
    <div class="composer">
      <div class="composerBox">
        <div class="status" id="status"></div>
        <div class="composerTop">
          <button class="contextButton ghost" id="btnAddContext" aria-label="Add context" title="添加上下文">
            ${svg("clippy")}
            <span class="contextButtonText">添加上下文...</span>
          </button>
          <div class="composerTokens" aria-label="Prompt tokens">
            <div class="contextChips" id="contextChips" aria-label="Context"></div>
            <div class="contextChips toolChips" id="toolChips" aria-label="Tools"></div>
          </div>
        </div>
        <textarea id="input" rows="2" placeholder="描述下一步要构建的内容" aria-label="Chat input"></textarea>
        <div class="hashSuggest hidden" id="hashSuggest" role="listbox" aria-label="Suggestions"></div>
        <div class="composerBottom" role="toolbar" aria-label="Composer toolbar">
          <div class="bottomLeft">
            <button class="menuButton ghost" id="btnAgentMenu" aria-label="Agent" title="Agent">
              <span class="menuLabel" id="agentLabel">Agent</span>
              ${svg("chevron-down")}
            </button>
            <button class="menuButton ghost" id="btnModelMenu" aria-label="Model" title="Model">
              <span class="menuLabel" id="modelLabel">Model</span>
              ${svg("chevron-down")}
            </button>
            <button class="icon ghost" id="btnTools" aria-label="Tools" title="Tools">
              ${svg("tools")}
            </button>
          </div>
          <div class="bottomCenter">
            <label class="tempSessionToggle" id="tempSessionToggleWrap" title="开启临时会话（不保存聊天记录）" aria-label="Temporary session">
              <input type="checkbox" id="tempSessionToggle" />
              <span class="tempSessionPill" id="tempSessionPill">临时会话</span>
            </label>
          </div>
          <div class="bottomRight">
            <button class="icon ghost" id="btnContinue" aria-label="Continue chat" title="Continue chat">
              ${svg("redo")}
            </button>
            <button id="send" class="icon send" title="Send" aria-label="Send">
              <span class="sendIcon" aria-hidden="true">${svg("send")}</span>
              <span class="stopIcon" aria-hidden="true">${svg("stop")}</span>
            </button>
          </div>
        </div>

        <div class="menu hidden" id="agentMenu" role="menu" aria-label="Agent menu"></div>
        <div class="menu menuModel hidden" id="modelMenu" role="menu" aria-label="Model menu">
          <button class="menuItem" data-value="manageModels" role="menuitem">管理模型...</button>
        </div>
        <div class="menu hidden" id="toolsMenu" role="menu" aria-label="Tools menu"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
}

function getServerBaseUrl(): string {
  const cfg = vscode.workspace.getConfiguration("opencode")
  return String(cfg.get("serverBaseUrl") ?? "http://127.0.0.1:4165").trim() || "http://127.0.0.1:4165"
}

function getEffectiveServerBaseUrl(state: ChatRuntimeState): string {
  return state.baseUrlOverride || getServerBaseUrl()
}

function getDirectoryQuery(): string {
  const cfg = vscode.workspace.getConfiguration("opencode")
  const configured = String(cfg.get("directory") ?? "").trim()
  if (configured) return configured
  const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
  return String(firstWorkspace ?? "").trim()
}

function getTransportMode(): "http+sse" | "acp" {
  const cfg = vscode.workspace.getConfiguration("opencode")
  const v = String(cfg.get("transport") ?? "http+sse").trim()
  return v === "acp" ? "acp" : "http+sse"
}

function getAcpCommand(): string {
  const cfg = vscode.workspace.getConfiguration("opencode")
  return String(cfg.get("acpCommand") ?? "opencode").trim() || "opencode"
}

function getAcpArgs(): string[] {
  const cfg = vscode.workspace.getConfiguration("opencode")
  const raw = cfg.get<any>("acpArgs")
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean)
  return ["acp"]
}

async function ensureSession(state: ChatRuntimeState) {
  if (state.sessionId) return
  const baseUrl = getEffectiveServerBaseUrl(state)
  const directory = getDirectoryQuery()
  const url = new URL("/session", baseUrl)
  if (directory) url.searchParams.set("directory", directory)

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    },
    10000
  )
  if (!res.ok) {
    throw new Error(`Create session failed: ${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as any
  const sessionId = String(json?.id ?? "").trim()
  if (!sessionId) throw new Error("Create session returned empty id")
  state.sessionId = sessionId
}

async function promptAsync(state: ChatRuntimeState, sessionId: string, parts: any[]) {
  const baseUrl = getEffectiveServerBaseUrl(state)
  const directory = getDirectoryQuery()
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/prompt_async`, baseUrl)
  if (directory) url.searchParams.set("directory", directory)

  const modelRef = parseModelRef(state.selectedModelId)
  logLine(state, `using model: ${modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : "(server default)"}`)

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelRef,
        parts: Array.isArray(parts) && parts.length ? parts : [],
      }),
    },
    15000
  )

  if (res.status !== 204) {
    const bodyText = await safeReadText(res)
    throw new Error(`prompt_async failed: ${res.status} ${res.statusText}${bodyText ? ` - ${bodyText}` : ""}`)
  }
}

function parseModelRef(selectedModelId: string | undefined): { providerID: string; modelID: string } | undefined {
  const raw = String(selectedModelId ?? "").trim()
  if (!raw) return
  const slash = raw.indexOf("/")
  if (slash <= 0 || slash >= raw.length - 1) return
  const providerID = raw.slice(0, slash).trim()
  const modelID = raw.slice(slash + 1).trim()
  if (!providerID || !modelID) return
  return { providerID, modelID }
}

async function openAuthLoginTerminal(context: vscode.ExtensionContext) {
  const repoRoot = getOpentrideRepoRootFromExtension(context) ?? getOpentrideRepoRootFromWorkspace()
  const opencodePkg = repoRoot ? vscode.Uri.joinPath(repoRoot, "packages", "opencode") : undefined
  const bunExe = findBunExecutable()
  const bunCmd = bunExe ? `"${toShellPath(bunExe)}"` : "bun"
  const bunOk = bunExe ? true : hasBunOnPath()
  const bunInvocation = bunExe && process.platform === "win32" ? `& ${bunCmd}` : bunCmd

  const doInstall = bunOk && needsWorkspaceInstall(repoRoot)
  const installCmd = doInstall ? `${bunInvocation} install; ` : ""

  const startCmd = opencodePkg && bunOk
    ? `${installCmd}${bunInvocation} run --cwd "${toShellPath(opencodePkg.fsPath)}" src/index.ts auth login`
    : opencodePkg && !bunOk
      ? `echo "bun not found. Please install bun, then run: bun run --cwd \"${toShellPath(opencodePkg.fsPath)}\" src/index.ts auth login"`
      : "opencode auth login"

  const bunBinDir = getUserBunBinDir()
  const mergedEnv: Record<string, string> = {
    OPENCODE_CALLER: "vscode",
    // Suppress baseline-browser-mapping staleness warnings for interactive flows.
    // See baseline-browser-mapping README: BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA / BROWSERSLIST_IGNORE_OLD_DATA.
    BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA: "true",
    BROWSERSLIST_IGNORE_OLD_DATA: "true",
  }
  if (bunBinDir) {
    const currentPath = process.env.PATH ?? process.env.Path ?? ""
    const nextPath = `${bunBinDir};${currentPath}`
    mergedEnv.PATH = nextPath
    mergedEnv.Path = nextPath
  }

  const terminal = getOrCreateTerminal(AUTH_TERMINAL_NAME, {
    location: vscode.TerminalLocation.Panel,
    cwd: repoRoot?.fsPath,
    env: mergedEnv,
  })
  terminal.show()
  terminal.sendText(startCmd)
}

async function openAuthLogoutTerminal(context: vscode.ExtensionContext) {
  const repoRoot = getOpentrideRepoRootFromExtension(context) ?? getOpentrideRepoRootFromWorkspace()
  const opencodePkg = repoRoot ? vscode.Uri.joinPath(repoRoot, "packages", "opencode") : undefined
  const bunExe = findBunExecutable()
  const bunCmd = bunExe ? `"${toShellPath(bunExe)}"` : "bun"
  const bunOk = bunExe ? true : hasBunOnPath()
  const bunInvocation = bunExe && process.platform === "win32" ? `& ${bunCmd}` : bunCmd

  const doInstall = bunOk && needsWorkspaceInstall(repoRoot)
  const installCmd = doInstall ? `${bunInvocation} install; ` : ""

  const startCmd =
    opencodePkg && bunOk
      ? `${installCmd}${bunInvocation} run --cwd "${toShellPath(opencodePkg.fsPath)}" src/index.ts auth logout`
      : opencodePkg && !bunOk
        ? `echo "bun not found. Please install bun, then run: bun run --cwd \"${toShellPath(opencodePkg.fsPath)}\" src/index.ts auth logout"`
        : "opencode auth logout"

  const bunBinDir = getUserBunBinDir()
  const mergedEnv: Record<string, string> = {
    OPENCODE_CALLER: "vscode",
    BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA: "true",
    BROWSERSLIST_IGNORE_OLD_DATA: "true",
  }
  if (bunBinDir) {
    const currentPath = process.env.PATH ?? process.env.Path ?? ""
    const nextPath = `${bunBinDir};${currentPath}`
    mergedEnv.PATH = nextPath
    mergedEnv.Path = nextPath
  }

  const terminal = getOrCreateTerminal(AUTH_LOGOUT_TERMINAL_NAME, {
    location: vscode.TerminalLocation.Panel,
    cwd: repoRoot?.fsPath,
    env: mergedEnv,
  })
  terminal.show()
  terminal.sendText(startCmd)
}

async function openModelsTerminal(context: vscode.ExtensionContext) {
  const repoRoot = getOpentrideRepoRootFromExtension(context) ?? getOpentrideRepoRootFromWorkspace()
  const opencodePkg = repoRoot ? vscode.Uri.joinPath(repoRoot, "packages", "opencode") : undefined
  const bunExe = findBunExecutable()
  const bunCmd = bunExe ? `"${toShellPath(bunExe)}"` : "bun"
  const bunOk = bunExe ? true : hasBunOnPath()
  const bunInvocation = bunExe && process.platform === "win32" ? `& ${bunCmd}` : bunCmd

  const doInstall = bunOk && needsWorkspaceInstall(repoRoot)
  const installCmd = doInstall ? `${bunInvocation} install; ` : ""

  const startCmd = opencodePkg && bunOk
    ? `${installCmd}${bunInvocation} run --cwd "${toShellPath(opencodePkg.fsPath)}" src/index.ts models --refresh`
    : opencodePkg && !bunOk
      ? `echo "bun not found. Please install bun, then run: bun run --cwd \"${toShellPath(opencodePkg.fsPath)}\" src/index.ts models --refresh"`
      : "opencode models"

  const bunBinDir = getUserBunBinDir()
  const mergedEnv: Record<string, string> = {
    OPENCODE_CALLER: "vscode",
    BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA: "true",
    BROWSERSLIST_IGNORE_OLD_DATA: "true",
  }
  if (bunBinDir) {
    const currentPath = process.env.PATH ?? process.env.Path ?? ""
    const nextPath = `${bunBinDir};${currentPath}`
    mergedEnv.PATH = nextPath
    mergedEnv.Path = nextPath
  }

  const terminal = getOrCreateTerminal(MODELS_TERMINAL_NAME, {
    location: vscode.TerminalLocation.Panel,
    cwd: repoRoot?.fsPath,
    env: mergedEnv,
  })
  terminal.show()
  terminal.sendText(startCmd)
}

async function abortCurrent(state: ChatRuntimeState) {
  if (state.acp?.sessionId && state.acp.connection) {
    try {
      await state.acp.connection.cancel({ sessionId: state.acp.sessionId } as any)
    } catch {
      // ignore
    }
    return
  }

  if (!state.sessionId) return
  const baseUrl = getEffectiveServerBaseUrl(state)
  const directory = getDirectoryQuery()
  const url = new URL(`/session/${encodeURIComponent(state.sessionId)}/abort`, baseUrl)
  if (directory) url.searchParams.set("directory", directory)
  try {
    await fetch(url, { method: "POST" })
  } catch {
    // ignore
  }
}

function parseSseEvent(raw: string): any | null {
  const lines = raw.split(/\r?\n/)
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const data = dataLines.join("\n")
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function handleEvent(
  post: (m: WebviewOutboundMessage) => void,
  state: ChatRuntimeState,
  evt: any,
  helpers?: {
    requestPermissionFromWebview?: (req: any) => Promise<string | undefined>
    requestQuestionFromWebview?: (req: any) => Promise<string[][] | undefined>
  }
) {
  // Server sends SSE events as { payload: { type, properties }, ... }.
  // Older/dev shapes may send { type, properties } directly.
  const payload = evt?.payload && typeof evt.payload === "object" ? evt.payload : evt
  const properties = payload?.properties
  const type = String(payload?.type ?? "")

  const endBusy = (status: "idle" | "error", detail?: string) => {
    if (!state.isBusy) return
    // Ensure any pending markdown stream is finalized.
    post({ type: "chatAssistantEnd" })
    post({ type: "chatSetStatus", status, detail })
    state.isBusy = false
    state.toolStateByCallId.clear()
    state.didEmitThinkingTranscriptForTurn = false

    // Commit the streamed assistant text to a minimal transcript snapshot.
    try {
      const text = typeof state.turnAssistantText === "string" ? state.turnAssistantText : ""
      if (text) {
        if (!state.transcript) state.transcript = []
        state.transcript.push({ kind: "chat", role: "assistant", text })
      }
      state.turnAssistantText = ""
    } catch {
      // ignore
    }

    // Copilot-like: append a checkpoint card at the end of a turn that produced workspace diffs.
    try {
      if (status === "idle") {
        const diffs = normalizeDiffs(state.lastSessionDiffs)
        if (diffs.length) {
          const key = computeCheckpointKey(state, diffs)
          if (key && key !== state.lastCheckpointKey) {
            state.lastCheckpointKey = key
            if (!state.checkpointsById) state.checkpointsById = new Map()
            if (!state.transcript) state.transcript = []

            const checkpointId = `cp:${Date.now()}:${Math.random().toString(16).slice(2)}`
            const transcriptIndex = Number.isFinite(state.turnStartTranscriptIndex as any)
              ? Math.max(0, state.turnStartTranscriptIndex as number)
              : state.transcript.length
            state.checkpointsById.set(checkpointId, {
              id: checkpointId,
              createdAtMs: Date.now(),
              transport: "http+sse",
              snapshotDiffs: diffs,
              transcriptIndex,
            })
            state.transcript.push({ kind: "checkpoint", checkpointId })
            post({ type: "chatCheckpoint", checkpointId })
          }
        }
      }
    } catch {
      // ignore
    }

    if (status === "idle") {
      // Best-effort: generate a one-line completion summary after the turn ends.
      void maybeGenerateAndPostTurnSummary(post, state)
    }
  }

  const ensureThinkingTranscriptStarted = () => {
    if (state.didEmitThinkingTranscriptForTurn) return
    state.didEmitThinkingTranscriptForTurn = true
    // IMPORTANT: do not leak model chain-of-thought.
    // We rely on chatSetStatus + tool/progress trace for the Copilot-like Working panel.
  }

  // Log only low-frequency event types.
  if (
    type === "server.connected" ||
    type === "server.heartbeat" ||
    type === "session.status" ||
    type === "session.idle" ||
    type === "session.error" ||
    type === "session.diff"
  ) {
    logLine(state, `evt: ${type}`)
  }

  if (type === "server.connected") {
    return
  }

  if (type === "session.status") {
    const sessionID = String(properties?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return
    const st = properties?.status
    const stType = String(st?.type ?? "")
    if (stType === "busy") {
      if (state.isBusy) post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
      return
    }
    if (stType === "idle") {
      endBusy("idle")
      return
    }
    if (stType === "retry") {
      // Don't create transcript/progress items unless a user prompt is in-flight.
      if (!state.isBusy) return
      const attempt = typeof st?.attempt === "number" ? st.attempt : undefined
      const message = String(st?.message ?? "")
      const nextMs = typeof st?.next === "number" ? st.next : undefined
      const text = `Retry${attempt != null ? ` #${attempt}` : ""}${message ? `: ${message}` : ""}${nextMs != null ? ` (next ${Math.round(nextMs / 1000)}s)` : ""}`
      post({ type: "chatProgress", text, status: "running" })
      return
    }
    return
  }

  if (type === "session.idle") {
    const sessionID = String(properties?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return
    endBusy("idle")
    return
  }

  if (type === "session.error") {
    const sessionID = String(properties?.sessionID ?? "")
    if (state.sessionId && sessionID && sessionID !== state.sessionId) return

    const err = properties?.error
    const errName = String(err?.name ?? "")
    const errMessage =
      typeof err?.data?.message === "string"
        ? err.data.message
        : typeof err?.message === "string"
          ? err.message
          : "发生错误"

    let detail = errMessage

    const isPatNotSupported =
      errName === "APIError" &&
      /Personal Access Tokens are not supported for this endpoint/i.test(errMessage)

    if (isPatNotSupported) {
      detail =
        "GitHub Copilot 不支持使用 PAT 调用该接口。请先执行 `opencode auth logout` 移除 github-copilot 的 PAT，然后用 OAuth 方式重新登录（`opencode auth login` 并选择 github-copilot 的 OAuth 方法），或切换到 openai/anthropic 等 provider。"

      const now = Date.now()
      const last = state.lastProviderAuthPrompt
      if (!last || now - last.at > 60_000) {
        state.lastProviderAuthPrompt = { providerID: "github-copilot", at: now }
        void vscode.window
          .showInformationMessage(
            "检测到 GitHub Copilot 使用了 PAT（该接口不支持）。",
            "打开注销终端（auth logout）",
            "打开登录终端（auth login）",
            "终端列出模型（opencode models）"
          )
          .then(async (choice) => {
            if (choice === "打开注销终端（auth logout）") {
              await vscode.commands.executeCommand("opencode.authLogoutInTerminal")
            } else if (choice === "打开登录终端（auth login）") {
              await vscode.commands.executeCommand("opencode.authLoginInTerminal")
            } else if (choice === "终端列出模型（opencode models）") {
              await vscode.commands.executeCommand("opencode.listModelsInTerminal")
            }
          })
      }
    } else if (errName === "ProviderAuthError") {
      const providerID = String(err?.data?.providerID ?? "").trim()
      detail = providerID ? `Provider 未登录：${providerID} - ${errMessage}` : `Provider 未登录：${errMessage}`

      // Best-effort: prompt the user to login, throttled.
      const now = Date.now()
      const last = state.lastProviderAuthPrompt
      if (!last || last.providerID !== providerID || now - last.at > 60_000) {
        state.lastProviderAuthPrompt = { providerID: providerID || "(unknown)", at: now }
        void vscode.window
          .showInformationMessage("当前模型所属 Provider 未登录。", "登录（opencode auth login）", "终端列出模型（opencode models）")
          .then(async (choice) => {
            if (choice === "登录（opencode auth login）") {
              await vscode.commands.executeCommand("opencode.authLoginInTerminal")
            } else if (choice === "终端列出模型（opencode models）") {
              await vscode.commands.executeCommand("opencode.listModelsInTerminal")
            }
          })
      }
    } else if (errName) {
      detail = `${errName}: ${errMessage}`
    }

    logLine(state, `session.error: ${detail}`)
    post({ type: "chatAppend", role: "assistant", text: `Error: ${detail}` })
    endBusy("error", detail)
    return
  }

  if (type === "message.updated") {
    const info = properties?.info
    const role = String(info?.role ?? "")
    const sessionID = String(info?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return
    if (role === "assistant") {
      state.assistantMessageId = String(info?.id ?? "").trim() || state.assistantMessageId
    }
    return
  }

  if (type === "message.part.updated") {
    const part = properties?.part
    const delta = properties?.delta
    const partType = String(part?.type ?? "")
    const sessionID = String(part?.sessionID ?? "")
    const messageID = String(part?.messageID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return

    if (partType === "text") {
      if (!state.assistantMessageId && messageID) state.assistantMessageId = messageID
      if (state.assistantMessageId && messageID && messageID !== state.assistantMessageId) return
      if (typeof delta === "string" && delta.length) {
        if (!state.didLogFirstAssistantDelta) {
          state.didLogFirstAssistantDelta = true
          logLine(state, "assistant streaming started")
        }
        ensureThinkingTranscriptStarted()
        try {
          state.turnAssistantText = String(state.turnAssistantText ?? "") + delta
        } catch {
          // ignore
        }
        post({ type: "chatAssistantDelta", delta })
      }
      return
    }

    if (partType === "tool") {
      const callId = String(part?.callID ?? "").trim()
      const toolState = part?.state
      const toolName = String(
        part?.tool ??
          part?.toolName ??
          part?.name ??
          toolState?.tool ??
          toolState?.toolName ??
          toolState?.name ??
          "tool"
      )
      const status = String(toolState?.status ?? "")
      if (!callId || !status) return

      const prev = state.toolStateByCallId.get(callId)
      if (prev === status) return
      state.toolStateByCallId.set(callId, status)

      if (status === "running") {
        const inputPreview = safeJsonPreview(toolState?.input)
        post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })
        post({ type: "chatToolInvocationBegin", invocationId: callId, toolName, inputPreview })
      } else if (status === "completed") {
        const time = toolState?.time
        const durationMs = typeof time?.start === "number" && typeof time?.end === "number" ? time.end - time.start : undefined
        const output = typeof toolState?.output === "string" ? toolState.output : ""
        post({ type: "chatToolInvocationEnd", invocationId: callId, ok: true, toolName, durationMs, outputPreview: truncate(output, 8000), outputFull: output })
        if (state.isBusy) post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })

        // Turn summary hints.
        recordTurnStep(state, formatToolStepForSummary(toolName, toolState?.input, true))
      } else if (status === "error") {
        const time = toolState?.time
        const durationMs = typeof time?.start === "number" && typeof time?.end === "number" ? time.end - time.start : undefined
        const error = typeof toolState?.error === "string" ? toolState.error : "Tool failed"
        post({ type: "chatToolInvocationEnd", invocationId: callId, ok: false, toolName, durationMs, outputPreview: error })
        post({ type: "chatSetStatus", status: "thinking", detail: "Thinking…" })

        // Turn summary hints.
        recordTurnStep(state, formatToolStepForSummary(toolName, toolState?.input, false))
      }
      return
    }

    if (partType === "patch") {
      // Record a best-effort anchor for Undo (revert) actions.
      if (messageID) state.lastEditMessageId = messageID
      return
    }

    if (partType === "reference" || partType === "ref" || partType === "references") {
      const items =
        partType === "references"
          ? ((Array.isArray(part?.items) ? part.items : null) || (Array.isArray(part?.references) ? part.references : null) || [])
          : [part]

      for (const r of items) {
        if (!r) continue
        const uri = String(r?.uri ?? r?.url ?? r?.href ?? r?.path ?? "").trim()
        if (!uri) continue
        if (state.seenReferenceUris.has(uri)) continue
        state.seenReferenceUris.add(uri)
        const title = typeof r?.title === "string" ? String(r.title).trim() : typeof r?.name === "string" ? String(r.name).trim() : ""
        post({ type: "chatReference", uri, title: title || undefined })
      }
      return
    }

    return
  }

  if (type === "session.diff") {
    const sessionID = String(properties?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return

    const prevDiffs = Array.isArray(state.lastSessionDiffs) ? state.lastSessionDiffs : []
    const diffs = Array.isArray(properties?.diff) ? properties.diff : []
    state.lastSessionDiffs = diffs

    // Use a stable requestId so UI updates in-place.
    const requestId = `session:${sessionID}`

    // Do not reset the whole processed set on incremental updates.
    // Only clear processed state for files whose diff content changed.
    try {
      const hashString = (input: string): number => {
        let h = 5381
        for (let i = 0; i < input.length; i++) h = ((h << 5) + h) ^ input.charCodeAt(i)
        return h >>> 0
      }
      const textSig = (text: string): string => {
        const s = String(text ?? "")
        const head = s.slice(0, 1024)
        const tail = s.length > 1024 ? s.slice(-1024) : ""
        return `${s.length}:${hashString(head + "\n" + tail)}`
      }
      const diffSig = (d: any): string => {
        const before = typeof d?.before === "string" ? d.before : ""
        const after = typeof d?.after === "string" ? d.after : ""
        return `${textSig(before)}>${textSig(after)}`
      }

      const prevByFile = new Map<string, string>()
      for (const d of Array.isArray(prevDiffs) ? prevDiffs : []) {
        const fk = canonicalizeFileKey(String(d?.file ?? "").trim())
        if (!fk) continue
        prevByFile.set(fk, diffSig(d))
      }

      let processed = state.editReviewProcessedFilesByRequestId.get(requestId)
      if (!processed) {
        processed = new Set()
        state.editReviewProcessedFilesByRequestId.set(requestId, processed)
      }

      // Normalize any legacy raw entries to canonical keys.
      try {
        const legacy = Array.from(processed)
        processed.clear()
        for (const k of legacy) {
          const fk = canonicalizeFileKey(k)
          if (fk) processed.add(fk)
        }
      } catch {
        // ignore
      }

      for (const d of Array.isArray(diffs) ? diffs : []) {
        const fk = canonicalizeFileKey(String(d?.file ?? "").trim())
        if (!fk) continue
        const old = prevByFile.get(fk)
        const sig = diffSig(d)
        if (!old || old !== sig) processed.delete(fk)
      }
    } catch {
      // ignore
    }

    // Keep legacy key tracking.
    try {
      const key = diffs
        .map((d: any) => String(d?.file ?? "").trim())
        .filter(Boolean)
        .join("\n")
      state.editReviewLastFilesKeyByRequestId.set(requestId, key)
    } catch {
      // ignore
    }

    const processed = state.editReviewProcessedFilesByRequestId.get(requestId) ?? new Set<string>()
    const remainingDiffs = diffs.filter((d: any) => {
      const fk = canonicalizeFileKey(String(d?.file ?? "").trim())
      if (!fk) return false
      return !processed.has(fk)
    })

    // Copilot-like: if there are no edits, do not surface a files-changed UI.
    if (!diffs.length || !remainingDiffs.length) {
      post({ type: "editReviewClear", requestId })
      return
    }

    const files = remainingDiffs
      .map((d: any) => {
        const relativePath = String(d?.file ?? "").trim()
        const additions = Number(d?.additions ?? 0)
        const deletions = Number(d?.deletions ?? 0)
        const editCount = Math.max(0, additions + deletions)
        return relativePath ? { relativePath, editCount, additions, deletions } : null
      })
      .filter(Boolean) as Array<{ relativePath: string; editCount: number; additions?: number; deletions?: number }>

    const diffStats = {
      filesChanged: files.length,
      totalFilesChanged: new Set(
        diffs
          .map((d: any) => String(d?.file ?? "").trim())
          .filter((f: string) => Boolean(f))
      ).size,
      additions: remainingDiffs.reduce((sum: number, d: any) => sum + Number(d?.additions ?? 0), 0),
      deletions: remainingDiffs.reduce((sum: number, d: any) => sum + Number(d?.deletions ?? 0), 0),
    }
    const summary = "Files changed"

    post({
      type: "editReviewRequest",
      requestId,
      summary,
      files,
      diffStats,
      canPreview: files.length > 0,
    })
    return
  }

  if (type === "permission.asked") {
    const req = properties
    const sessionID = String(req?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return

    const requestId = String(req?.id ?? "").trim()
    const permission = String(req?.permission ?? "").trim() || "permission"
    const patterns = Array.isArray(req?.patterns) ? req.patterns.map((p: any) => String(p)).filter(Boolean) : []
    const title = `Permission: ${permission}`
    const detail = patterns.length ? patterns.join("\n") : ""

    void (async () => {
      if (!requestId) return
      try {
        const optionId = await helpers?.requestPermissionFromWebview?.({
          toolCall: {
            toolCallId: requestId,
            title,
            rawInput: { permission, patterns },
          },
          options: [
            { optionId: "once", name: "Allow once" },
            { optionId: "always", name: "Allow always" },
            { optionId: "reject", name: "Reject" },
          ],
        })

        const reply = optionId === "always" ? "always" : optionId === "reject" ? "reject" : optionId === "once" ? "once" : "reject"
        await replyPermission(state, requestId, reply)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        post({ type: "chatAppend", role: "tool", text: `Permission reply failed: ${message}` })
      }
    })()
    return
  }

  if (type === "question.asked") {
    const req = properties
    const sessionID = String(req?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return

    const requestId = String(req?.id ?? "").trim()
    if (!requestId) return
    if (state.questionPromptedRequestIds.has(requestId)) return
    state.questionPromptedRequestIds.add(requestId)

    const callId = String(req?.tool?.callID ?? "").trim() || requestId
    state.questionCallIdByRequestId.set(requestId, callId)

    void (async () => {
      try {
        const maybeEndQuestionTool = (ok: boolean, outputPreview: string) => {
          try {
            const invocationId = state.questionCallIdByRequestId.get(requestId) || callId
            if (!invocationId) return
            const prev = state.toolStateByCallId.get(invocationId)
            if (prev === "completed" || prev === "error") return
            state.toolStateByCallId.set(invocationId, ok ? "completed" : "error")
            post({
              type: "chatToolInvocationEnd",
              invocationId,
              ok,
              toolName: "question",
              outputPreview,
            })
            if (state.isBusy) post({ type: "chatSetStatus", status: "thinking" })
          } catch {
            // ignore
          }
        }

        const answers = await helpers?.requestQuestionFromWebview?.({ id: requestId, questions: req?.questions })
        if (!answers) {
          try {
            await rejectQuestion(state, requestId)
            maybeEndQuestionTool(false, "User rejected/cancelled input")
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            maybeEndQuestionTool(false, `Reject failed: ${message}`)
            throw err
          }
          return
        }

        try {
          await replyQuestion(state, requestId, answers)
          maybeEndQuestionTool(true, "Input received")
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          maybeEndQuestionTool(false, `Reply failed: ${message}`)
          throw err
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        post({ type: "chatAppend", role: "tool", text: `Question reply failed: ${message}` })
      }
    })()

    return
  }

  if (type === "question.replied") {
    const sessionID = String(evt?.properties?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return
    const requestID = String(evt?.properties?.requestID ?? "").trim()
    if (!requestID) return
    const callId = state.questionCallIdByRequestId.get(requestID)
    if (!callId) return
    const prev = state.toolStateByCallId.get(callId)
    if (prev === "completed" || prev === "error") return
    state.toolStateByCallId.set(callId, "completed")
    post({ type: "chatToolInvocationEnd", invocationId: callId, ok: true })
    if (state.isBusy) post({ type: "chatSetStatus", status: "thinking" })
    return
  }

  if (type === "question.rejected") {
    const sessionID = String(evt?.properties?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return
    const requestID = String(evt?.properties?.requestID ?? "").trim()
    if (!requestID) return
    const callId = state.questionCallIdByRequestId.get(requestID)
    if (!callId) return
    const prev = state.toolStateByCallId.get(callId)
    if (prev === "completed" || prev === "error") return
    state.toolStateByCallId.set(callId, "error")
    post({ type: "chatToolInvocationEnd", invocationId: callId, ok: false, outputPreview: "User rejected question" })
    post({ type: "chatSetStatus", status: "thinking" })
    return
  }

  if (type === "session.idle") {
    const sessionID = String(evt?.properties?.sessionID ?? "")
    if (state.sessionId && sessionID !== state.sessionId) return
    post({ type: "chatAssistantEnd" })
    post({ type: "chatSetStatus", status: "idle" })
    state.isBusy = false
    return
  }
}

async function getLatestSessionDiffs(state: ChatRuntimeState): Promise<any[]> {
  if (Array.isArray(state.lastSessionDiffs) && state.lastSessionDiffs.length) return state.lastSessionDiffs
  if (!state.sessionId) return []
  const diffs = await fetchSessionDiff(state, state.sessionId)
  state.lastSessionDiffs = diffs
  return diffs
}

async function fetchSessionDiff(state: ChatRuntimeState, sessionId: string): Promise<any[]> {
  const baseUrl = getEffectiveServerBaseUrl(state)
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/diff`, baseUrl)
  const res = await fetch(url)
  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`session.diff failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
  }
  const json = (await res.json()) as any
  return Array.isArray(json) ? json : []
}

async function openDiffForFile(diff: any, directory: string): Promise<void> {
  const file = String(diff?.file ?? "").trim()
  const before = typeof diff?.before === "string" ? diff.before : ""
  const after = typeof diff?.after === "string" ? diff.after : ""

  const left = await vscode.workspace.openTextDocument({ content: before })

  const rightUri = file ? resolveProjectFileUri(file, directory) : undefined
  if (rightUri) {
    await vscode.commands.executeCommand("vscode.diff", left.uri, rightUri, file ? `Diff: ${file}` : "Diff")
    return
  }

  const right = await vscode.workspace.openTextDocument({ content: after })
  await vscode.commands.executeCommand("vscode.diff", left.uri, right.uri, file ? `Diff: ${file}` : "Diff")
}

async function revertMessage(state: ChatRuntimeState, sessionId: string, messageId: string): Promise<void> {
  const baseUrl = getEffectiveServerBaseUrl(state)
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/revert`, baseUrl)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messageID: messageId }),
  })
  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`session.revert failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
  }
}

function resolveProjectFileUri(
  relativePath: string,
  directory: string,
  opts?: {
    mustExist?: boolean
  }
): vscode.Uri | undefined {
  const rel = String(relativePath ?? "").replaceAll("\\", "/").replace(/^\/+/, "").trim()
  if (!rel) return

  const mustExist = opts?.mustExist === false ? false : true

  const bases: string[] = []
  const dir = String(directory ?? "").trim()
  if (dir) bases.push(dir)
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    bases.push(f.uri.fsPath)
  }

  for (const base of bases) {
    const fsPath = path.join(base, ...rel.split("/"))
    try {
      if (!mustExist) return vscode.Uri.file(fsPath)
      if (fs.existsSync(fsPath)) return vscode.Uri.file(fsPath)
    } catch {
      // ignore
    }
  }
  return
}

async function replyPermission(state: ChatRuntimeState, requestId: string, reply: "once" | "always" | "reject") {
  const baseUrl = getEffectiveServerBaseUrl(state)
  const directory = getDirectoryQuery()
  const url = new URL(`/permission/${encodeURIComponent(requestId)}/reply`, baseUrl)
  if (directory) url.searchParams.set("directory", directory)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reply }),
  })
  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`permission.reply failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
  }
}

async function replyQuestion(state: ChatRuntimeState, requestId: string, answers: string[][]) {
  const baseUrl = getEffectiveServerBaseUrl(state)
  const directory = getDirectoryQuery()
  const url = new URL(`/question/${encodeURIComponent(requestId)}/reply`, baseUrl)
  if (directory) url.searchParams.set("directory", directory)
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ answers }),
  })
  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`question.reply failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
  }
}

async function rejectQuestion(state: ChatRuntimeState, requestId: string) {
  const baseUrl = getEffectiveServerBaseUrl(state)
  const directory = getDirectoryQuery()
  const url = new URL(`/question/${encodeURIComponent(requestId)}/reject`, baseUrl)
  if (directory) url.searchParams.set("directory", directory)
  const res = await fetch(url, { method: "POST" })
  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`question.reject failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`)
  }
}

async function openTerminal(context: vscode.ExtensionContext) {
  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: vscode.TerminalLocation.Panel,
    env: {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_CALLER: "vscode",
    },
  })

  terminal.show()
  terminal.sendText(`opencode --port ${port}`)

  const fileRef = getActiveFile()
  if (!fileRef) return

  let tries = 10
  let connected = false
  do {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      await fetch(`http://localhost:${port}/app`)
      connected = true
      break
    } catch {
      // ignore
    }
    tries--
  } while (tries > 0)

  if (connected) {
    await appendPrompt(port, `In ${fileRef}`)
    terminal.show()
  }
}

function discoverOpencodeServerBaseUrlFromTerminal(): string | undefined {
  const terminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
  if (!terminal) return
  // @ts-ignore
  const portRaw = terminal.creationOptions?.env?.["_EXTENSION_OPENCODE_PORT"]
  const port = typeof portRaw === "string" ? parseInt(portRaw, 10) : typeof portRaw === "number" ? portRaw : NaN
  if (!Number.isFinite(port) || port <= 0) return
  return `http://127.0.0.1:${port}`
}

async function offerStartServer(
  context: vscode.ExtensionContext,
  state: ChatRuntimeState,
  post: (m: WebviewOutboundMessage) => void,
  errorMessage: string
) {
  // Only prompt on common network failures.
  const msg = String(errorMessage || "")
  const looksLikeNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|Failed to fetch|network/i.test(msg)
  if (!looksLikeNetwork) return

  const choice = await vscode.window.showWarningMessage(
    `opencode server 连接失败：${msg}`,
    "Start opencode (terminal)",
    "Use existing terminal",
    "Open Settings"
  )

  if (choice === "Open Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "opencode.serverBaseUrl")
    return
  }

  if (choice === "Use existing terminal") {
    const discovered = discoverOpencodeServerBaseUrlFromTerminal()
    if (discovered) {
      state.baseUrlOverride = discovered
      post({ type: "chatSetStatus", status: "idle", detail: `Using ${discovered}` })
    } else {
      void vscode.window.showInformationMessage("未发现名为 'opencode' 的终端或端口环境变量。")
    }
    return
  }

  if (choice === "Start opencode (terminal)") {
    // Start server in a new terminal and point chat at it.
    const preferredPort = getPreferredLocalPort(getEffectiveServerBaseUrl(state))
    const port = await openTerminalAndReturnPort(context, preferredPort)
    const baseUrl = `http://127.0.0.1:${port}`
    await waitForServerReady(baseUrl, 15000)
    state.baseUrlOverride = baseUrl
    await context.globalState.update(LAST_SERVER_BASE_URL_KEY, baseUrl)
    post({ type: "chatSetStatus", status: "idle", detail: `Started ${state.baseUrlOverride}` })

    // Force reconnect SSE.
    try {
      state.sseAbort?.abort()
    } catch {
      // ignore
    }
    state.sseAbort = undefined
    return
  }
}

async function openTerminalAndReturnPort(context: vscode.ExtensionContext, preferredPort?: number): Promise<number> {
  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
  if (existing) {
    const existingBase = discoverOpencodeServerBaseUrlFromTerminal()
    if (existingBase) {
      try {
        const u = new URL(existingBase)
        const p = Number(u.port)
        if (Number.isFinite(p) && p > 0) {
          existing.show()
          return p
        }
      } catch {
        // ignore
      }
    }
  }

  const repoRoot = getOpentrideRepoRootFromExtension(context) ?? getOpentrideRepoRootFromWorkspace()
  const opencodePkg = repoRoot ? vscode.Uri.joinPath(repoRoot, "packages", "opencode") : undefined

  const bunExe = findBunExecutable()
  const bunCmd = bunExe ? `"${toShellPath(bunExe)}"` : "bun"
  const bunOk = bunExe ? true : hasBunOnPath()
  const bunInvocation = bunExe && process.platform === "win32" ? `& ${bunCmd}` : bunCmd

  const port = typeof preferredPort === "number" && Number.isFinite(preferredPort) && preferredPort > 0
    ? preferredPort
    : Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384

  const doInstall = bunOk && needsWorkspaceInstall(repoRoot)
  const installCmd = doInstall ? `${bunInvocation} install; ` : ""

  const startCmd = opencodePkg && bunOk
    ? `${installCmd}${bunInvocation} run --cwd "${toShellPath(opencodePkg.fsPath)}" src/index.ts serve --port ${port} --hostname 127.0.0.1`
    : opencodePkg && !bunOk
      ? `echo "bun not found. Please install bun, then run: bun run --cwd \"${toShellPath(opencodePkg.fsPath)}\" src/index.ts serve --port ${port} --hostname 127.0.0.1"`
      : `opencode serve --port ${port} --hostname 127.0.0.1`

  const bunBinDir = getUserBunBinDir()
  const mergedEnv: Record<string, string> = {
    _EXTENSION_OPENCODE_PORT: port.toString(),
    OPENCODE_CALLER: "vscode",
    BASELINE_BROWSER_MAPPING_IGNORE_OLD_DATA: "true",
    BROWSERSLIST_IGNORE_OLD_DATA: "true",
  }
  if (bunBinDir) {
    const currentPath = process.env.PATH ?? process.env.Path ?? ""
    const nextPath = `${bunBinDir};${currentPath}`
    mergedEnv.PATH = nextPath
    mergedEnv.Path = nextPath
  }

  const terminal = getOrCreateTerminal(TERMINAL_NAME, {
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: vscode.TerminalLocation.Panel,
    cwd: repoRoot?.fsPath,
    env: mergedEnv,
  })

  terminal.show()
  terminal.sendText(startCmd)
  return port
}

function getOrCreateTerminal(name: string, options: vscode.TerminalOptions): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === name)
  if (existing) return existing
  return vscode.window.createTerminal({ name, ...options })
}

function getPreferredLocalPort(baseUrl: string): number | undefined {
  try {
    const u = new URL(baseUrl)
    const host = u.hostname
    if (host !== "127.0.0.1" && host !== "localhost") return undefined
    const p = Number(u.port)
    return Number.isFinite(p) && p > 0 ? p : undefined
  } catch {
    return undefined
  }
}

async function waitForServerReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      // Prefer the documented health endpoint.
      const res = await fetch(new URL("/health", baseUrl))
      if (res.ok) return
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  // Not fatal: SSE reconnect will still try and show error if it fails.
}

function getOpentrideRepoRootFromExtension(context: vscode.ExtensionContext): vscode.Uri | undefined {
  // In dev, context.extensionUri is typically .../Opentride/sdks/vscode (or a proposed-dev copy under .vscode).
  // Derive the real repo root by walking upward until we find a directory that looks like the Opentride repo.
  // This avoids incorrect roots like .../Opentride/sdks which break `--cwd packages/opencode`.
  const startPath = context.extensionUri.fsPath
  let cur = startPath
  for (let i = 0; i < 8; i++) {
    try {
      const pkgJson = path.join(cur, "package.json")
      const opencodeDir = path.join(cur, "packages", "opencode")
      if (fs.existsSync(pkgJson) && fs.existsSync(opencodeDir)) {
        return vscode.Uri.file(cur)
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(cur)
    if (!parent || parent === cur) break
    cur = parent
  }
  return undefined
}

function getOpentrideRepoRootFromWorkspace(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders ?? []
  const named = folders.find((f) => f.name === "Opentride")
  if (named) return named.uri
  return folders.find((f) => f.uri.fsPath.toLowerCase().endsWith("\\opentride") || f.uri.fsPath.toLowerCase().endsWith("/opentride"))?.uri
}

function toShellPath(p: string): string {
  // Keep backslashes for PowerShell/CMD and quote at call-site.
  return p
}

function getUserBunBinDir(): string | undefined {
  const user = process.env.USERPROFILE
  if (!user) return
  return path.join(user, ".bun", "bin")
}

function findBunExecutable(): string | undefined {
  const userBin = getUserBunBinDir()
  if (!userBin) return
  const exe = path.join(userBin, "bun.exe")
  return fs.existsSync(exe) ? exe : undefined
}

function hasBunOnPath(): boolean {
  try {
    const r = childProcess.spawnSync("bun", ["--version"], { encoding: "utf-8" })
    return !r.error && (typeof r.status !== "number" || r.status === 0)
  } catch {
    return false
  }
}

function needsWorkspaceInstall(repoRoot: vscode.Uri | undefined): boolean {
  if (!repoRoot) return true
  // Bun may not create a node_modules entry for every workspace package on Windows.
  // Use bun's install artifacts as the signal instead.
  const lockPath = path.join(repoRoot.fsPath, "bun.lock")
  const nodeModulesPath = path.join(repoRoot.fsPath, "node_modules")
  const bunMetaPath = path.join(nodeModulesPath, ".bun")
  return !fs.existsSync(lockPath) || !fs.existsSync(nodeModulesPath) || !fs.existsSync(bunMetaPath)
}


async function appendPrompt(port: number, text: string) {
  await fetch(`http://localhost:${port}/tui/append-prompt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  })
}

function getActiveFile() {
  const activeEditor = vscode.window.activeTextEditor
  if (!activeEditor) return

  const document = activeEditor.document
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (!workspaceFolder) return

  const relativePath = vscode.workspace.asRelativePath(document.uri)
  let filepathWithAt = `@${relativePath}`

  const selection = activeEditor.selection
  if (!selection.isEmpty) {
    const startLine = selection.start.line + 1
    const endLine = selection.end.line + 1
    filepathWithAt += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`
  }

  return filepathWithAt
}

function truncate(s: string, max: number): string {
  const text = String(s ?? "")
  if (text.length <= max) return text
  return text.slice(0, max) + "…"
}

function safeJsonPreview(value: any): string | undefined {
  if (value == null) return undefined
  try {
    const s = JSON.stringify(value, null, 2)
    return truncate(s, 2000)
  } catch {
    return undefined
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return String(t ?? "").trim()
  } catch {
    return ""
  }
}

async function fetchWithTimeout(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))

  const parentSignal = init.signal
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort()
    else parentSignal.addEventListener("abort", () => controller.abort(), { once: true })
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function getNonce() {
  let text = ""
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}
