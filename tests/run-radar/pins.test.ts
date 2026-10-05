import { describe, it, expect, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import { isPinsResponse } from "../../src/inspection"

const connection = { instance: "https://fixture.example", workspace: "fixture" }
const first = { ...connection, runId: "00000000-0000-0000-0000-000000000001" }
const second = { ...first, runId: "00000000-0000-0000-0000-000000000002" }
const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/popup.html` }
function setup() {
  let state: Record<string, unknown> = { connection }
  const storage = {
    get: vi.fn(async () => ({ ...state })),
    set: vi.fn(async value => { state = { ...state, ...value } }),
    clear: vi.fn(async () => { state = {} })
  }
  const runtime = { id: sender.id, connectNative: vi.fn() }
  const restart = () => createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea)
  const worker = restart()
  const request = (type: string, selection?: typeof first) => worker({ type: `connection:${type}`, ...(selection ? { selection } : {}) }, sender)
  return { request, worker, storage, runtime, restart, state: () => state }
}
describe("durable pins", () => {
  it("serializes concurrent edits, removes duplicates and restores identities after restart", async () => {
    const { request, restart, state } = setup()
    expect((await Promise.all([request("pin", first), request("pin", second), request("pin", first)])).every(isPinsResponse)).toBe(true)
    expect(state().pins).toEqual([second, first])
    expect(await restart()({ type: "connection:pins" }, sender)).toEqual({ ok: true, connection, pins: [second, first] })
    await Promise.all([request("unpin", first), request("pin", second)])
    expect(state()).toEqual({ connection, pins: [second] })
  })
  it("does not collide across workspaces or instances and rejects cross-scope edits", async () => {
    const { request, storage, state } = setup()
    await request("pin", first)
    const other = { ...first, workspace: "other" }
    expect(await request("pin", other)).toEqual({ ok: false, code: "request_invalid" })
    await storage.set({ connection: { instance: other.instance, workspace: other.workspace } })
    await request("pin", other)
    const remote = { ...first, instance: "https://other.example" }
    await storage.set({ connection: { instance: remote.instance, workspace: remote.workspace } })
    await request("pin", remote)
    expect(state().pins).toEqual([first, other, remote])
    expect(await request("pins")).toEqual({ ok: true, connection: { instance: remote.instance, workspace: remote.workspace }, pins: [remote] })
    await request("unpin", remote)
    expect(state().pins).toEqual([first, other])
  })
  it("disconnect clears pins during a delayed edit and late writes cannot restore them", async () => {
    const { request, storage, state } = setup()
    let release: () => void = () => {}
    storage.get.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ...state() }) }))
    const pin = request("pin", first)
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalled())
    const disconnect = request("disconnect")
    release()
    expect(await pin).toEqual({ ok: false, code: "request_canceled" })
    expect(await disconnect).toEqual({ ok: true, connection: null })
    expect(state()).toEqual({})
  })
  it("awaits durable writes and reports storage failures, then permits recovery", async () => {
    const { request, storage } = setup()
    storage.set.mockRejectedValueOnce(new Error("private storage diagnostic"))
    expect(await request("pin", first)).toEqual({ ok: false, code: "helper_failure" })
    expect(await request("pin", second)).toEqual({ ok: true, connection, pins: [second] })
  })
  it("does not acknowledge a pending durable write and disconnect clears an in-flight write", async () => {
    const { request, storage, state } = setup()
    const original = storage.set.getMockImplementation()!
    let release: () => void = () => {}
    storage.set.mockImplementationOnce(value => new Promise<void>(resolve => {
      release = () => { void original(value).then(resolve) }
    }))
    let acknowledged = false
    const pin = request("pin", first).then(value => { acknowledged = true; return value })
    await vi.waitFor(() => expect(storage.set).toHaveBeenCalled())
    expect(acknowledged).toBe(false)
    expect(state().pins).toBeUndefined()
    const disconnect = request("disconnect")
    release()
    expect(await pin).toEqual({ ok: false, code: "request_canceled" })
    expect(await disconnect).toEqual({ ok: true, connection: null })
    expect(state()).toEqual({})
  })
  it("rejects malformed records and additional private fields without persisting them", async () => {
    const { request, storage, runtime } = setup()
    expect(await request("pin", { ...first, logs: "private" } as typeof first)).toEqual({ ok: false, code: "request_invalid" })
    await storage.set({ pins: [{ ...first, inputs: "private" }] })
    expect(await request("pins")).toEqual({ ok: false, code: "response_invalid" })
    expect(runtime.connectNative).not.toHaveBeenCalled()
    expect(isPinsResponse({ ok: true, connection, pins: [{ ...first, workspace: "other" }] })).toBe(false)
  })
})
