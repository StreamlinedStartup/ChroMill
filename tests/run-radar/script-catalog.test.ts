// @vitest-environment node
import { expect, it, vi } from "vitest"
import { directRequest } from "../../src/direct-transport"
import { isNativeResponse } from "../../src/connection"
const instance = "https://fixture.example", workspace = "fixture", path = "f/tests/shared"
const job = (job_kind: unknown) => ({ id: "00000000-0000-0000-0000-000000000001", workspace_id: workspace,
  type: "CompletedJob", is_flow_step: false, canceled: false, success: true, duration_ms: 5, job_kind,
  script_path: path, started_at: "2026-01-01T00:00:00Z" })
function transport(flows: unknown[], scripts: unknown[], jobs: unknown[] = []) {
  const fetcher = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/flows/list") ? flows : String(url).includes("/scripts/list") ? scripts : jobs)))
  const request = (message: Record<string, unknown>) => directRequest({ instance, apiKey: "synthetic-key" }, { instance, workspace, ...message },
    new AbortController().signal, { contains: async () => true }, fetcher)
  return { request, fetcher }
}
it("keeps equal script and flow paths and deduplicates script versions", async () => {
  const c = transport([{ path, summary: "Flow" }], [{ path, summary: "Latest script", hash: "a", kind: "library" }, { path, summary: "Older script", hash: "b" }])
  expect(await c.request({ op: "flows", page: 2 })).toMatchObject({ ok: true, page: 2, hasMore: false,
    flows: [{ path, summary: "Flow", kind: "flow" }, { path, summary: "Latest script", kind: "script" }] })
  const url = new URL(String(c.fetcher.mock.calls[1][0]))
  expect(url.pathname).toBe("/api/w/fixture/scripts/list")
  expect(url.searchParams.get("show_archived")).toBe("false")
  expect(url.searchParams.get("include_without_main")).toBe("true")
  expect(url.searchParams.has("show_all_versions")).toBe(false)
})
it("retains raw version page coverage and rejects malformed or archived scripts", async () => {
  expect(await transport([], Array(100).fill({ path })).request({ op: "flows", page: 1 })).toMatchObject({ ok: true, hasMore: true, flows: [{ path, kind: "script" }] })
  for (const script of [{ path, archived: true }, { path, archived: "false" }, { path, workspace_id: "other" }, { path, summary: 3 }]) {
    expect(await transport([], [script]).request({ op: "flows", page: 1 })).toEqual({ ok: false, code: "response_invalid" })
  }
})
it("uses exact path plus kind on every script history page and rejects mismatches", async () => {
  const c = transport([], [], [job("script")])
  for (const page of [1, 2]) expect(await c.request({ op: "history", page, flowPath: path, flowKind: "script" })).toMatchObject({ ok: true, flowKind: "script", runs: [{ jobKind: "script" }] })
  for (const call of c.fetcher.mock.calls) expect(new URL(String(call[0])).searchParams.get("job_kinds")).toBe("script")
  expect(await transport([], [], [job("flow")]).request({ op: "history", page: 1, flowPath: path, flowKind: "script" })).toEqual({ ok: false, code: "response_invalid" })
  for (const flowKind of [undefined, "preview", null]) expect(await c.request({ op: "history", page: 1, flowPath: path, flowKind })).toEqual({ ok: false, code: "request_invalid" })
  expect(await c.request({ op: "history", page: 1, flowPath: null, flowKind: "script" })).toEqual({ ok: false, code: "request_invalid" })
})
it("preserves unknown execution kinds and rejects malformed kind metadata", async () => {
  expect(await transport([], [], [job("preview")]).request({ op: "recent" })).toMatchObject({ ok: true, runs: [{ jobKind: "preview" }] })
  for (const kind of [3, "", "a\n", "a".repeat(51)]) expect(await transport([], [], [job(kind)]).request({ op: "recent" })).toEqual({ ok: false, code: "response_invalid" })
  const response = { ok: true, instance, workspace, mode: "live", snapshotAt: "2026-10-04T00:00:00Z", page: 1,
    flowPath: path, flowKind: "script", hasMore: false, runs: [{ id: "run", name: "run", path, status: "success", durationMs: 5, trigger: "Manual", startedAt: "2026-01-01T00:00:00Z", jobKind: "flow" }] }
  expect(isNativeResponse(response)).toBe(false)
  expect(isNativeResponse({ ...response, runs: [{ ...response.runs[0], jobKind: "script" }] })).toBe(true)
  const catalog = { ok: true, instance, workspace, page: 1, hasMore: false,
    flows: [{ path, summary: "Flow", kind: "flow" }, { path, summary: "Script", kind: "script" }] }
  expect(isNativeResponse(catalog)).toBe(true)
  expect(isNativeResponse({ ...catalog, flows: [{ path, summary: "Unknown", kind: "preview" }] })).toBe(false)
  expect(isNativeResponse({ ...catalog, flows: [catalog.flows[0], catalog.flows[0]] })).toBe(false)
})
