import { it, expect, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import type { LiveSnapshot } from "../../src/connection"
import type { Run } from "../../src/runs"

const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/popup.html` }
const instance = "https://fixture.example"
const run: Run = { id: "00000000-0000-0000-0000-000000000001", startedAt: "2026-10-04T00:00:00.000Z", status: "running", name: "Fixture", path: "f/test", trigger: "Manual", durationMs: 1 }
function snapshot(workspace: string, status: Run["status"] = "running", origin = instance): LiveSnapshot {
  return { ok: true, mode: "live", instance: origin, workspace, snapshotAt: run.startedAt, runs: [{ ...run, status }] }
}
function setup() {
  let state: Record<string, unknown> = {}
  const ports: { reply: (value: unknown) => void; disconnect: ReturnType<typeof vi.fn>; message?: unknown }[] = []
  const runtime = { id: sender.id, connectNative: () => {
    const entry = { reply: (() => {}) as (value: unknown) => void, disconnect: vi.fn(), message: undefined as unknown }
    ports.push(entry)
    return { onMessage: { addListener: (callback: typeof entry.reply) => { entry.reply = callback } }, onDisconnect: { addListener: vi.fn() },
      disconnect: entry.disconnect, postMessage: (value: unknown) => { entry.message = value } }
  } }
  const storage = { get: vi.fn(async () => structuredClone(state)), set: vi.fn(async value => { state = { ...state, ...structuredClone(value) } }), clear: vi.fn(async () => { state = {} }) }
  const services = { now: () => Date.parse(run.startedAt), alarms: { get: vi.fn(async () => undefined), create: vi.fn(), clear: vi.fn() },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setTitle: vi.fn() } }
  const restart = () => createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea, services as unknown as Parameters<typeof createLiveWorker>[2])
  const worker = restart()
  async function respond(pending: Promise<unknown>, value: unknown, index = ports.length - 1) {
    await vi.waitFor(() => expect(ports.length).toBeGreaterThan(index))
    ports[index].reply(value)
    return pending
  }
  async function connect(workspace = "alpha", origin = instance) {
    const index = ports.length
    return respond(worker({ type: "connection:connect", workspace }, sender), snapshot(workspace, "running", origin), index)
  }
  async function switchTo(workspace: string, status: Run["status"] = "running", owner = worker) {
    const index = ports.length
    return respond(owner({ type: "connection:switch", workspace }, sender), snapshot(workspace, status), index)
  }
  return { worker, ports, storage, services, restart, connect, switchTo, respond, state: () => structuredClone(state) }
}

it("migrates legacy monitoring and restores pins, cursor, counts and seen state per scope after restart", async () => {
  const c = setup(); await c.connect()
  const alpha = { instance, workspace: "alpha", runId: run.id }
  await c.worker({ type: "connection:pin", selection: alpha }, sender)
  const index = c.ports.length
  await c.respond(c.worker.poll(), snapshot("alpha", "failed"), index)
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "1" })
  expect(c.state().monitoringScopes).toBeUndefined()
  await c.switchTo("beta")
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
  expect(await c.worker({ type: "connection:pins" }, sender)).toMatchObject({ pins: [] })
  const beta = { ...alpha, workspace: "beta" }
  await c.worker({ type: "connection:pin", selection: beta }, sender)
  await c.worker({ type: "connection:select", selection: beta }, sender)
  const detailIndex = c.ports.length
  await c.respond(c.worker({ type: "connection:inspect", selection: beta }, sender), { ok: true, ...beta,
    detail: { run: { ...run, status: "failed" }, logs: { state: "unavailable" }, inputs: { state: "unavailable" }, result: { state: "unavailable" }, steps: { state: "unavailable" } } }, detailIndex)
  const restarted = c.restart(); await restarted.restore()
  await c.switchTo("alpha", "failed", restarted)
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "1" })
  expect(await restarted({ type: "connection:pins" }, sender)).toMatchObject({ pins: [alpha] })
  expect(c.state().monitoring).toMatchObject({ workspace: "alpha", cursor: run.startedAt, records: [{ id: run.id, seen: false }] })
  await c.switchTo("beta", "failed", restarted)
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
  expect(c.state().monitoring).toMatchObject({ workspace: "beta", records: [{ id: run.id, seen: true }] })
  expect(await restarted({ type: "connection:pins" }, sender)).toMatchObject({ pins: [beta] })
  expect(JSON.stringify(c.state())).not.toContain("f/test")
})

it("cancels old list and detail requests before switching, rejects late replies and serializes rapid switches", async () => {
  const c = setup(); await c.connect()
  const selection = { instance, workspace: "alpha", runId: run.id }
  await c.worker({ type: "connection:select", selection }, sender)
  const detail = c.worker({ type: "connection:inspect", selection }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(2))
  const list = c.worker({ type: "connection:refresh" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(3))
  const beta = c.worker({ type: "connection:switch", workspace: "beta" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(4))
  expect(c.state().connection).toEqual({ instance, workspace: "beta" })
  expect(c.state().selection).toBeNull()
  expect(c.ports[3].message).toEqual({ op: "recent", instance, workspace: "beta" })
  const gamma = c.worker({ type: "connection:switch", workspace: "gamma" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(5))
  c.ports[1].reply(snapshot("alpha")); c.ports[2].reply(snapshot("alpha")); c.ports[3].reply(snapshot("beta"))
  c.ports[4].reply(snapshot("gamma"))
  for (const pending of [detail, list, beta]) expect(await pending).toEqual({ ok: false, code: "request_canceled" })
  expect(await gamma).toMatchObject({ workspace: "gamma" })
  expect(c.state().connection).toEqual({ instance, workspace: "gamma" })
  expect(await c.worker({ type: "connection:inspect", selection }, sender)).toEqual({ ok: false, code: "request_invalid" })
})

it("retains the requested scope on revoked access, restores the error after restart, and disconnect clears every scope", async () => {
  const c = setup(); await c.connect()
  const pending = c.worker({ type: "connection:switch", workspace: "beta" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(2))
  c.ports[1].reply({ ok: false, code: "access_denied" })
  expect(await pending).toEqual({ ok: false, code: "access_denied" })
  expect(c.state().connection).toEqual({ instance, workspace: "beta" })
  const restarted = c.restart(); await restarted.restore()
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "ERR" })
  const again = restarted({ type: "connection:switch", workspace: "alpha" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(3))
  await restarted({ type: "connection:disconnect" }, sender)
  c.ports[2].reply(snapshot("alpha"))
  expect(await again).toEqual({ ok: false, code: "request_canceled" })
  expect(c.state()).toEqual({})
})

it("isolates identical workspaces and run IDs across configured instances", async () => {
  const c = setup(); await c.connect()
  const index = c.ports.length
  await c.respond(c.worker.poll(), snapshot("alpha", "failed"), index)
  await c.connect("alpha", "https://other.example")
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
  await c.connect()
  expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "1" })
})

it("reports capacity and malformed retained records without silently dropping scopes", async () => {
  const c = setup(); await c.connect()
  for (let index = 0; index < 20; index++) await c.switchTo(`scope${index}`)
  const count = c.ports.length
  expect(await c.worker({ type: "connection:switch", workspace: "overflow" }, sender)).toEqual({ ok: false, code: "scope_limit" })
  expect(c.ports).toHaveLength(count)
  expect(c.state().connection).toEqual({ instance, workspace: "scope19" })
  await c.storage.set({ monitoringScopes: [{ private: "invalid" }] })
  expect(await c.worker({ type: "connection:monitor" }, sender)).toEqual({ ok: false, code: "helper_failure" })
})

it("rejects an old response during its storage read and serializes pin edits with the switch", async () => {
  const c = setup(); await c.connect()
  const pending = c.worker({ type: "connection:refresh" }, sender)
  await vi.waitFor(() => expect(c.ports).toHaveLength(2))
  let release: () => void = () => { throw new Error("Missing storage gate") }
  const old = c.state()
  c.storage.get.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(old) }))
  c.ports[1].reply(snapshot("alpha", "failed"))
  await vi.waitFor(() => expect(c.storage.get).toHaveBeenCalledTimes(3))
  const pin = c.worker({ type: "connection:pin", selection: { instance, workspace: "alpha", runId: run.id } }, sender)
  const switching = c.worker({ type: "connection:switch", workspace: "beta" }, sender)
  release()
  await vi.waitFor(() => expect(c.ports).toHaveLength(3))
  c.ports[2].reply(snapshot("beta"))
  expect(await pending).toEqual({ ok: false, code: "request_canceled" })
  expect(await pin).toEqual({ ok: false, code: "request_canceled" })
  expect(await switching).toMatchObject({ ok: true, workspace: "beta" })
  expect(c.state().monitoring).toMatchObject({ workspace: "beta", records: [{ seen: false, status: "running" }] })
  expect(c.state().monitoringScopes).toEqual([expect.objectContaining({ workspace: "alpha", records: [expect.objectContaining({ status: "running" })] })])
})

for (const type of ["connection:workspaces", "connection:status"]) {
  for (const action of ["disconnect", "switch"]) {
    it(`cancels ${type} before native dispatch when storage is held across ${action}`, async () => {
      const c = setup(); await c.connect()
      let release!: (value: Record<string, unknown>) => void
      const oldState = c.state()
      c.storage.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const pending = c.worker({ type }, sender)
      await vi.waitFor(() => expect(release).toBeDefined())
      if (action === "disconnect") await c.worker({ type: "connection:disconnect" }, sender)
      else await c.switchTo("beta")
      const nativeCount = c.ports.length
      release(oldState)
      expect(await pending).toEqual({ ok: false, code: "request_canceled" })
      expect(c.ports).toHaveLength(nativeCount)
      expect(c.state().connection).toEqual(action === "disconnect" ? undefined : { instance, workspace: "beta" })
    })
  }
}
