// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { directRequest } from "../../src/direct-transport"
import { difference } from "../../src/comparison"
const credentials = { instance: "https://fixture.example", apiKey: "synthetic-test-token" }
const id = "00000000-0000-0000-0000-000000000001", earlierId = "00000000-0000-0000-0000-000000000002"
export const completed = { id, workspace_id: "fixture", type: "CompletedJob", is_flow_step: false, canceled: false, success: false,
  is_skipped: false, started_at: "2026-10-03T18:30:00.000002Z", script_path: "u/test/task", job_kind: "script", duration_ms: 10, script_hash: "abc", args: {}, result: {} }
function fixture(routes: Record<string, unknown>) {
  const fetcher = vi.fn(async (url: string, _init: RequestInit) => {
    void _init
    const path = new URL(url).pathname
    if (!Object.hasOwn(routes, path)) throw new Error("Unexpected fixture endpoint")
    const value = routes[path]
    return value instanceof Response ? value : new Response(typeof value === "string" ? value : JSON.stringify(value))
  })
  const permissions = { contains: vi.fn(async () => true) }
  const request = (message: Record<string, unknown>, signal = new AbortController().signal) => directRequest(credentials, message, signal, permissions, fetcher as unknown as typeof fetch)
  return { request, permissions, fetcher }
}
describe("direct read-only transport", () => {
  it("restricts origin, grants, redirects, and authorization and returns sanitized errors", async () => {
    const context = fixture({ "/api/workspaces/list": [{ id: "fixture" }] })
    expect(await context.request({ op: "workspaces" })).toMatchObject({ workspaces: ["fixture"] })
    expect(context.fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" })
    expect(context.fetcher.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer " + credentials.apiKey, Accept: "application/json" })
    expect(await context.request({ op: "workspaces", instance: "https://evil.example" })).toEqual({ ok: false, code: "request_invalid" })
    context.permissions.contains.mockResolvedValue(false)
    expect(await context.request({ op: "workspaces" })).toEqual({ ok: false, code: "permission_denied" })
    expect(context.fetcher).toHaveBeenCalledTimes(1)
    for (const [status, code] of [[302, "redirect_rejected"], [401, "authentication_expired"], [403, "access_denied"], [500, "server_error"]] as const) {
      const denied = fixture({ "/api/workspaces/list": new Response("private diagnostics", { status }) })
      expect(await denied.request({ op: "workspaces" })).toEqual({ ok: false, code })
    }
    const opaque = fixture({ "/api/workspaces/list": new Response() })
    Object.defineProperty((await opaque.fetcher("https://fixture.example/api/workspaces/list", {})), "type", { value: "opaqueredirect" })
    expect(await opaque.request({ op: "workspaces" })).toEqual({ ok: false, code: "redirect_rejected" })
  })
  it("bounds bytes, rejects malformed UTF-8, escaped credential echoes, and foreign scopes", async () => {
    for (const [response, code] of [["x".repeat(512 * 1024 + 1), "response_too_large"], ["malformed", "response_invalid"],
      [new Response(new Uint8Array([255])), "response_invalid"], [JSON.stringify([{ id: "synthetic-test-\\u0074oken" }]).replace("\\\\u0074", "\\u0074"), "credential_echo"]] as const) {
      const context = fixture({ "/api/workspaces/list": response })
      expect(await context.request({ op: "workspaces" })).toEqual({ ok: false, code })
    }
    const context = fixture({ "/api/w/fixture/jobs/list": [{ ...completed, workspace_id: "other" }] })
    expect(await context.request({ op: "recent", workspace: "fixture" })).toEqual({ ok: false, code: "response_invalid" })
    const controller = new AbortController(); controller.abort()
    expect(await context.request({ op: "recent", workspace: "fixture" }, controller.signal)).toEqual({ ok: false, code: "request_canceled" })
  })
  it("normalizes recent jobs with schedule metadata and rejects ambiguous timestamps", async () => {
    const routes = { "/api/w/fixture/jobs/list": [{ ...completed, schedule_path: "u/test/schedule" }],
      "/api/w/fixture/schedules/list": [{ path: "u/test/schedule", timezone: "Asia/Kathmandu" }] }
    const context = fixture(routes)
    expect(await context.request({ op: "recent", workspace: "fixture" })).toMatchObject({ runs: [{ id, status: "failed", timezone: "Asia/Kathmandu", durationMs: 10 }] })
    routes["/api/w/fixture/jobs/list"][0].started_at = "2026-10-03T18:30:00"
    expect(await context.request({ op: "recent", workspace: "fixture" })).toEqual({ ok: false, code: "response_invalid" })
  })
  it("preserves numeric tokens and complete Unicode through inspection and follow", async () => {
    const raw = JSON.stringify(completed).replace('"args":{}', '"args":{"integer":9007199254740993,"decimal":0.10000000000000001}')
    const context = fixture({ ["/api/w/fixture/jobs_u/get/" + id]: raw, ["/api/w/fixture/jobs_u/get_logs/" + id]: "\u{1f642}".repeat(64001) })
    const result = await context.request({ op: "follow", instance: credentials.instance, workspace: "fixture", runId: id, offset: 0 })
    expect(result).toMatchObject({ offsets: { start: 1, end: 64001 }, detail: { logs: { truncated: true }, inputs: { text: '{"integer": 9007199254740993, "decimal": 0.10000000000000001}' } } })
    if (!result.ok || !("detail" in result)) throw new Error("Expected detail")
    expect(Array.from(result.detail.logs.text!)).toHaveLength(64000)
    expect(difference(result.detail.inputs, result.detail.inputs, true)).toContain("Unsupported JSON numeric precision")
  })
  it("keeps optional timezone failures and unavailable logs explicit", async () => {
    const context = fixture({ ["/api/w/fixture/jobs_u/get/" + id]: { ...completed, schedule_path: "u/test/schedule" },
      "/api/w/fixture/schedules/get/u/test/schedule": new Response("", { status: 403 }),
      ["/api/w/fixture/jobs_u/get_logs/" + id]: new Response("", { status: 404 }) })
    expect(await context.request({ op: "inspect", workspace: "fixture", runId: id })).toMatchObject({ detail: { logs: { state: "deleted" } } })
  })
  it("selects the latest earlier microsecond baseline and revalidates the returned job", async () => {
    const earlier = { ...completed, id: earlierId, success: true, started_at: "2026-10-03T18:30:00.000001Z" }
    const routes = { ["/api/w/fixture/jobs_u/get/" + id]: completed, ["/api/w/fixture/jobs_u/get/" + earlierId]: earlier,
      ["/api/w/fixture/jobs_u/get_logs/" + id]: "selected", ["/api/w/fixture/jobs_u/get_logs/" + earlierId]: "earlier",
      "/api/w/fixture/jobs/completed/list": [earlier] }
    const context = fixture(routes)
    const result = await context.request({ op: "compare", instance: credentials.instance, workspace: "fixture", runId: id })
    expect(result).toMatchObject({ state: "available", searched: 1, selected: { detail: { run: { startedAt: completed.started_at } } }, baseline: { detail: { run: { id: earlierId, startedAt: earlier.started_at } } } })
    routes["/api/w/fixture/jobs_u/get/" + earlierId] = { ...earlier, success: false }
    expect(await context.request({ op: "compare", workspace: "fixture", runId: id })).toEqual({ ok: false, code: "response_invalid" })
    routes["/api/w/fixture/jobs/completed/list"] = Array(100).fill(earlier)
    expect(await context.request({ op: "compare", workspace: "fixture", runId: id })).toMatchObject({ state: "search_limit" })
  })
})
