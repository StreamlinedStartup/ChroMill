import { CredentialError } from "./credentials"
import type { Credentials } from "./credentials"
import { isNativeResponse, workspaceId, pageNumber, flowPath, historyTarget } from "./connection"
import type { NativeResponse } from "./connection"
import type { Detail, Field } from "./inspection"
import type { Run } from "./runs"
import { isTimestamp, validTimezone } from "./timezones"

type Job = Record<string, unknown>
const fail = (code = "response_invalid"): never => { throw new CredentialError(code) }
const object = (value: unknown): Job => value && typeof value === "object" && !Array.isArray(value) ? value as Job : fail()
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(value)
function text(value: unknown, limit: number): string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\x00-\x1f]/.test(value) ? value : fail()
}
// JSON.parse source context preserves original HTTP numeric tokens for private fields.
class JsonNumber { constructor(public raw: string) {} }
function parse(source: string): unknown {
  return JSON.parse(source, (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value !== "number") return value
    if (!context?.source) return fail()
    return new JsonNumber(context.source)
  })
}
function number(value: unknown): number {
  const result = value instanceof JsonNumber ? Number(value.raw) : value
  return typeof result === "number" && Number.isFinite(result) && result >= 0 ? result : fail()
}
function json(value: unknown, depth = 0): string {
  if (depth > 100) return fail()
  if (typeof value === "string" && /[\uD800-\uDFFF]/u.test(value)) return fail()
  if (value instanceof JsonNumber) return value.raw
  if (Array.isArray(value)) return "[" + value.map(item => json(item, depth + 1)).join(", ") + "]"
  if (value && typeof value === "object") return "{" + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ": " + json(item, depth + 1)).join(", ") + "}"
  return JSON.stringify(value)
}
function containsCredential(value: unknown, token: string): boolean {
  if (typeof value === "string") return value.includes(token)
  if (Array.isArray(value)) return value.some(item => containsCredential(item, token))
  if (value && typeof value === "object" && !(value instanceof JsonNumber)) {
    return Object.entries(value).some(([key, item]) => key.includes(token) || containsCredential(item, token))
  }
  return false
}
function field(value: unknown, present: boolean): Field {
  if (!present) return { state: "unavailable" }
  const characters = Array.from(json(value))
  return { state: "available", text: characters.slice(0, 32000).join(""), truncated: characters.length > 32000 }
}
function stamp(value: unknown, precise = false): string {
  if (!isTimestamp(value)) return fail()
  const normalized = new Date(value).toISOString()
  if (!precise) return normalized
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? ""
  return normalized.slice(0, 19) + "." + fraction.padEnd(6, "0") + "Z"
}
function schedulePath(job: Job): string | null {
  const path = job.schedule_path || (job.trigger_kind === "schedule" ? job.trigger : null)
  return typeof path === "string" && path.length <= 300 && /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) &&
    !path.split("/").some(part => [".", ".."].includes(part)) ? path : null
}
function normalize(rows: unknown, workspace: string, now: number, limit = 100): Run[] {
  if (!Array.isArray(rows) || rows.length > 1000) return fail()
  const ids = new Set<string>(), runs: Run[] = []
  for (const value of rows) {
    const job = object(value)
    if (job.workspace_id !== workspace) return fail()
    if (job.parent_job || job.is_flow_step === true) continue
    if (!uuid(job.id) || ids.has(job.id) || job.is_flow_step !== false || typeof job.canceled !== "boolean") return fail()
    ids.add(job.id)
    let status: Run["status"]
    if (job.type === "QueuedJob" && typeof job.running === "boolean") status = job.canceled ? "canceled" : job.running ? "running" : "queued"
    else if (job.type === "CompletedJob" && typeof job.success === "boolean") status = job.canceled ? "canceled" : job.is_skipped === true ? "skipped" : job.success ? "success" : "failed"
    else return fail()
    const startedAt = stamp(job.started_at || job.created_at)
    if (Date.parse(startedAt) > now) return fail()
    const path = text(job.script_path || job.job_kind, 300)
    const jobKind = job.job_kind === undefined ? undefined : text(job.job_kind, 50)
    runs.push({ jobKind, id: job.id, name: path.split("/").at(-1)!, path, status, startedAt,
      durationMs: job.type === "CompletedJob" ? number(job.duration_ms) : status === "running" ? Math.max(0, now - Date.parse(startedAt)) : 0,
      trigger: text(job.trigger_kind || (job.schedule_path ? "schedule" : "Unknown"), 50) })
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
}

export async function directRequest(credentials: Credentials, message: Record<string, unknown>, signal: AbortSignal,
  permissions: Pick<typeof chrome.permissions, "contains">, fetcher: typeof fetch = fetch): Promise<NativeResponse> {
  const { instance, apiKey } = credentials
  const inspect = ["inspect", "follow", "compare"].includes(String(message.op))
  const base = "/api/w/" + message.workspace
  try {
    if (["flows", "history"].includes(String(message.op)) && (!workspaceId(message.workspace) || !pageNumber(message.page) ||
      Object.keys(message).sort().join(",") !== (message.op === "flows" ? "instance,op,page,workspace" : "flowKind,flowPath,instance,op,page,workspace") ||
      message.op === "history" && !historyTarget(message.flowPath, message.flowKind))) return fail("request_invalid")
    if (message.instance !== undefined && message.instance !== instance) return fail("request_invalid")
    if (!await permissions.contains({ origins: [instance + "/*"] })) return fail("permission_denied")
    async function get(path: string, plain = false, inspection = inspect, requestSignal = signal): Promise<unknown> {
      if (signal.aborted) return fail("request_canceled")
      const response = await fetcher(instance + path, { method: "GET", headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
        redirect: "manual", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: requestSignal })
      if (response.type === "opaqueredirect" || response.redirected || response.status >= 300 && response.status < 400) return fail("redirect_rejected")
      if (response.status === 401) return fail("authentication_expired")
      if ([403, 404].includes(response.status)) return fail(inspection ? response.status === 403 ? "forbidden" : "deleted" : "access_denied")
      if (response.status !== 200) return fail("server_error")
      if (!response.body) return fail()
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 512 * 1024) return fail("response_too_large")
          chunks.push(value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let position = 0
      for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length }
      let source: string
      try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { return fail() }
      if (source.includes(apiKey)) return fail("credential_echo")
      const value = plain ? source : parse(source)
      if (!plain && containsCredential(value, apiKey)) return fail("credential_echo")
      return value
    }
    async function zones(jobs: Job[], exact: boolean): Promise<Map<string, string>> {
      const paths = new Set(jobs.map(schedulePath).filter((path): path is string => !!path)), result = new Map<string, string>()
      if (!paths.size) return result
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(2000)])
      function accept(value: unknown) {
        const row = object(value)
        if (row.workspace_id !== undefined && row.workspace_id !== message.workspace) return fail()
        const path = text(row.path, 300)
        if (paths.has(path) && validTimezone(row.timezone)) result.set(path, row.timezone)
        return path
      }
      try {
        if (exact) {
          for (const path of paths) {
            const row = object(await get(base + "/schedules/get/" + path.split("/").map(encodeURIComponent).join("/"), false, true, deadline))
            if (row.path !== path) return fail()
            accept(row)
          }
        } else {
          const seen = new Set<string>()
          for (let page = 0; page < 10; page++) {
            const rows = await get(base + `/schedules/list?per_page=100&page=${page}`, false, false, deadline)
            if (!Array.isArray(rows) || rows.length > 100) return fail()
            for (const row of rows) { const path = accept(row); if (seen.has(path)) return fail(); seen.add(path) }
            if (rows.length < 100 || [...paths].every(path => seen.has(path))) break
          }
        }
      } catch {
        // Optional current schedule metadata cannot establish historical timezone.
        // Its absence is represented by the existing extension preference.
        if (signal.aborted) return fail("request_canceled")
      }
      return result
    }
    async function job(id: string): Promise<Job> {
      const row = object(await get(base + "/jobs_u/get/" + id))
      if (row.id !== id || row.workspace_id !== message.workspace) return fail()
      return row
    }
    async function detail(row: Job): Promise<{ detail: Detail; offsets: { start: number; end: number } }> {
      const runs = normalize([row], message.workspace as string, Date.now())
      if (runs.length !== 1) return fail()
      const run = runs[0], zone = (await zones([row], true)).get(schedulePath(row) ?? "")
      if (zone) run.timezone = zone
      let logs: Field, offsets = { start: Number(message.offset ?? 0), end: Number(message.offset ?? 0) }
      try {
        const source = await get(base + "/jobs_u/" + (row.job_kind === "flow" ? "get_flow_all_logs/" : "get_logs/") + row.id, true)
        if (typeof source !== "string") return fail()
        const characters = Array.from(source)
        offsets = { start: Math.max(0, characters.length - 64000), end: characters.length }
        logs = { state: "available", text: characters.slice(-64000).join(""), truncated: characters.length > 64000 }
      } catch (error) {
        if (signal.aborted) return fail("request_canceled")
        logs = { state: error instanceof CredentialError ? error.code : "network_failure" }
      }
      return { detail: { run, logs, inputs: field(row.args, Object.hasOwn(row, "args")), result: field(row.result, Object.hasOwn(row, "result")),
        steps: field(row.flow_status, row.flow_status !== undefined && row.flow_status !== null) }, offsets }
    }
    const identity = { ok: true as const, instance, workspace: message.workspace as string, runId: message.runId as string }
    async function compare(): Promise<unknown> {
      const response = { ...identity, state: "missing_metadata", searched: 0 }
      const selected = await job(identity.runId), kind = selected.job_kind
      if (!["script", "flow"].includes(String(kind)) || selected.parent_job || selected.is_flow_step !== false) return { ...response, state: "incompatible_type" }
      if (!selected.script_path || !selected.started_at || selected.type !== "CompletedJob") return response
      const path = text(selected.script_path, 300), before = stamp(selected.started_at, true)
      if (path.includes(",") || path.startsWith("!")) return { ...response, state: "unsupported_path" }
      const eligible = (row: Job) => row.script_path === path && row.job_kind === kind && !row.parent_job && row.is_flow_step === false &&
        row.type === "CompletedJob" && row.success === true && row.canceled === false && row.is_skipped === false
      const seen = new Set<string>(), candidates: { time: string; id: string }[] = []
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ per_page: "100", page: String(page), order_desc: "true", script_path_exact: path,
          success: "true", is_skipped: "false", has_null_parent: "true", is_flow_step: "false", job_kinds: String(kind), started_before: selected.started_at as string })
        const rows = await get(base + "/jobs/completed/list?" + query)
        if (!Array.isArray(rows) || rows.length > 100) return fail()
        response.searched += rows.length
        for (const value of rows) {
          const row = object(value)
          if (row.workspace_id !== message.workspace || !uuid(row.id) || !eligible(row)) return fail()
          if (seen.has(row.id)) return { ...response, state: "search_limit" }
          seen.add(row.id)
          if (!row.started_at) return response
          const time = stamp(row.started_at, true)
          if (time < before && row.id !== identity.runId) candidates.push({ time, id: row.id })
        }
        if (rows.length < 100) break
        if (page === 4) return { ...response, state: "search_limit" }
      }
      candidates.sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id))
      if (!candidates.length) return { ...response, state: "no_baseline" }
      const candidate = candidates[0]
      let baseline: Job
      try { baseline = await job(candidate.id) } catch (error) {
        if (error instanceof CredentialError && ["forbidden", "deleted"].includes(error.code)) return { ...response, state: "baseline_" + error.code }
        throw error
      }
      if (!eligible(baseline) || stamp(baseline.started_at, true) !== candidate.time) return fail()
      async function snapshot(row: Job) {
        let version: Field = { state: "unavailable" }
        if (row.script_hash !== undefined && row.script_hash !== null) {
          if (typeof row.script_hash !== "string" || !/^[0-9a-fA-F]{1,32}$/.test(row.script_hash)) return fail()
          version = { state: "available", text: row.script_hash, truncated: false }
        }
        const snapshot = (await detail(row)).detail
        snapshot.run.startedAt = stamp(row.started_at, true)
        if (row.result === "WINDMILL_TOO_BIG") snapshot.result = { state: "response_too_large" }
        return { detail: snapshot, version }
      }
      if (selected.duration_ms === undefined || baseline.duration_ms === undefined) return response
      return { ...response, state: "available", kind, selected: await snapshot(selected), baseline: await snapshot(baseline) }
    }
    let response: unknown
    if (message.op === "status") response = { ok: true, instance, helper: "installed" }
    else if (message.op === "workspaces") {
      const rows = await get("/api/workspaces/list", false, false)
      if (!Array.isArray(rows) || rows.length > 1000) return fail()
      const workspaces = rows.map(value => { const id = object(value).id; return workspaceId(id) ? id : fail() })
      response = { ok: true, instance, workspaces }
    } else if (message.op === "flows") {
      const flows: import("./connection").Flow[] = []
      let hasMore = false
      for (const kind of ["flow", "script"] as const) {
        const query = new URLSearchParams({ per_page: "100", page: String(message.page), order_desc: kind === "script" ? "true" : "false", show_archived: "false" })
        if (kind === "script") query.set("include_without_main", "true")
        const rows = await get(base + `/${kind}s/list?` + query, false, false)
        if (!Array.isArray(rows) || rows.length > 100) return fail()
        hasMore ||= rows.length === 100
        const seen = new Set<string>()
        for (const value of rows) {
          const row = object(value)
          if (row.workspace_id !== undefined && row.workspace_id !== message.workspace || !flowPath(row.path) || row.archived !== undefined && row.archived !== false) return fail()
          const summary = row.summary ?? ""
          if (typeof summary !== "string" || summary.length > 1000 || /[\x00-\x1f]/.test(summary)) return fail()
          if (seen.has(row.path)) { if (kind === "flow") return fail(); continue }
          seen.add(row.path)
          flows.push({ path: row.path, summary, kind })
        }
      }
      response = { ok: true, instance, workspace: message.workspace, flows, page: message.page, hasMore }
    } else if (message.op === "history") {
      const query = new URLSearchParams({ per_page: "100", page: String(message.page), order_desc: "true", has_null_parent: "true", is_flow_step: "false" })
      if (message.flowPath !== null) { query.set("script_path_exact", message.flowPath as string); query.set("job_kinds", message.flowKind as string) }
      const rows = await get(base + (message.page === 1 ? "/jobs/list?" : "/jobs/completed/list?") + query, false, false)
      if (!Array.isArray(rows) || rows.length > (message.page === 1 ? 1000 : 100)) return fail()
      for (const value of rows) {
        const row = object(value)
        if (row.parent_job || row.is_flow_step !== false || message.page !== 1 && row.type !== "CompletedJob" ||
          message.flowPath !== null && (row.script_path !== message.flowPath || row.job_kind !== message.flowKind)) return fail()
      }
      const completedCount = rows.filter(value => object(value).type === "CompletedJob").length
      if (completedCount > 100) return fail()
      const now = Date.now(), runs = normalize(rows, message.workspace as string, now, 1000)
      const timezones = await zones(rows.map(object), false)
      for (const run of runs) { const zone = timezones.get(schedulePath(object(rows.find(row => object(row).id === run.id))) ?? ""); if (zone) run.timezone = zone }
      response = { ok: true, instance, workspace: message.workspace, mode: "live", snapshotAt: new Date(now).toISOString(),
        runs, page: message.page, flowPath: message.flowPath, flowKind: message.flowKind, hasMore: completedCount === 100 }
    } else if (message.op === "recent") {
      const rows = await get(base + "/jobs/list?per_page=100&has_null_parent=true&is_flow_step=false", false, false)
      const now = Date.now(), runs = normalize(rows, message.workspace as string, now)
      const timezones = await zones((rows as unknown[]).map(object), false)
      for (const run of runs) { const zone = timezones.get(schedulePath(object((rows as Job[]).find(row => row.id === run.id))) ?? ""); if (zone) run.timezone = zone }
      response = { ok: true, instance, workspace: message.workspace, mode: "live", snapshotAt: new Date(now).toISOString(), runs }
    } else if (message.op === "compare") response = await compare()
    else if (message.op === "inspect" || message.op === "follow") {
      const snapshot = await detail(await job(identity.runId))
      response = { ...identity, detail: snapshot.detail, ...(message.op === "follow" ? { offsets: snapshot.offsets } : {}) }
    } else return fail("request_invalid")
    if (signal.aborted) return fail("request_canceled")
    if (new TextEncoder().encode(JSON.stringify(response)).length > 1024 * 1024) return fail("response_too_large")
    return isNativeResponse(response) ? response : fail()
  } catch (error) {
    return { ok: false, code: signal.aborted ? "request_canceled" : error instanceof CredentialError ? error.code :
      error instanceof SyntaxError ? "response_invalid" : "network_failure" }
  }
}
