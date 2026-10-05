import { isConnection } from "./connection"
import type { Connection, LiveSnapshot } from "./connection"
import type { RunStatus } from "./runs"

export const MONITOR_ALARM = "run-radar:recent"
export const POLL_MINUTES = 1
export const RECORD_LIMIT = 1000
export type MonitorRecord = { id: string; startedAt: string; status: RunStatus; seen: boolean }
export type Monitoring = Connection & {
  cursor: string
  snapshotAt: string
  lastSuccess: number
  gap: boolean
  error: string | null
  records: MonitorRecord[]
}
const timestamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
export function isMonitoring(value: unknown): value is Monitoring {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const state = value as Monitoring
  if (Object.keys(state).sort().join(",") !== "cursor,error,gap,instance,lastSuccess,records,snapshotAt,workspace" ||
    !isConnection({ instance: state.instance, workspace: state.workspace }) || !timestamp(state.cursor) || !timestamp(state.snapshotAt) ||
    !Number.isFinite(state.lastSuccess) || state.lastSuccess < 0 || typeof state.gap !== "boolean" ||
    state.error !== null && (typeof state.error !== "string" || state.error.length > 64) || !Array.isArray(state.records) || state.records.length > RECORD_LIMIT) return false
  const ids = new Set<string>()
  return state.records.every(record => {
    if (!record || Object.keys(record).sort().join(",") !== "id,seen,startedAt,status" || !/^[a-z0-9-]{1,64}$/.test(record.id) || ids.has(record.id) ||
      !timestamp(record.startedAt) || typeof record.seen !== "boolean" || !["failed", "success", "running", "queued", "canceled", "skipped"].includes(record.status)) return false
    ids.add(record.id)
    return true
  })
}
const active = (status: RunStatus) => status === "running" || status === "queued"
export function refreshMonitoring(previous: Monitoring | null, snapshot: LiveSnapshot, now: number): Monitoring {
  const scoped = previous && previous.instance === snapshot.instance && previous.workspace === snapshot.workspace ? previous : null
  // An error before the first successful sample must not establish a history baseline.
  const old = scoped && scoped.lastSuccess > 0 ? scoped : null
  if (old && snapshot.snapshotAt < old.snapshotAt) return old
  const cursor = snapshot.runs.reduce((value, run) => run.startedAt > value ? run.startedAt : value, old?.cursor ?? (snapshot.runs.length ? "1970-01-01T00:00:00.000Z" : snapshot.snapshotAt))
  const records = new Map(old?.records.map(record => [record.id, { ...record }]))
  let gap = (scoped?.gap ?? false) || snapshot.runs.length === 100
  if (old && (now - old.lastSuccess > POLL_MINUTES * 120000 ||
    snapshot.runs.length === 100 && !snapshot.runs.some(run => records.has(run.id)))) gap = true
  for (const run of snapshot.runs) {
    const known = records.get(run.id)
    if (known) {
      // A terminal response cannot regress to an earlier queue observation.
      if (active(known.status)) known.status = run.status
    } else {
      const historical = !old || run.startedAt < old.cursor
      if (old && historical) gap = true
      records.set(run.id, { id: run.id, startedAt: run.startedAt, status: run.status, seen: historical && !active(run.status) })
    }
  }
  const ordered = [...records.values()].sort((a, b) => {
    const priority = (record: MonitorRecord) => record.status === "failed" && !record.seen ? 2 : active(record.status) ? 1 : 0
    return priority(b) - priority(a) || b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)
  })
  if (ordered.length > RECORD_LIMIT) gap = true
  return { instance: snapshot.instance, workspace: snapshot.workspace, cursor, snapshotAt: snapshot.snapshotAt,
    lastSuccess: Math.max(old?.lastSuccess ?? 0, now), gap, error: null, records: ordered.slice(0, RECORD_LIMIT) }
}
export function monitorDisplay(state: Monitoring | null, now = Date.now()) {
  if (!state) return { text: "", color: "#667085", title: "ChroMill: monitoring stopped" }
  const count = state.records.filter(record => record.status === "failed" && !record.seen).length
  const stale = now - state.lastSuccess > POLL_MINUTES * 120000
  if (state.error === "credentials_locked") return { text: "LOCK", color: "#805300", title: `ChroMill: ${count} unseen failures. Credentials locked. Unlock in Connection settings to resume monitoring.` }
  const auth = state.error === "authentication_expired" || state.error === "access_denied"
  const warning = state.error ? auth ? "Authentication error" : "Monitoring stale" : stale ? "Monitoring stale" : state.gap ? "Sampling gap" : "Polling every minute"
  return { text: state.error ? auth ? "ERR" : "ST" : stale ? "ST" : state.gap ? "GAP" : count ? count > 99 ? "99+" : String(count) : "",
    color: state.error || stale || state.gap ? "#805300" : "#b42318",
    title: `ChroMill: ${count} unseen failures. ${warning}. Recent 100 runs only; coverage is sampled.` }
}
