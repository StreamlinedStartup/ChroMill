import { isTimestamp } from "./timezones"
export type RunStatus = "failed" | "running" | "success" | "queued" | "canceled" | "skipped"
export type RunFilter = "all" | "failed" | "running"
export type Run = {
  id: string
  name: string
  path: string
  status: RunStatus
  durationMs: number
  trigger: string
  startedAt: string
  timezone?: string
  jobKind?: string
}
export const kindLabel = (kind: string | undefined): string => kind === "script" ? "Script" : kind === "flow" ? "Flow" : kind === undefined ? "Unknown" : "Other"
export type DemoResponse =
  | { ok: true; mode: "demo"; snapshotAt: string; runs: Run[] }
  | { ok: false; error: string }

export function filterRuns(runs: Run[], filter: RunFilter, search: string): Run[] {
  const query = search.trim().toLowerCase()
  return runs.filter(run => (filter === "all" || run.status === filter) &&
    [run.name, run.path, run.id].some(value => value.toLowerCase().includes(query)))
}

export function isDemoResponse(value: unknown): value is DemoResponse {
  if (!value || typeof value !== "object") return false
  const response = value as Record<string, unknown>
  if (response.ok === false) return typeof response.error === "string" && response.error.length > 0 && response.error.length <= 200
  if (response.ok !== true || response.mode !== "demo" || !isTimestamp(response.snapshotAt) ||
    !Array.isArray(response.runs) || response.runs.length > 100) return false
  return isRunSnapshot(response, true)
}

export function isRunSnapshot(response: Record<string, unknown>, demo = false, limit = 100): boolean {
  if (!isTimestamp(response.snapshotAt) || !Array.isArray(response.runs) || response.runs.length > limit) return false
  const ids = new Set<string>()
  return response.runs.every(value => {
    if (!value || typeof value !== "object") return false
    const run = value as Record<string, unknown>
    if (typeof run.id !== "string" || !/^[a-z0-9-]{1,64}$/.test(run.id) || ids.has(run.id)) return false
    ids.add(run.id)
    return typeof run.name === "string" && run.name.length > 0 && run.name.length <= 200 &&
      (run.jobKind === undefined || typeof run.jobKind === "string" && run.jobKind.length > 0 && run.jobKind.length <= 50 && !/[\x00-\x1f]/.test(run.jobKind)) &&
      typeof run.path === "string" && run.path.length > 0 && run.path.length <= 300 &&
      (demo ? ["failed", "running", "success"] : ["failed", "running", "success", "queued", "canceled", "skipped"]).includes(String(run.status)) &&
      typeof run.durationMs === "number" && Number.isFinite(run.durationMs) && run.durationMs >= 0 &&
      (demo ? ["Schedule", "Webhook", "Manual"].includes(String(run.trigger)) : typeof run.trigger === "string" && run.trigger.length > 0 && run.trigger.length <= 50) && isTimestamp(run.startedAt) &&
      // Host and browser timezone databases can differ. Formatting resolves unknown names to the preference.
      (run.timezone === undefined || typeof run.timezone === "string" && run.timezone.length <= 100) && Date.parse(run.startedAt) <= Date.parse(response.snapshotAt as string)
  })
}

export async function requestDemoRuns(): Promise<Extract<DemoResponse, { ok: true }>> {
  let response: unknown
  try {
    response = await chrome.runtime.sendMessage({ type: "demo:list" })
  } catch {
    throw new Error("The demo service worker is unavailable. Reload the extension and try again.")
  }
  if (!isDemoResponse(response)) throw new Error("The demo service worker returned an invalid response.")
  if (!response.ok) throw new Error(response.error)
  return response
}
