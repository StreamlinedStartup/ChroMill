import { afterEach, describe, expect, it, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import { isFollowResponse } from "../../src/inspection"

const selection = { instance: "https://fixture.example", workspace: "fixture", runId: "00000000-0000-0000-0000-000000000001" }
const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/sidepanel.html` }
const field = { state: "available", text: "part", truncated: false }
const response = (status = "running", text = "part") => ({ ok: true, ...selection, offsets: { start: 0, end: Array.from(text).length }, detail: {
  run: { id: selection.runId, name: "fixture", path: "f/fixture", status, startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, trigger: "Unknown" },
  logs: { ...field, text }, inputs: field, result: field, steps: field
} })
function setup(deferFinalStorage = false) {
  const native: { reply: (value: unknown) => void; disconnect: ReturnType<typeof vi.fn>; message?: unknown }[] = []
  let state: Record<string, unknown> = { connection: { instance: selection.instance, workspace: selection.workspace }, selection }
  const runtime = { id: sender.id, connectNative: vi.fn(() => {
    const entry = { reply: (() => {}) as (value: unknown) => void, disconnect: vi.fn(), message: undefined as unknown }
    native.push(entry)
    return { onMessage: { addListener: (fn: typeof entry.reply) => { entry.reply = fn } }, onDisconnect: { addListener: vi.fn() }, disconnect: entry.disconnect, postMessage: (value: unknown) => { entry.message = value } }
  }) }
  let reads = 0
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, { get: async () => { if (++reads === 2 && deferFinalStorage) await gate; return state }, set: async (value: unknown) => { state = { ...state, ...value as object } }, clear: async () => { state = {} } } as unknown as chrome.storage.StorageArea)
  let send: (value: unknown) => Promise<void> = async () => {}
  let closed: () => void = () => {}
  const port = { name: "run-radar-follow", sender, postMessage: vi.fn(), disconnect: vi.fn(), onMessage: { addListener: (fn: typeof send) => { send = fn } }, onDisconnect: { addListener: (fn: () => void) => { closed = fn } } }
  worker.follow(port as unknown as chrome.runtime.Port)
  return { release, reads: () => reads, worker, native, port, send: (value: unknown = { selection, offset: 0 }) => send(value), close: () => closed() }
}
afterEach(() => vi.useRealTimers())
describe("selected panel follow", () => {
  it("polls serially with Unicode offsets and fetches final details once", async () => {
    vi.useFakeTimers()
    const c = setup()
    const first = c.send()
    await vi.advanceTimersByTimeAsync(0)
    c.native[0].reply(response("running", "parté\n"))
    await first
    await vi.advanceTimersByTimeAsync(2000)
    expect(c.native[1].message).toEqual({ op: "follow", ...selection, offset: 6 })
    const terminal = response("success", "parté\nfinal")
    c.native[1].reply(terminal)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.native[2].message).toEqual({ op: "inspect", ...selection })
    const final = { ok: true, ...selection, detail: terminal.detail }
    c.native[2].reply(final)
    await vi.advanceTimersByTimeAsync(0)
    expect(c.port.postMessage).toHaveBeenLastCalledWith(final)
    expect(c.port.disconnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(c.native).toHaveLength(3)
  })
  it.each(["selection", "workspace", "disconnect", "panel"])("%s cancellation closes pending native requests and rejects late events", async reason => {
    const c = setup()
    const pending = c.send()
    await vi.waitFor(() => expect(c.native).toHaveLength(1))
    if (reason === "panel") c.close()
    else if (reason === "selection") await c.worker({ type: "connection:select", selection: { ...selection, runId: selection.runId.replace(/1$/, "2") } }, sender)
    else if (reason === "workspace") {
      const connect = c.worker({ type: "connection:switch", workspace: "other" }, sender)
      await vi.waitFor(() => expect(c.native).toHaveLength(2))
      c.native[1].reply({ ok: false, code: "access_denied" })
      await connect
    } else await c.worker({ type: "connection:disconnect" }, sender)
    c.native[0].reply(response())
    await pending
    expect(c.native[0].disconnect).toHaveBeenCalledTimes(1)
    expect(c.port.postMessage).not.toHaveBeenCalled()
  })
  it("keeps follow alive through popup list refresh and same selection", async () => {
    const c = setup()
    const pending = c.send()
    await vi.waitFor(() => expect(c.native).toHaveLength(1))
    const refresh = c.worker({ type: "connection:refresh" }, sender)
    await vi.waitFor(() => expect(c.native).toHaveLength(2))
    c.native[1].reply({ ok: false, code: "network_failure" })
    await refresh
    const workspaces = c.worker({ type: "connection:workspaces" }, sender)
    await vi.waitFor(() => expect(c.native).toHaveLength(3))
    c.native[2].reply({ ok: true, instance: selection.instance, workspaces: ["fixture", "second"] })
    expect(await workspaces).toMatchObject({ ok: true, workspaces: ["fixture", "second"] })
    await c.worker({ type: "connection:select", selection }, sender)
    expect(c.native[0].disconnect).not.toHaveBeenCalled()
    c.native[0].reply(response())
    await pending
    c.close()
  })
  it.each(["network_failure", "authentication_expired", "response_too_large"])("stops on %s until the user reconnects", async code => {
    const c = setup()
    const pending = c.send({ selection, offset: 17 })
    await vi.waitFor(() => expect(c.native).toHaveLength(1))
    expect(c.native[0].message).toEqual({ op: "follow", ...selection, offset: 17 })
    c.native[0].reply({ ok: false, code })
    await pending
    expect(c.port.postMessage).toHaveBeenCalledWith({ ok: false, code })
    expect(c.port.disconnect).toHaveBeenCalledTimes(1)
  })
  it("does not dispatch final inspection after closure during its storage read", async () => {
    const c = setup(true)
    const pending = c.send()
    await vi.waitFor(() => expect(c.native).toHaveLength(1))
    c.native[0].reply(response("success"))
    await vi.waitFor(() => expect(c.reads()).toBe(2))
    c.close()
    c.release()
    await pending
    expect(c.native).toHaveLength(1)
    expect(c.native[0].disconnect).toHaveBeenCalledTimes(1)
    expect(c.port.postMessage).not.toHaveBeenCalled()
    expect(c.port.disconnect).toHaveBeenCalledTimes(1)
  })
  it("panel closure cancels the final details fetch", async () => {
    const c = setup()
    const pending = c.send()
    await vi.waitFor(() => expect(c.native).toHaveLength(1))
    c.native[0].reply(response("success"))
    await vi.waitFor(() => expect(c.native).toHaveLength(2))
    c.close()
    await pending
    expect(c.native[1].disconnect).toHaveBeenCalledTimes(1)
    expect(c.port.postMessage).not.toHaveBeenCalled()
  })
  it("rejects malformed offsets and unauthorized callers", async () => {
    const c = setup()
    await c.send({ selection, offset: -1 })
    expect(c.native).toHaveLength(0)
    const denied = { ...c.port, sender: { ...sender, url: sender.url.replace("sidepanel", "popup") }, disconnect: vi.fn() }
    c.worker.follow(denied as unknown as chrome.runtime.Port)
    expect(denied.disconnect).toHaveBeenCalled()
    expect(isFollowResponse(response("running", "é"))).toBe(true)
    expect(isFollowResponse({ ...response(), offsets: { start: 0, end: 9 } })).toBe(false)
  })
  it("stops at a log-size limit without scheduling another poll", async () => {
    vi.useFakeTimers()
    const c = setup()
    const pending = c.send()
    await vi.advanceTimersByTimeAsync(0)
    const limited = response()
    limited.detail.logs.truncated = true
    limited.offsets = { start: 5, end: 9 }
    c.native[0].reply(limited)
    await pending
    expect(c.port.postMessage).toHaveBeenCalledWith(limited)
    await vi.advanceTimersByTimeAsync(10000)
    expect(c.native).toHaveLength(1)
  })
})
