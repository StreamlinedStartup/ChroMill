import { isInspectionResponse, isSelection } from "./inspection"
import type { Detail, Field, Selection } from "./inspection"

export const comparisonStates: Record<string, string> = {
  no_baseline: "No earlier success was returned in the accessible retained history.",
  search_limit: "Search limit reached. Up to 500 history rows were searched. The latest earlier success is unproven.",
  missing_metadata: "Comparison is unavailable because required execution metadata is missing or the run is not completed.",
  incompatible_type: "Comparison supports only top-level script and flow executions.",
  unsupported_path: "This path cannot be represented safely by the Windmill history filter.",
  baseline_forbidden: "The earlier success is forbidden. Review workspace permissions.",
  baseline_deleted: "The earlier success was deleted or is unavailable."
}
type Snapshot = { detail: Detail; version: Field }
function preciseTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value) ?
    value.replace(/\.(\d+)Z$/, (_, fraction: string) => "." + fraction.padEnd(6, "0") + "Z") : ""
}
export type ComparisonResponse = Selection & { ok: true; state: string; searched: number; kind?: "script" | "flow"; selected?: Snapshot; baseline?: Snapshot }
export function isComparisonResponse(value: unknown): value is ComparisonResponse {
  if (!value || typeof value !== "object") return false
  const item = value as ComparisonResponse
  const identity = { instance: item.instance, workspace: item.workspace, runId: item.runId }
  if (item.ok !== true || !Number.isInteger(item.searched) || item.searched < 0 || item.searched > 500) return false
  if (item.state !== "available") {
    return Object.hasOwn(comparisonStates, item.state) && Object.keys(item).sort().join(",") === "instance,ok,runId,searched,state,workspace" &&
      isSelection(identity)
  }
  if (Object.keys(item).sort().join(",") !== "baseline,instance,kind,ok,runId,searched,selected,state,workspace" ||
    !["script", "flow"].includes(item.kind ?? "")) return false
  function snapshot(value: Snapshot | undefined, runId: string) {
    const startedAt = value?.detail?.run?.startedAt
    if (!value || typeof startedAt !== "string" || !preciseTime(startedAt) || Object.keys(value).sort().join(",") !== "detail,version") return false
    // Reuse millisecond inspection validation without discarding comparison precision.
    const detail = { ...value.detail, run: { ...value.detail.run, startedAt: startedAt.replace(/(\.\d{3})\d{0,3}Z$/, "$1Z") } }
    if (!isInspectionResponse({ ...identity, runId, ok: true, detail })) return false
    const field = value.version
    return field && (field.state === "unavailable" ? Object.keys(field).join(",") === "state" :
      Object.keys(field).sort().join(",") === "state,text,truncated" && field.state === "available" &&
      typeof field.text === "string" && /^[0-9a-fA-F]{1,32}$/.test(field.text) && field.truncated === false)
  }
  return snapshot(item.selected, item.runId) && snapshot(item.baseline, item.baseline?.detail?.run?.id ?? "") &&
    item.baseline!.detail.run.id !== item.runId && item.baseline!.detail.run.status === "success" &&
    item.baseline!.detail.run.path === item.selected!.detail.run.path &&
    !!preciseTime(item.baseline!.detail.run.startedAt) && !!preciseTime(item.selected!.detail.run.startedAt) &&
    preciseTime(item.baseline!.detail.run.startedAt) < preciseTime(item.selected!.detail.run.startedAt)
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + canonical(object[key])).join(",") + "}"
  }
  return JSON.stringify(value)
}
function decimalIdentity(token: string): string {
  const [coefficient, exponent = "0"] = token.toLowerCase().split("e")
  const digits = coefficient.replace(/[-.]/g, "").replace(/^0+/, "")
  if (!digits) return "0"
  const significant = digits.replace(/0+$/, "")
  const scale = Number(exponent) - (coefficient.split(".")[1]?.length ?? 0) + digits.length - significant.length
  return (coefficient.startsWith("-") ? "-" : "") + significant + "e" + scale
}
export function difference(previous: Field, selected: Field, json = false): string {
  if (previous.state !== "available" || selected.state !== "available") return "Unavailable metadata. Equality is unproven."
  if (previous.truncated || selected.truncated) return "Large value. Equality is unproven because content is truncated."
  if (!json) return previous.text === selected.text ? "Same" : "Changed"
  try {
    // Skip quoted strings. Inspect numeric tokens before JSON.parse can round them.
    for (const text of [previous.text!, selected.text!]) {
      const tokens = text.match(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? []
      for (const token of tokens) {
        if (token.startsWith('"')) continue
        const value = Number(token)
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          decimalIdentity(token) !== decimalIdentity(String(value))) {
          return "Unsupported JSON numeric precision. Equality is unproven."
        }
      }
    }
    const before: unknown = JSON.parse(previous.text!)
    const after: unknown = JSON.parse(selected.text!)
    if (canonical(before) === canonical(after)) return "Same"
    if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      const left = before as Record<string, unknown>, right = after as Record<string, unknown>
      return Object.keys({ ...left, ...right }).sort().filter(key => !Object.hasOwn(left, key) || !Object.hasOwn(right, key) || canonical(left[key]) !== canonical(right[key]))
        .map(key => (Object.hasOwn(left, key) ? Object.hasOwn(right, key) ? "Changed: " : "Removed: " : "Added: ") + key).join("\n")
    }
    return "Changed"
  } catch { return "Unsupported JSON metadata. Equality is unproven." }
}
