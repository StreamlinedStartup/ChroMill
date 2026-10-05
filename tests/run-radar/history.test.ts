// @vitest-environment node
import { expect, it, vi } from "vitest"
import { directRequest } from "../../src/direct-transport"
import { createLiveWorker } from "../../src/live-worker"
import { isNativeResponse } from "../../src/connection"
const instance = "https://fixture.example", workspace = "fixture", flowPath = "f/tests/old"
const credentials = { instance, apiKey: "synthetic-test-key" }
const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/popup.html` }
const job = (index: number, fields = {}) => ({ id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, workspace_id: workspace,
  type: "CompletedJob", is_flow_step: false, canceled: false, success: true, duration_ms: 5, job_kind: "flow", script_path: flowPath, started_at: "2026-01-01T00:00:00Z", ...fields })
function transport(rows: unknown) {
  const fetcher = vi.fn(async (_url: string | URL | Request) => { void _url; return new Response(JSON.stringify(String(_url).includes("/scripts/list") ? [] : rows)) })
  const request = (message: Record<string, unknown>) => directRequest(credentials, { instance, workspace, ...message }, new AbortController().signal, { contains: async () => true }, fetcher)
  return { request, fetcher }
}
it("discovers flows absent from recent history and bounds catalog pages", async () => {
  const c = transport([{ path: flowPath, summary: "Old payroll", workspace_id: workspace, private_field: "removed" }])
  expect(await c.request({ op: "flows", page: 2 })).toEqual({ ok: true, instance, workspace, page: 2, hasMore: false, flows: [{ path: flowPath, summary: "Old payroll", kind: "flow" }] })
  const url = new URL(String(c.fetcher.mock.calls[0]?.[0]))
  expect(url.pathname).toBe("/api/w/fixture/flows/list")
  expect(url.searchParams.get("page")).toBe("2")
  for (const rows of [Array(101).fill({ path: flowPath, flowKind: "flow" }), [{ path: flowPath, flowKind: "flow" }, { path: flowPath, flowKind: "flow" }], [{ path: flowPath, summary: false }], [{ path: "!f/test" }], [{ path: flowPath, workspace_id: "foreign" }]]) {
    expect(await transport(rows).request({ op: "flows", page: 1 })).toEqual({ ok: false, code: "response_invalid" })
  }
})
it("uses exact flow filters on every history page and includes active runs only on the first page", async () => {
  const c = transport(Array.from({ length: 100 }, (_, index) => job(index + 1)))
  expect(await c.request({ op: "history", page: 1, flowPath, flowKind: "flow" })).toMatchObject({ ok: true, page: 1, hasMore: true, flowPath, flowKind: "flow" })
  expect(await c.request({ op: "history", page: 2, flowPath, flowKind: "flow" })).toMatchObject({ ok: true, page: 2, hasMore: true })
  expect(await c.request({ op: "history", page: 3, flowPath: null, flowKind: null })).toMatchObject({ ok: true, flowPath: null, flowKind: null })
  const urls = c.fetcher.mock.calls.map(call => new URL(String(call[0])))
  expect(urls[0].pathname).toBe("/api/w/fixture/jobs/list")
  expect(urls[1].pathname).toBe("/api/w/fixture/jobs/completed/list")
  for (const url of urls.slice(0, 2)) {
    expect(url.searchParams.get("script_path_exact")).toBe(flowPath)
    expect(url.searchParams.get("job_kinds")).toBe("flow")
    expect(url.searchParams.get("has_null_parent")).toBe("true")
  }
  expect(urls[2].searchParams.has("script_path_exact")).toBe(false)
  const active = transport([job(1, { type: "QueuedJob", running: true })])
  expect(await active.request({ op: "history", page: 1, flowPath, flowKind: "flow" })).toMatchObject({ ok: true, hasMore: false, runs: [{ status: "running" }] })
  expect(await active.request({ op: "history", page: 2, flowPath, flowKind: "flow" })).toEqual({ ok: false, code: "response_invalid" })
  expect(await transport([]).request({ op: "history", page: 2, flowPath, flowKind: "flow" })).toMatchObject({ ok: true, hasMore: false, runs: [] })
})
it("rejects invalid requests before HTTP and wrong flow, workspace, child, or oversized results", async () => {
  const c = transport([])
  for (const message of [{ op: "history", page: 0, flowPath, flowKind: "flow" }, { op: "history", page: 1.5, flowPath, flowKind: "flow" }, { op: "history", page: 10001, flowPath, flowKind: "flow" },
    { op: "history", page: 1, flowPath: "!f/test", flowKind: "flow" }, { op: "history", page: 1, flowPath: "a,b", flowKind: "flow" }, { op: "flows", page: 1, extra: true }]) {
    expect(await c.request(message)).toEqual({ ok: false, code: "request_invalid" })
  }
  expect(c.fetcher).not.toHaveBeenCalled()
  for (const rows of [[job(1, { script_path: "f/tests/other" })], [job(1, { workspace_id: "foreign" })], [job(1, { parent_job: "parent" })], Array.from({ length: 101 }, (_, i) => job(i + 1))]) {
    expect(await transport(rows).request({ op: "history", page: 2, flowPath, flowKind: "flow" })).toEqual({ ok: false, code: "response_invalid" })
  }
})
it("history does not write monitoring or cancel inspection and disconnect cancels late results", async () => {
  const ports: { reply: (value: unknown) => void; request?: unknown; disconnect: ReturnType<typeof vi.fn> }[] = []
  const state = { connection: { instance, workspace }, monitoring: { sentinel: true } }
  const storage = { get: vi.fn(async () => state), set: vi.fn(), clear: vi.fn(async () => {}) }
  const runtime = { id: sender.id, connectNative: vi.fn(() => {
    const port = { reply: (value: unknown) => { void value }, disconnect: vi.fn(), request: undefined as unknown }; ports.push(port)
    return { onMessage: { addListener: (reply: (value: unknown) => void) => { port.reply = reply } }, onDisconnect: { addListener: vi.fn() }, disconnect: port.disconnect,
      postMessage: (value: unknown) => { port.request = value } }
  }) }
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea)
  const pending = worker({ type: "connection:history", page: 2, flowPath, flowKind: "flow" }, sender)
  await vi.waitFor(() => expect(ports).toHaveLength(1))
  expect(ports[0].request).toEqual({ op: "history", instance, workspace, page: 2, flowPath, flowKind: "flow" })
  const response = { ok: true, instance, workspace, mode: "live", snapshotAt: "2026-10-04T00:00:00Z", runs: [], page: 2, flowPath, flowKind: "flow", hasMore: false }
  ports[0].reply(response)
  expect(await pending).toEqual(response)
  expect(storage.set).not.toHaveBeenCalled()
  const delayed = worker({ type: "connection:history", page: 1, flowPath, flowKind: "flow" }, sender)
  await vi.waitFor(() => expect(ports).toHaveLength(2))
  await worker({ type: "connection:disconnect" }, sender)
  ports[1].reply({ ...response, page: 1 })
  expect(await delayed).toEqual({ ok: false, code: "request_canceled" })
  expect(isNativeResponse({ ...response, flowPath: "!invalid" })).toBe(false)
})
it("guards the worker response kind and cancels same-path history when kind changes", async () => {
  const ports: { reply: (value: unknown) => void; request?: unknown }[] = []
  const storage = { get: async () => ({ connection: { instance, workspace } }), set: vi.fn() }
  const runtime = { id: sender.id, connectNative: vi.fn(() => {
    const port = { reply: (_value: unknown) => { void _value }, request: undefined as unknown }; ports.push(port)
    return { onMessage: { addListener: (reply: (value: unknown) => void) => { port.reply = reply } }, onDisconnect: { addListener: vi.fn() }, disconnect: vi.fn(), postMessage: (value: unknown) => { port.request = value } }
  }) }
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea)
  const response = { ok: true, instance, workspace, mode: "live", snapshotAt: "2026-10-04T00:00:00Z", runs: [], page: 1, flowPath, flowKind: "flow", hasMore: false }
  const flow = worker({ type: "connection:history", page: 1, flowPath, flowKind: "flow" }, sender)
  await vi.waitFor(() => expect(ports).toHaveLength(1))
  const script = worker({ type: "connection:history", page: 1, flowPath, flowKind: "script" }, sender)
  await vi.waitFor(() => expect(ports).toHaveLength(2))
  expect(await flow).toEqual({ ok: false, code: "request_canceled" })
  ports[0].reply(response)
  ports[1].reply(response)
  expect(await script).toEqual({ ok: false, code: "response_invalid" })
  const valid = worker({ type: "connection:history", page: 1, flowPath, flowKind: "script" }, sender)
  await vi.waitFor(() => expect(ports).toHaveLength(3))
  expect(ports[2].request).toEqual({ op: "history", instance, workspace, page: 1, flowPath, flowKind: "script" })
  ports[2].reply({ ...response, flowKind: "script" })
  expect(await valid).toMatchObject({ ok: true, flowKind: "script" })
  for (const flowKind of [null, "preview", undefined]) expect(await worker({ type: "connection:history", page: 1, flowPath, flowKind }, sender)).toEqual({ ok: false, code: "request_invalid" })
  expect(ports).toHaveLength(3)
  expect(storage.set).not.toHaveBeenCalled()
})
