import { isConnection, recovery } from "./connection"
import type { Connection } from "./connection"
import { isRunSnapshot } from "./runs"
import type { Run } from "./runs"

export type Selection = Connection & { runId: string }
export type Field = { state: string; text?: string; truncated?: boolean }
export type Detail = { run: Run; logs: Field; inputs: Field; result: Field; steps: Field }
export type InspectionResponse = Selection & { ok: true; detail: Detail }
function withinCharacterLimit(text: string, limit: number) {
  let count = 0
  for (const character of text) {
    if (++count > limit || character.length === 1 && /[\uD800-\uDFFF]/.test(character)) return false
  }
  return true
}
export function isSelection(value: unknown): value is Selection {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return Object.keys(item).sort().join(",") === "instance,runId,workspace" &&
    isConnection({ instance: item.instance, workspace: item.workspace }) && typeof item.runId === "string" &&
    /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(item.runId)
}
export function isInspectionResponse(value: unknown): value is InspectionResponse {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join(",") !== "detail,instance,ok,runId,workspace" || item.ok !== true ||
    !isSelection({ instance: item.instance, workspace: item.workspace, runId: item.runId }) || !item.detail || typeof item.detail !== "object") return false
  const detail = item.detail as Record<string, unknown>
  if (Object.keys(detail).sort().join(",") !== "inputs,logs,result,run,steps" ||
    !isRunSnapshot({ runs: [detail.run], snapshotAt: new Date().toISOString() }) || (detail.run as Run).id !== item.runId) return false
  return ["logs", "inputs", "result", "steps"].every(key => {
    const field = detail[key] as Record<string, unknown> | null
    if (!field || typeof field !== "object") return false
    if (field.state === "available") return Object.keys(field).sort().join(",") === "state,text,truncated" &&
      typeof field.text === "string" && withinCharacterLimit(field.text, key === "logs" ? 64000 : 32000) && typeof field.truncated === "boolean"
    return Object.keys(field).join(",") === "state" && typeof field.state === "string" &&
      (field.state === "unavailable" || Object.hasOwn(recovery, field.state))
  })
}
export function runUrl(selection: Selection) {
  return `${selection.instance}/run/${encodeURIComponent(selection.runId)}?workspace=${encodeURIComponent(selection.workspace)}`
}

export function sameSelection(left: Selection, right: Selection) {
  return left.instance === right.instance && left.workspace === right.workspace && left.runId === right.runId
}
export function isPinsResponse(value: unknown): value is { ok: true; connection: Connection; pins: Selection[] } {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return Object.keys(item).sort().join(",") === "connection,ok,pins" && item.ok === true && isConnection(item.connection) &&
    Array.isArray(item.pins) && item.pins.length <= 1000 && item.pins.every(pin => isSelection(pin) &&
      pin.instance === (item.connection as Connection).instance && pin.workspace === (item.connection as Connection).workspace)
}

export type FollowResponse = InspectionResponse & { offsets: { start: number; end: number } }
export function isFollowResponse(value: unknown): value is FollowResponse {
  if (!value || typeof value !== "object") return false
  const { offsets, ...inspection } = value as Record<string, unknown>
  if (!isInspectionResponse(inspection) || !offsets || typeof offsets !== "object") return false
  const span = offsets as Record<string, unknown>
  return Object.keys(span).sort().join(",") === "end,start" && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
    (span.start as number) >= 0 && (span.end as number) >= (span.start as number) &&
    (inspection.detail.logs.state !== "available" || Array.from(inspection.detail.logs.text!).length === (span.end as number) - (span.start as number))
}
