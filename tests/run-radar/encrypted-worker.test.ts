// @vitest-environment node
import { describe, it, expect, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import { CREDENTIALS, UNLOCK } from "../../src/credentials"
import { area } from "./credential-fixture"

const id = "00000000-0000-0000-0000-000000000001"
const origin = "https://fixture.example", password = "synthetic-password-only"
const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/options.html` }
const selection = { instance: origin, workspace: "fixture", runId: id }
const job = { id, workspace_id: "fixture", type: "CompletedJob", is_flow_step: false, canceled: false, success: false,
  is_skipped: false, started_at: "2026-10-03T18:30:00Z", script_path: "u/test/task", job_kind: "script", duration_ms: 10, args: {}, result: {} }
function setup() {
  const local = area(), session = area()
  const runtime = { id: sender.id, connectNative: vi.fn(() => { throw new Error("Host must not be required") }) }
  const fetcher = vi.fn(async (url: string) => {
    const path = new URL(url).pathname
    if (path === "/api/workspaces/list") return new Response(JSON.stringify([{ id: "fixture" }, { id: "second" }]))
    if (path.endsWith("/jobs/list")) return new Response(JSON.stringify([{ ...job, workspace_id: path.split("/")[3] }]))
    if (path.includes("get_logs")) return new Response("synthetic logs")
    if (path.includes("/jobs_u/get/")) return new Response(JSON.stringify(job))
    if (path.includes("/jobs/completed/list")) return new Response("[]")
    throw new Error("Unexpected fixture endpoint")
  })
  const services = { session: session.api, permissions: { contains: vi.fn(async () => true) } as unknown as typeof chrome.permissions, fetch: fetcher as unknown as typeof fetch }
  const alarms = { get: vi.fn(async () => undefined), create: vi.fn(), clear: vi.fn() }
  const action = { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() }
  const monitor = { alarms: alarms as unknown as typeof chrome.alarms, action: action as unknown as typeof chrome.action }
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, local.api, monitor, services)
  const send = (type: string, extra = {}) => worker({ type, ...extra }, sender)
  const save = () => send("credentials:save", { instance: origin, apiKey: "synthetic-test-token", password })
  return { local, session, worker, send, save, runtime, services, fetcher, action, monitor }
}
describe("encrypted connection worker", () => {
  it("authorizes only options credential actions and checks origin permission before saving", async () => {
    const context = setup()
    for (const denied of [{ ...sender, id: "other" }, { ...sender, url: sender.url.replace("options", "popup") }, { ...sender, url: sender.url + "?query" }]) {
      expect(await context.worker({ type: "credentials:save", instance: origin, apiKey: "synthetic-test-token", password }, denied)).toEqual({ ok: false, code: "request_invalid" })
    }
    expect(await context.send("credentials:save", { instance: "http://remote.example", apiKey: "synthetic-test-token", password })).toEqual({ ok: false, code: "credentials_invalid" })
    const permissionMock = context.services.permissions.contains as unknown as ReturnType<typeof vi.fn>
    permissionMock.mockResolvedValue(false)
    expect(await context.save()).toEqual({ ok: false, code: "permission_denied" })
    expect(context.local.state).toEqual({})
    expect(context.runtime.connectNative).not.toHaveBeenCalled()
  })
  it("runs workspaces, inspection, pins, follow, comparison, switching, and badges with no native helper", async () => {
    const context = setup()
    expect(await context.save()).toMatchObject({ saved: true, locked: false })
    expect(await context.send("connection:workspaces")).toMatchObject({ workspaces: ["fixture", "second"] })
    expect(await context.send("connection:connect", { workspace: "fixture" })).toMatchObject({ runs: [{ id, status: "failed" }] })
    await context.send("connection:select", { selection })
    expect(await context.send("connection:pin", { selection })).toMatchObject({ pins: [selection] })
    expect(await context.send("connection:inspect", { selection })).toMatchObject({ detail: { logs: { text: "synthetic logs" } } })
    const portSender = { ...sender, url: sender.url.replace("options", "sidepanel") }
    for (const [name, message] of [["run-radar-follow", { selection, offset: 0 }], ["run-radar-compare", { selection }]] as const) {
      let listener: (value: unknown) => Promise<void> = async () => {}
      const port = { name, sender: portSender, postMessage: vi.fn(), disconnect: vi.fn(), onDisconnect: { addListener: vi.fn() },
        onMessage: { addListener: (callback: typeof listener) => { listener = callback } } }
      context.worker.follow(port as unknown as chrome.runtime.Port)
      await listener(message)
      expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining(name.includes("follow") ? { detail: expect.any(Object) } : { state: "no_baseline" }))
    }
    expect(await context.send("connection:switch", { workspace: "second" })).toMatchObject({ workspace: "second" })
    expect(await context.send("connection:pins")).toMatchObject({ pins: [] })
    await context.send("connection:switch", { workspace: "fixture" })
    expect(await context.send("connection:pins")).toMatchObject({ pins: [selection] })
    await context.worker.poll()
    expect(context.action.setBadgeText).toHaveBeenCalled()
    expect(context.runtime.connectNative).not.toHaveBeenCalled()
  })
  it("locks on browser restart, preserves unlock across worker suspension, and resumes without host fallback", async () => {
    const context = setup()
    await context.save()
    await context.send("connection:connect", { workspace: "fixture" })
    const suspended = createLiveWorker(context.runtime as unknown as typeof chrome.runtime, context.local.api, context.monitor, context.services)
    expect(await suspended({ type: "connection:refresh" }, sender)).toMatchObject({ ok: true })
    await context.session.api.clear()
    const before = context.fetcher.mock.calls.length
    await suspended.restore()
    await suspended.poll()
    expect(context.fetcher).toHaveBeenCalledTimes(before)
    expect(context.action.setBadgeText).toHaveBeenLastCalledWith({ text: "LOCK" })
    expect(await suspended({ type: "connection:refresh" }, sender)).toEqual({ ok: false, code: "credentials_locked" })
    expect(await context.send("credentials:unlock", { password })).toMatchObject({ locked: false })
    expect(context.fetcher.mock.calls.length).toBeGreaterThan(before)
    await context.send("connection:disconnect")
    expect(context.local.state[CREDENTIALS]).toBeTruthy()
    expect(context.session.state[UNLOCK]).toBeUndefined()
    expect(context.local.state.connection).toBeUndefined()
    await context.send("credentials:remove")
    expect(context.local.state[CREDENTIALS]).toBeUndefined()
  })
  it("cancels old responses during replacement and serializes concurrent credential changes", async () => {
    const context = setup()
    await context.save()
    let resolveOld: (value: Response) => void = () => { throw new Error("Missing delayed request") }
    context.fetcher.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const old = context.send("connection:connect", { workspace: "fixture" })
    await vi.waitFor(() => expect(context.fetcher).toHaveBeenCalledTimes(1))
    const replacement = context.send("credentials:replace", { instance: "https://second.example", apiKey: "synthetic-second-token", password })
    resolveOld(new Response(JSON.stringify([job])))
    expect(await old).toEqual({ ok: false, code: "request_canceled" })
    expect(await replacement).toMatchObject({ instance: "https://second.example" })
    expect(context.local.state.connection).toBeUndefined()
    const replaceAgain = context.send("credentials:replace", { instance: origin, apiKey: "synthetic-test-token", password })
    const remove = context.send("credentials:remove")
    await Promise.all([replaceAgain, remove])
    expect(context.local.state[CREDENTIALS]).toBeUndefined()
    expect(context.session.state[UNLOCK]).toBeUndefined()
  })
  it.each(["replace", "lock", "remove"])("cancels Connect started during a delayed credential %s", async mutation => {
    const context = setup()
    await context.save()
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    let entered = false
    if (mutation === "replace") {
      const permission = context.services.permissions.contains as unknown as ReturnType<typeof vi.fn>
      permission.mockImplementationOnce(async () => { entered = true; await paused; return true })
    } else {
      const remove = context.session.mocks.remove.getMockImplementation()!
      context.session.mocks.remove.mockImplementationOnce(async keys => { entered = true; await paused; await remove(keys) })
    }
    const changing = context.send(`credentials:${mutation}`, mutation === "replace" ?
      { instance: "https://second.example", apiKey: "synthetic-second-token", password } : {})
    await vi.waitFor(() => expect(entered).toBe(true))
    const connecting = context.send("connection:connect", { workspace: "fixture" })
    // Let an unqueued credential read and transport run before the mutation settles.
    await new Promise(resolve => setTimeout(resolve, 50))
    const requestsDuringMutation = context.fetcher.mock.calls.length
    release()
    expect(await changing).toMatchObject({ ok: true })
    expect(await connecting).toEqual({ ok: false, code: "request_canceled" })
    expect(requestsDuringMutation).toBe(0)
    expect(context.local.state.connection).toBeUndefined()
    expect(context.local.state.monitoring).toBeUndefined()
    expect(context.monitor.alarms.create).not.toHaveBeenCalled()
    expect(context.runtime.connectNative).not.toHaveBeenCalled()
    if (mutation === "replace") {
      expect(await context.send("connection:connect", { workspace: "fixture" })).toMatchObject({ instance: "https://second.example" })
      expect(context.fetcher.mock.calls.every(([url]) => new URL(url).origin === "https://second.example")).toBe(true)
    } else if (mutation === "lock") {
      expect(await context.send("connection:connect", { workspace: "fixture" })).toEqual({ ok: false, code: "credentials_locked" })
    } else expect(context.local.state[CREDENTIALS]).toBeUndefined()
  })
  it.each(["replace", "lock", "remove"])("cancels a delayed credential read before %s can change its scope", async mutation => {
    const context = setup()
    await context.save()
    const get = context.local.mocks.get.getMockImplementation()!
    let release!: () => void
    let entered = false
    const paused = new Promise<void>(resolve => { release = resolve })
    context.local.mocks.get.mockImplementationOnce(async keys => {
      const saved = await get(keys)
      entered = true
      await paused
      return saved
    })
    const connecting = context.send("connection:connect", { workspace: "fixture" })
    await vi.waitFor(() => expect(entered).toBe(true))
    const changing = context.send(`credentials:${mutation}`, mutation === "replace" ?
      { instance: "https://second.example", apiKey: "synthetic-second-token", password } : {})
    release()
    expect(await connecting).toEqual({ ok: false, code: "request_canceled" })
    expect(await changing).toMatchObject({ ok: true })
    expect(context.fetcher).not.toHaveBeenCalled()
    expect(context.runtime.connectNative).not.toHaveBeenCalled()
    expect(context.local.state.connection).toBeUndefined()
  })
  it("reports storage failures and blocks damaged records without opening the host", async () => {
    const context = setup()
    await context.save()
    context.local.mocks.set.mockRejectedValueOnce(new Error("private storage diagnostic"))
    expect(await context.send("credentials:replace", { instance: origin, apiKey: "synthetic-test-token", password })).toEqual({ ok: false, code: "storage_failure" })
    expect(await context.send("credentials:get")).toMatchObject({ locked: true })
    context.local.state[CREDENTIALS] = { invalid: true }
    expect(await context.send("connection:workspaces")).toEqual({ ok: false, code: "credentials_invalid" })
    expect(context.runtime.connectNative).not.toHaveBeenCalled()
    expect(await context.send("credentials:remove")).toMatchObject({ saved: false })
  })
  it("keeps removal locked when scope cleanup fails and cancels a stalled HTTP request at its deadline", async () => {
    const context = setup()
    await context.save()
    await context.send("connection:connect", { workspace: "fixture" })
    context.local.mocks.remove.mockRejectedValueOnce(new Error("synthetic cleanup failure"))
    expect(await context.send("credentials:remove")).toEqual({ ok: false, code: "storage_failure" })
    expect(context.local.state[CREDENTIALS]).toBeTruthy()
    expect(await context.send("connection:refresh")).toEqual({ ok: false, code: "credentials_locked" })
    expect(context.runtime.connectNative).not.toHaveBeenCalled()
    await context.send("credentials:unlock", { password })
    context.services.fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic stalled response")), { once: true })
    })) as typeof fetch
    vi.useFakeTimers()
    try {
      const stalled = context.send("connection:refresh")
      await vi.waitFor(() => expect(context.services.fetch).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(15000)
      expect(await stalled).toEqual({ ok: false, code: "network_timeout" })
    } finally { vi.useRealTimers() }
  })
})

it.each(["replace", "lock", "remove"])("cancels private history during credential %s without changing the monitor baseline", async mutation => {
  const c = setup(); await c.save(); await c.send("connection:connect", { workspace: "fixture" })
  const monitoring = structuredClone(c.local.state.monitoring)
  let settle!: (value: Response) => void
  c.fetcher.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  const history = c.send("connection:history", { page: 1, flowPath: null, flowKind: null })
  await vi.waitFor(() => expect(settle).toBeDefined())
  expect(c.local.state.monitoring).toEqual(monitoring)
  const changing = c.send(`credentials:${mutation}`, mutation === "replace" ? { instance: origin, apiKey: "synthetic-new-token", password } : {})
  settle(new Response(JSON.stringify([job])))
  expect(await history).toEqual({ ok: false, code: "request_canceled" })
  await changing
  expect(c.runtime.connectNative).not.toHaveBeenCalled()
})
