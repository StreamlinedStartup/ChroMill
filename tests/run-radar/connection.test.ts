import { describe, it, expect, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import { isNativeResponse } from "../../src/connection"

const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/popup.html` }
const snapshot = { ok: true, mode: "live", instance: "https://fixture.example", workspace: "fixture", snapshotAt: "2026-10-03T18:30:00.000Z", runs: [] }
function setup() {
  const ports: { message: (value: unknown) => void; disconnect: ReturnType<typeof vi.fn>; request: unknown }[] = []
  let state: Record<string, unknown> = {}
  const storage = {
    get: vi.fn(async () => state),
    set: vi.fn(async value => { state = { ...state, ...value } }),
    clear: vi.fn(async () => { state = {} })
  }
  const runtime = { id: sender.id, connectNative: vi.fn(() => {
    const entry = { message: (() => {}) as (value: unknown) => void, disconnect: vi.fn(), request: undefined as unknown }
    ports.push(entry)
    return { onMessage: { addListener: (listener: (value: unknown) => void) => { entry.message = listener } },
      onDisconnect: { addListener: vi.fn() }, disconnect: entry.disconnect, postMessage: (value: unknown) => { entry.request = value } }
  }) }
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea)
  return { worker, ports, runtime, storage, state: () => state }
}

describe("connection boundaries", () => {
  it("rejects untrusted senders, URLs, mutations, and invalid workspace IDs before opening a port", async () => {
    const { worker, runtime } = setup()
    for (const message of [{ type: "connection:connect", workspace: "../admin" }, { type: "connection:connect", workspace: "fixture", url: "https://evil" }, { type: "connection:delete" }, { type: "connection:status", extra: "x".repeat(9000) }]) {
      expect(await worker(message, sender)).toEqual({ ok: false, code: "request_invalid" })
    }
    for (const denied of [{ id: "other", url: sender.url }, { ...sender, url: "https://fixture.example" }, { ...sender, url: sender.url + "?query" }]) {
      expect(await worker({ type: "connection:status" }, denied)).toEqual({ ok: false, code: "request_invalid" })
    }
    expect(runtime.connectNative).not.toHaveBeenCalled()
  })
  it("persists only public metadata and restores it after worker restart", async () => {
    const { worker, ports, storage, state } = setup()
    const request = worker({ type: "connection:connect", workspace: "fixture" }, sender)
    expect(ports[0].request).toEqual({ op: "recent", workspace: "fixture" })
    ports[0].message(snapshot)
    expect(await request).toEqual(snapshot)
    expect(state().connection).toEqual({ instance: snapshot.instance, workspace: "fixture" })
    expect(state().monitoring).toMatchObject({ records: [], gap: false, error: null })
    expect(storage.set).toHaveBeenCalledTimes(1)
    expect(await worker({ type: "connection:get" }, sender)).toEqual({ ok: true, connection: state().connection })
  })
  it("disconnect cancels requests, closes native ports, clears caches, and ignores late replies", async () => {
    const { worker, ports, state, storage } = setup()
    const request = worker({ type: "connection:connect", workspace: "fixture" }, sender)
    expect(await worker({ type: "connection:disconnect" }, sender)).toEqual({ ok: true, connection: null })
    ports[0].message(snapshot)
    expect(await request).toEqual({ ok: false, code: "request_canceled" })
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1)
    expect(state()).toEqual({})
    expect(storage.set).not.toHaveBeenCalled()
  })
  it("workspace discovery preserves compatible requests and rejects malformed host data", async () => {
    const { worker, ports, storage } = setup()
    const first = worker({ type: "connection:connect", workspace: "fixture" }, sender)
    const second = worker({ type: "connection:workspaces" }, sender)
    await vi.waitFor(() => expect(ports).toHaveLength(2))
    ports[0].message(snapshot)
    ports[1].message({ ok: true, instance: snapshot.instance, workspaces: ["fixture"], apiKey: "synthetic-only" })
    expect(await first).toEqual(snapshot)
    expect(await second).toEqual({ ok: false, code: "response_invalid" })
    expect(storage.set).toHaveBeenCalledTimes(1)
  })
  it("rejects mismatched workspace and reports missing helper and storage failures", async () => {
    const { worker, ports, runtime, storage } = setup()
    const request = worker({ type: "connection:connect", workspace: "other" }, sender)
    ports[0].message(snapshot)
    expect(await request).toEqual({ ok: false, code: "response_invalid" })
    runtime.connectNative.mockImplementation(() => { throw new Error("private native diagnostic") })
    expect(await worker({ type: "connection:status" }, sender)).toEqual({ ok: false, code: "helper_missing" })
    storage.clear.mockRejectedValue(new Error("private storage diagnostic"))
    expect(await worker({ type: "connection:disconnect" }, sender)).toEqual({ ok: false, code: "helper_failure" })
  })
  it("bounds and validates native response shapes", () => {
    expect(isNativeResponse(snapshot)).toBe(true)
    for (const value of [{ ...snapshot, instance: "http://remote.example" }, { ...snapshot, workspace: "../admin" }, { ...snapshot, runs: Array(101).fill({}) }, { ok: false, code: "arbitrary private error" }, { ...snapshot, token: "synthetic-only" }]) {
      expect(isNativeResponse(value)).toBe(false)
    }
  })
})

const selection = { instance: snapshot.instance, workspace: "fixture", runId: "00000000-0000-0000-0000-000000000001" }
describe("inspection worker", () => {
  async function connected() {
    const context = setup()
    const request = context.worker({ type: "connection:connect", workspace: "fixture" }, sender)
    context.ports[0].message(snapshot)
    await request
    return context
  }
  it("preserves identity across worker restart and disconnect removes it", async () => {
    const { worker, runtime, storage, state } = await connected()
    expect(await worker({ type: "connection:select", selection }, sender)).toEqual({ ok: true })
    const restarted = createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea)
    const panel = { ...sender, url: sender.url.replace("popup", "sidepanel") }
    expect(await restarted({ type: "connection:selection" }, panel)).toEqual({ ok: true, selection })
    expect(Object.keys(state()).sort()).toEqual(["connection", "monitoring", "selection"])
    await worker({ type: "connection:disconnect" }, sender)
    expect(await restarted({ type: "connection:selection" }, panel)).toEqual({ ok: true, selection: null })
  })
  it("rejects cross-instance and cross-workspace inspection before native access", async () => {
    const { worker, ports } = await connected()
    for (const identity of [{ ...selection, workspace: "other" }, { ...selection, instance: "https://other.example" }]) {
      expect(await worker({ type: "connection:inspect", selection: identity }, sender)).toEqual({ ok: false, code: "request_invalid" })
    }
    expect(ports).toHaveLength(1)
  })
  it("a newer selection cancels old detail requests and ignores late responses", async () => {
    const { worker, ports } = await connected()
    await worker({ type: "connection:select", selection }, sender)
    const request = worker({ type: "connection:inspect", selection }, sender)
    await vi.waitFor(() => expect(ports).toHaveLength(2))
    expect(ports[1].request).toEqual({ op: "inspect", ...selection })
    await worker({ type: "connection:select", selection: { ...selection, runId: "00000000-0000-0000-0000-000000000002" } }, sender)
    ports[1].message(snapshot)
    expect(await request).toEqual({ ok: false, code: "request_canceled" })
    expect(ports[1].disconnect).toHaveBeenCalledTimes(1)
  })
  it("popup refresh and concurrent same selection preserve pending panel inspection", async () => {
    const { worker, ports } = await connected()
    await worker({ type: "connection:select", selection }, sender)
    const panel = { ...sender, url: sender.url.replace("popup", "sidepanel") }
    const inspection = worker({ type: "connection:inspect", selection }, panel)
    await vi.waitFor(() => expect(ports).toHaveLength(2))
    const refresh = worker({ type: "connection:refresh" }, sender)
    const repeated = worker({ type: "connection:select", selection }, sender)
    await vi.waitFor(() => expect(ports).toHaveLength(3))
    ports[2].message(snapshot)
    expect(await refresh).toEqual(snapshot)
    expect(await repeated).toEqual({ ok: true })
    expect(ports[1].disconnect).not.toHaveBeenCalled()
    ports[1].message({ ok: false, code: "deleted" })
    expect(await inspection).toEqual({ ok: false, code: "deleted" })
  })
})

it("supersedes browsing requests without canceling inspection or rewriting monitoring", async () => {
  const c = setup()
  const connecting = c.worker({ type: "connection:connect", workspace: "fixture" }, sender)
  c.ports[0].message(snapshot); await connecting
  const monitoring = structuredClone(c.state().monitoring)
  const inspecting = c.worker({ type: "connection:inspect", selection }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(2))
  const flows = c.worker({ type: "connection:flows", page: 1 }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(3))
  const history = c.worker({ type: "connection:history", page: 2, flowPath: "f/tests/old", flowKind: "flow" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(4))
  expect(await flows).toEqual({ ok: false, code: "request_canceled" })
  expect(c.ports[1].disconnect).not.toHaveBeenCalled()
  c.ports[2].message({ ok: true, ...selection, page: 1, flows: [], hasMore: false })
  c.ports[3].message({ ...snapshot, runs: [], page: 2, flowPath: "f/tests/old", flowKind: "flow", hasMore: false })
  expect(await history).toMatchObject({ ok: true, page: 2 })
  c.ports[1].message({ ok: false, code: "forbidden" })
  expect(await inspecting).toEqual({ ok: false, code: "forbidden" })
  expect(c.state().monitoring).toEqual(monitoring)
  for (const request of [{ type: "connection:history", page: 0, flowPath: null, flowKind: null }, { type: "connection:flows", page: 1, extra: true }]) {
    expect(await c.worker(request, sender)).toEqual({ ok: false, code: "request_invalid" })
  }
  expect(c.ports).toHaveLength(4)
})
