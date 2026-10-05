import { expect, it, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import { browserTimezone } from "../../src/timezones"

const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/options.html` }
function setup() {
  let state: Record<string, unknown> = {}
  const storage = {
    get: vi.fn(async () => ({ ...state })),
    set: vi.fn(async value => { state = { ...state, ...value } }),
    clear: vi.fn(async () => { state = {} }),
    remove: vi.fn(async (keys: string[]) => { for (const key of keys) delete state[key] })
  }
  const runtime = { id: sender.id, connectNative: vi.fn() }
  const restart = () => createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea)
  return { worker: restart(), restart, storage, runtime, state: () => state }
}
it("persists the initial browser zone and serializes preference writes across restart and disconnect", async () => {
  const { worker, restart, storage, state, runtime } = setup()
  expect(await worker({ type: "connection:timezone" }, sender)).toEqual({ ok: true, timezone: browserTimezone() })
  await Promise.all([worker({ type: "connection:timezone-save", timezone: "UTC" }, sender), worker({ type: "connection:timezone-save", timezone: "Asia/Kathmandu" }, sender)])
  await storage.set({ connection: { instance: "https://fixture.example", workspace: "other" }, pins: [], selection: null })
  expect(await restart()({ type: "connection:timezone" }, sender)).toEqual({ ok: true, timezone: "Asia/Kathmandu" })
  await worker({ type: "connection:disconnect" }, sender)
  expect(state()).toEqual({ timezone: "Asia/Kathmandu" })
  expect(runtime.connectNative).not.toHaveBeenCalled()
})
it("retains a preference save that races with disconnect and awaits persistence", async () => {
  const { worker, storage, state } = setup()
  const original = storage.set.getMockImplementation()!
  let release: () => void = () => {}
  storage.set.mockImplementationOnce(value => new Promise<void>(resolve => { release = () => { void original(value).then(resolve) } }))
  let settled = false
  const save = worker({ type: "connection:timezone-save", timezone: "UTC" }, sender).then(value => { settled = true; return value })
  await vi.waitFor(() => expect(storage.set).toHaveBeenCalled())
  expect(settled).toBe(false)
  const disconnect = worker({ type: "connection:disconnect" }, sender)
  release()
  expect(await save).toEqual({ ok: true, timezone: "UTC" })
  await disconnect
  expect(state()).toEqual({ timezone: "UTC" })
})
it("rejects invalid zones and private extra fields, reports storage failures and recovers", async () => {
  const { worker, storage, state } = setup()
  for (const request of [{ type: "connection:timezone-save", timezone: "bad" }, { type: "connection:timezone-save", timezone: "UTC", inputs: "private" }]) {
    expect(await worker(request, sender)).toEqual({ ok: false, code: "request_invalid" })
  }
  storage.set.mockRejectedValueOnce(new Error("private diagnostic"))
  expect(await worker({ type: "connection:timezone-save", timezone: "UTC" }, sender)).toEqual({ ok: false, code: "helper_failure" })
  expect(await worker({ type: "connection:timezone-save", timezone: "UTC" }, sender)).toEqual({ ok: true, timezone: "UTC" })
  expect(state()).toEqual({ timezone: "UTC" })
  await storage.set({ timezone: "bad" })
  expect(await worker({ type: "connection:timezone" }, sender)).toEqual({ ok: false, code: "helper_failure" })
  expect(await worker({ type: "connection:timezone-save", timezone: "UTC" }, { ...sender, url: "https://untrusted.example" })).toEqual({ ok: false, code: "request_invalid" })
})
