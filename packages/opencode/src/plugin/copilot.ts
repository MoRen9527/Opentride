import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { iife } from "@/util/iife"

const DEFAULT_CLIENT_ID = "Ov23li8tweQw6odWQebz"
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds

function getClientId(): string {
  return (process.env.OPENCODE_COPILOT_CLIENT_ID || DEFAULT_CLIENT_ID).trim() || DEFAULT_CLIENT_ID
}
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client
  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }
        }

        const enterpriseUrl = info.enterpriseUrl
        const baseURL = enterpriseUrl
          ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}`
          : "https://api.githubcopilot.com"

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const { isVision, isAgent } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body

                // Completions API
                if (body?.messages) {
                  const last = body.messages[body.messages.length - 1]
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }

                // Responses API
                if (body?.input) {
                  const last = body.input[body.input.length - 1]
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    isAgent: last?.role !== "user",
                  }
                }
              } catch {}
              return { isVision: false, isAgent: false }
            })

            const headers: Record<string, string> = {
              "x-initiator": isAgent ? "agent" : "user",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `opencode/${Installation.VERSION}`,
              Authorization: `Bearer ${info.refresh}`,
              "Openai-Intent": "conversation-edits",
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            return fetch(request, {
              ...init,
              headers,
            })
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"
            let actualProvider = "github-copilot"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
              actualProvider = "github-copilot-enterprise"
            }

            const urls = getUrls(domain)

            const clientId = getClientId()

            const isTransientNetworkError = (e: unknown): boolean => {
              const anyErr = e as any
              const code = String(anyErr?.code ?? "").toUpperCase()
              if (
                code === "ECONNRESET" ||
                code === "ETIMEDOUT" ||
                code === "ECONNABORTED" ||
                code === "ENOTFOUND" ||
                code === "EAI_AGAIN" ||
                code === "ECONNREFUSED" ||
                code === "EHOSTUNREACH" ||
                code === "ENETUNREACH"
              )
                return true
              const msg = String(anyErr?.message ?? e ?? "").toLowerCase()
              return (
                msg.includes("socket connection was closed") ||
                msg.includes("connection reset") ||
                msg.includes("econnreset") ||
                msg.includes("network") ||
                // Bun on Windows may throw: "Unable to connect. Is the computer able to access the url?"
                msg.includes("unable to connect") ||
                msg.includes("access the url") ||
                msg.includes("timed out")
              )
            }

            const shouldRetryResponse = (res: Response): boolean => {
              const s = Number(res.status)
              return s === 429 || s >= 500
            }

            const sleepMsForAttempt = (attempt: number, baseMs: number): number => {
              const backoff = Math.min(30_000, Math.max(0, attempt - 1) * 1000)
              return baseMs + OAUTH_POLLING_SAFETY_MARGIN_MS + backoff
            }

            const deviceBody = new URLSearchParams({
              client_id: clientId,
              scope: "read:user",
            }).toString()

            let deviceResponse: Response | undefined
            for (let attempt = 1; attempt <= 10; attempt++) {
              try {
                const res = await fetch(urls.DEVICE_CODE_URL, {
                  method: "POST",
                  headers: {
                    Accept: "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": `opencode/${Installation.VERSION}`,
                  },
                  body: deviceBody,
                })

                if (!res.ok && shouldRetryResponse(res)) {
                  await Bun.sleep(sleepMsForAttempt(attempt, 1500))
                  continue
                }

                deviceResponse = res
                break
              } catch (e) {
                if (isTransientNetworkError(e)) {
                  await Bun.sleep(sleepMsForAttempt(attempt, 1500))
                  continue
                }
                throw e
              }
            }

            if (!deviceResponse) {
              throw new Error("Failed to initiate GitHub device authorization: network error")
            }

            if (!deviceResponse.ok) {
              const text = await deviceResponse.text().catch(() => "")
              throw new Error(
                `Failed to initiate GitHub device authorization: ${deviceResponse.status} ${deviceResponse.statusText}${text ? ` - ${text}` : ""}`,
              )
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
              expires_in?: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                const startedAtMs = Date.now()
                const expiresInSec = Number(deviceData.expires_in ?? 0)
                const expiresAtMs = expiresInSec > 0 ? startedAtMs + expiresInSec * 1000 : undefined

                let transientFailures = 0
                const baseIntervalMs = Math.max(1, Number(deviceData.interval ?? 5)) * 1000

                const sleepMsForRetry = () => {
                  transientFailures = Math.min(10, transientFailures + 1)
                  const backoff = Math.min(30_000, (transientFailures - 1) * 1000)
                  return baseIntervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS + backoff
                }

                const isTransientNetworkError = (e: unknown): boolean => {
                  const anyErr = e as any
                  const code = String(anyErr?.code ?? "").toUpperCase()
                  if (
                    code === "ECONNRESET" ||
                    code === "ETIMEDOUT" ||
                    code === "ECONNABORTED" ||
                    code === "ENOTFOUND" ||
                    code === "EAI_AGAIN" ||
                    code === "ECONNREFUSED" ||
                    code === "EHOSTUNREACH" ||
                    code === "ENETUNREACH"
                  )
                    return true
                  const msg = String(anyErr?.message ?? e ?? "").toLowerCase()
                  return (
                    msg.includes("socket connection was closed") ||
                    msg.includes("connection reset") ||
                    msg.includes("econnreset") ||
                    msg.includes("network") ||
                    msg.includes("unable to connect") ||
                    msg.includes("access the url") ||
                    msg.includes("timed out")
                  )
                }

                while (true) {
                  if (expiresAtMs && Date.now() > expiresAtMs) return { type: "failed" as const }

                  const tokenBody = new URLSearchParams({
                    client_id: clientId,
                    device_code: deviceData.device_code,
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                  }).toString()
                  let response: Response
                  try {
                    response = await fetch(urls.ACCESS_TOKEN_URL, {
                      method: "POST",
                      headers: {
                        Accept: "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": `opencode/${Installation.VERSION}`,
                      },
                      body: tokenBody,
                    })
                  } catch (e) {
                    if (isTransientNetworkError(e)) {
                      await Bun.sleep(sleepMsForRetry())
                      continue
                    }
                    throw e
                  }

                  // Treat transient upstream failures as retryable.
                  if (!response.ok) {
                    if (response.status === 429 || response.status >= 500) {
                      await Bun.sleep(sleepMsForRetry())
                      continue
                    }
                    return { type: "failed" as const }
                  }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    interval?: number
                  }

                  if (data.access_token) {
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                    }

                    if (actualProvider === "github-copilot-enterprise") {
                      result.provider = "github-copilot-enterprise"
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    transientFailures = 0
                    await Bun.sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    transientFailures = 0
                    // Based on the RFC spec, we must add 5 seconds to our current polling interval.
                    // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
                    let newInterval = (deviceData.interval + 5) * 1000

                    // GitHub OAuth API may return the new interval in seconds in the response.
                    // We should try to use that if provided with safety margin.
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }

                    await Bun.sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error) return { type: "failed" as const }

                  transientFailures = 0
                  await Bun.sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "Paste GitHub token (fallback)",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              condition: (inputs) => inputs.deploymentType === "enterprise",
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"
            let actualProvider = "github-copilot"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
              actualProvider = "github-copilot-enterprise"
            }

            return {
              url: "https://github.com/settings/tokens",
              instructions:
                "Paste a GitHub user access token here. Tip: if you have GitHub CLI, you can run `gh auth token` to get one.",
              method: "code" as const,
              async callback(token: string) {
                const t = String(token || "").trim()
                if (!t) return { type: "failed" as const }

                const result: {
                  type: "success"
                  refresh: string
                  access: string
                  expires: number
                  provider?: string
                  enterpriseUrl?: string
                } = {
                  type: "success",
                  refresh: t,
                  access: t,
                  expires: 0,
                }

                if (actualProvider === "github-copilot-enterprise") {
                  result.provider = "github-copilot-enterprise"
                  result.enterpriseUrl = domain
                }

                return result
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (!input.model.providerID.includes("github-copilot")) return
      const session = await sdk.session
        .get({
          path: {
            id: input.sessionID,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
    },
  }
}
