import { isFollowResponse } from "./inspection"
import type { FollowResponse } from "./inspection"
import { isInspectionResponse } from "./inspection"
import type { InspectionResponse } from "./inspection"
import { isRunSnapshot } from "./runs"
import { isComparisonResponse } from "./comparison"
import type { ComparisonResponse } from "./comparison"
import type { Run } from "./runs"

export const HOST = "app.run_radar.windmill"
export const recovery: Record<string, string> = {
  credentials_locked: "Credentials are locked. Open Connection settings and unlock to resume monitoring.",
  credentials_invalid: "Enter an HTTPS origin, an API key, and a password with 12 to 1024 characters. HTTP is allowed only for loopback.",
  credentials_conflict: "Saved credentials changed. Reload settings before saving or replacing them.",
  unlock_failed: "The password is incorrect or the encrypted record is damaged. Try again or remove and reenter credentials.",
  storage_failure: "Chrome could not save or read connection data. Reload settings and try again.",
  permission_denied: "Instance access was not granted. Save credentials again and allow access to the entered origin.",
  scope_limit: "Monitoring retains 20 other workspaces. Disconnect to clear saved scopes before adding another workspace.",
  deleted: "This run was deleted or is unavailable. Select another run.",
  forbidden: "Access to this run is forbidden. Review workspace permissions.",
  helper_missing: "The local helper is unavailable. Install it for this extension ID, then try again.",
  fifo_missing: "The 1Password mount is missing. Mount the selected Environment at the registered path, then try again.",
  fifo_permissions: "The mount must be a user-owned 0600 FIFO. Restore the 1Password mount, then try again.",
  fifo_locked_or_stalled: "1Password is locked or the FIFO writer is stalled. Unlock 1Password, approve access, then try again.",
  variables_missing: "The host Environment needs WMILL_URL and WMILL_API_KEY. Add them in 1Password, then try again.",
  variables_invalid: "The host variables are invalid. Use an instance origin and a valid API key in 1Password.",
  https_required: "The configured remote instance needs HTTPS. Update WMILL_URL in 1Password.",
  authentication_expired: "Authentication expired. Replace the API key in Connection settings or the host Environment, then try again.",
  access_denied: "Workspace access is denied. Select an accessible workspace or update the key permissions.",
  network_failure: "The instance is unreachable. Restore the network and instance, then try again.",
  network_timeout: "The instance timed out. Restore the network and instance, then try again.",
  server_error: "The instance returned an error. Restore the instance, then try again.",
  redirect_rejected: "The instance redirected the request. Configure its direct origin in Connection settings or the host Environment.",
  response_invalid: "The helper returned unsupported data. Review server compatibility, then try again.",
  response_too_large: "The instance response is too large. Review server compatibility, then try again.",
  credential_echo: "The instance echoed a credential. Review the instance before retrying.",
  request_invalid: "This connection request is invalid. Reload the extension and try again.",
  request_canceled: "The request was canceled. Connect or refresh again.",
  helper_failure: "The helper failed. Review its installation, then try again."
}
export type Connection = { instance: string; workspace: string }
export type LiveSnapshot = Connection & { ok: true; mode: "live"; snapshotAt: string; runs: Run[] }
export type RunnableKind = "script" | "flow"
export const runnableKind = (value: unknown): value is RunnableKind => value === "script" || value === "flow"
export type Flow = { path: string; summary: string; kind: RunnableKind }
export type FlowPage = Connection & { ok: true; flows: Flow[]; page: number; hasMore: boolean }
export type HistoryPage = LiveSnapshot & { page: number; flowPath: string | null; flowKind: RunnableKind | null; hasMore: boolean }
export const pageNumber = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10000
export const flowPath = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\x00-\x1f,]/.test(value) && !value.startsWith("!")
export const historyTarget = (path: unknown, kind: unknown): boolean => path === null ? kind === null : flowPath(path) && runnableKind(kind)
export type NativeResponse = FlowPage | HistoryPage | ComparisonResponse | FollowResponse | InspectionResponse | LiveSnapshot | { ok: true; instance: string; helper: "installed" } |
  { ok: true; instance: string; workspaces: string[] } | { ok: false; code: string }
export const workspaceId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
export function publicOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2000) return false
  try {
    const url = new URL(value)
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  } catch { return false }
}
export function isConnection(value: unknown): value is Connection {
  if (!value || typeof value !== "object") return false
  const connection = value as Record<string, unknown>
  return Object.keys(connection).length === 2 && publicOrigin(connection.instance) && workspaceId(connection.workspace)
}
export function isNativeResponse(value: unknown): value is NativeResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const response = value as Record<string, unknown>
  const keys = Object.keys(response).sort().join(",")
  if (response.ok === false) return keys === "code,ok" && typeof response.code === "string" && Object.hasOwn(recovery, response.code)
  if (isInspectionResponse(value) || isFollowResponse(value) || isComparisonResponse(value)) return true
  if (response.ok !== true || !publicOrigin(response.instance)) return false
  if (keys === "helper,instance,ok") return response.helper === "installed"
  if (keys === "instance,ok,workspaces") return Array.isArray(response.workspaces) && response.workspaces.length <= 1000 && response.workspaces.every(workspaceId)
  if (keys === "flows,hasMore,instance,ok,page,workspace") return workspaceId(response.workspace) && pageNumber(response.page) &&
    typeof response.hasMore === "boolean" && Array.isArray(response.flows) && response.flows.length <= 200 &&
    ["script", "flow"].every(kind => (response.flows as Flow[]).filter(row => row?.kind === kind).length <= 100) &&
    new Set(response.flows.map(row => `${row?.kind}:${row?.path}`)).size === response.flows.length && response.flows.every(row => row &&
      Object.keys(row).sort().join(",") === "kind,path,summary" && runnableKind(row.kind) && flowPath(row.path) && typeof row.summary === "string" && row.summary.length <= 1000 && !/[\x00-\x1f]/.test(row.summary))
  if (keys === "flowKind,flowPath,hasMore,instance,mode,ok,page,runs,snapshotAt,workspace") return response.mode === "live" && workspaceId(response.workspace) &&
    pageNumber(response.page) && typeof response.hasMore === "boolean" && historyTarget(response.flowPath, response.flowKind) &&
    isRunSnapshot(response, false, response.page === 1 ? 1000 : 100) && (response.flowPath === null || (response.runs as Run[]).every(run => run.path === response.flowPath && run.jobKind === response.flowKind))
  return keys === "instance,mode,ok,runs,snapshotAt,workspace" && response.mode === "live" && workspaceId(response.workspace) && isRunSnapshot(response)
}
export async function connectionRequest(message: Record<string, unknown>): Promise<unknown> {
  try { return await chrome.runtime.sendMessage(message) }
  catch { return { ok: false, code: "helper_failure" } }
}
export function failureText(value: unknown): string {
  return isNativeResponse(value) && !value.ok ? recovery[value.code] : recovery.response_invalid
}
