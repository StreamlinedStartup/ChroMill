import { describe, it, expect, vi } from "vitest"
import { createLiveWorker } from "../../src/live-worker"
import { refreshMonitoring, monitorDisplay, isMonitoring, MONITOR_ALARM } from "../../src/monitoring"
import type { LiveSnapshot } from "../../src/connection"
import type { Run, RunStatus } from "../../src/runs"

const start = "2026-10-03T18:30:00.000Z"
const time = Date.parse(start)
const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/popup.html` }
const run = (index: number, status: RunStatus = "failed", offset = 0): Run => ({ id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`, startedAt: new Date(time + offset).toISOString(), status, name: "Fixture", path: "f/test", trigger: "Manual", durationMs: 1 })
const snapshot = (runs: Run[], offset = 0): LiveSnapshot => ({ ok: true, mode: "live", instance: "https://fixture.example", workspace: "fixture", snapshotAt: new Date(time + offset).toISOString(), runs })
function setup() {
  let state: Record<string, unknown> = {}
  let clock = time
  const ports: { reply: (value: unknown) => void; disconnect: ReturnType<typeof vi.fn> }[] = []
  const runtime = { id: sender.id, connectNative: vi.fn(() => {
    const port = { reply: (() => {}) as (value: unknown) => void, disconnect: vi.fn() }
    ports.push(port)
    return { onMessage: { addListener: (listener: (value: unknown) => void) => { port.reply = listener } }, onDisconnect: { addListener: vi.fn() }, postMessage: vi.fn(), disconnect: port.disconnect }
  }) }
  const storage = { get: vi.fn(async () => structuredClone(state)), set: vi.fn(async value => { state = { ...state, ...structuredClone(value) } }), clear: vi.fn(async () => { state = {} }) }
  let alarm: unknown
  const services = { now: () => clock, alarms: { get: vi.fn(async () => alarm), create: vi.fn(async (_name, value) => { alarm = value }), clear: vi.fn(async () => { alarm = undefined; return true }) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) } }
  const restart = () => createLiveWorker(runtime as unknown as typeof chrome.runtime, storage as unknown as chrome.storage.StorageArea, services as unknown as Parameters<typeof createLiveWorker>[2])
  const worker = restart()
  async function reply(pending: Promise<unknown>, response: unknown) {
    await vi.waitFor(() => expect(ports.at(-1)).toBeDefined())
    ports.at(-1)!.reply(response)
    return pending
  }
  async function connect(runs = [run(1), run(2, "running")]) { return reply(worker({ type: "connection:connect", workspace: "fixture" }, sender), snapshot(runs)) }
  return { worker, ports, storage, services, restart, connect, state: () => structuredClone(state), clock: (value: number) => { clock = value } }
}

describe("monitoring reducer and clock", () => {
  it("baselines history, counts active transitions and equal-time retries once", () => {
    const baseline = refreshMonitoring(null, snapshot([run(1), run(2, "running")]), time)
    expect(monitorDisplay(baseline, time).text).toBe("")
    const next = refreshMonitoring(baseline, snapshot([run(2), run(3), run(1)], 60000), time + 60000)
    expect(monitorDisplay(next, time + 60000).text).toBe("2")
    expect(refreshMonitoring(next, snapshot([run(3), run(2), run(1)], 60000), time + 60000).records).toEqual(next.records)
    expect(isMonitoring(next)).toBe(true)
  })
  it("handles empty baselines and retains unseen failures outside recent history", () => {
    const empty = refreshMonitoring(null, snapshot([]), time)
    const historical = refreshMonitoring(empty, snapshot([run(1, "failed", -60000)], 60000), time + 60000)
    expect(historical.records[0].seen).toBe(true)
    expect(historical.gap).toBe(true)
    const base = refreshMonitoring(null, snapshot([run(2, "running")]), time)
    const failed = refreshMonitoring(base, snapshot([run(2)], 60000), time + 60000)
    const outside = refreshMonitoring(failed, snapshot([run(3, "success", 120000)], 120000), time + 120000)
    expect(monitorDisplay(outside, time + 120000).text).toBe("1")
    expect(outside.records.find(record => record.id === run(2).id)?.seen).toBe(false)
  })
  it("rejects old snapshots, preserves cursor, and never regresses terminal jobs", () => {
    const base = refreshMonitoring(null, snapshot([run(1, "running")]), time)
    const newer = refreshMonitoring(base, snapshot([run(1), run(2, "success", 60000)], 60000), time + 60000)
    expect(refreshMonitoring(newer, snapshot([run(1, "running")]), time + 70000)).toBe(newer)
    const repeated = refreshMonitoring(newer, snapshot([run(1, "running")], 90000), time + 90000)
    expect(repeated.cursor).toBe(newer.cursor)
    expect(repeated.records.find(item => item.id === run(1).id)?.status).toBe("failed")
  })
  it("shows gaps after sleep, lost window overlap, and retention overflow", () => {
    const base = refreshMonitoring(null, snapshot([run(1)]), time)
    expect(monitorDisplay(base, time + 120001).text).toBe("ST")
    const delayed = refreshMonitoring(base, snapshot([], 180000), time + 180000)
    expect(delayed.gap).toBe(true)
    expect(monitorDisplay(delayed, time + 180000).text).toBe("GAP")
    const lost = refreshMonitoring(base, snapshot(Array.from({ length: 100 }, (_, i) => run(i + 2, "failed", 60000)), 60000), time + 60000)
    expect(lost.gap).toBe(true)
    let retained = base
    for (let page = 0; page < 11; page++) retained = refreshMonitoring(retained, snapshot(Array.from({ length: 100 }, (_, i) => run(2 + page * 100 + i, "failed", page * 60000)), page * 60000), time + page * 60000)
    expect(retained.records).toHaveLength(1000)
    expect(retained.gap).toBe(true)
    expect(retained.records.every(item => item.status === "failed" && !item.seen)).toBe(true)
  })
  it("scopes state and validates stored data without retaining private fields", () => {
    const base = refreshMonitoring(null, snapshot([run(1)]), time)
    expect(refreshMonitoring(base, { ...snapshot([run(2)]), workspace: "other" }, time).records[0].seen).toBe(true)
    for (const invalid of [{ ...base, secret: "invalid" }, { ...base, records: [{ ...base.records[0], name: "private" }] }, { ...base, records: [base.records[0], base.records[0]] }, { ...base, cursor: "invalid" }]) expect(isMonitoring(invalid)).toBe(false)
  })
})

describe("durable worker monitoring", () => {
  it("disconnect clears a pre-baseline error and cancels its pending retry", async () => {
    const c = setup()
    await c.storage.set({ connection: { instance: snapshot([]).instance, workspace: "fixture" } })
    const failed = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(1))
    c.ports[0].reply({ ok: false, code: "authentication_expired" })
    await failed
    const retry = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(2))
    await c.worker({ type: "connection:disconnect" }, sender)
    c.ports[1].reply(snapshot([run(1)]))
    await retry
    await c.restart().restore()
    expect(c.state()).toEqual({})
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
    expect(c.services.alarms.clear).toHaveBeenCalledWith(MONITOR_ALARM)
  })
  it.each(["poll", "refresh"])("persists pre-baseline errors through restart and baselines recovery via %s", async method => {
    const c = setup()
    await c.storage.set({ connection: { instance: snapshot([]).instance, workspace: "fixture" } })
    for (const [index, code, text] of [[0, "authentication_expired", "ERR"], [1, "network_failure", "ST"]] as const) {
      const pending = method === "poll" ? c.worker.poll() : c.worker({ type: "connection:refresh" }, sender)
      await vi.waitFor(() => expect(c.ports).toHaveLength(index + 1))
      c.ports[index].reply({ ok: false, code })
      await pending
      expect(c.state().monitoring).toMatchObject({ lastSuccess: 0, error: code, records: [] })
      expect(isMonitoring(c.state().monitoring)).toBe(true)
      await c.restart().restore()
      expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text })
    }
    const restarted = c.restart()
    const recovered = method === "poll" ? restarted.poll() : restarted({ type: "connection:refresh" }, sender)
    await vi.waitFor(() => expect(c.ports).toHaveLength(3))
    c.ports[2].reply(snapshot([run(1), run(2, "running")]))
    await recovered
    expect(c.state().monitoring).toMatchObject({ lastSuccess: time, error: null, gap: true,
      records: expect.arrayContaining([expect.objectContaining({ id: run(1).id, seen: true }), expect.objectContaining({ id: run(2).id, seen: false })]) })
    const next = restarted.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(4))
    c.ports[3].reply(snapshot([run(1), run(2)], 60000))
    await next
    expect((c.state().monitoring as { records: { status: string; seen: boolean }[] }).records.filter(record => record.status === "failed" && !record.seen)).toHaveLength(1)
  })
  it("restores alarms, coalesces polls, and survives worker restart", async () => {
    const c = setup()
    await c.connect()
    expect(c.services.alarms.create).toHaveBeenCalledWith(MONITOR_ALARM, { periodInMinutes: 1 })
    const pending = c.worker.poll()
    expect(c.worker.poll()).toBe(pending)
    await vi.waitFor(() => expect(c.ports).toHaveLength(2))
    c.clock(time + 60000)
    c.ports[1].reply(snapshot([run(1), run(2)], 60000))
    await pending
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "1" })
    const restarted = c.restart()
    await c.services.alarms.clear()
    await restarted.restore()
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "1" })
    expect((await restarted({ type: "connection:monitor" }, sender) as { monitoring: unknown }).monitoring).toEqual(c.state().monitoring)
  })
  it("UI refresh cancels a poll and late replies cannot regress durable state", async () => {
    const c = setup()
    await c.connect()
    const poll = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(2))
    const ui = c.worker({ type: "connection:refresh" }, sender)
    await vi.waitFor(() => expect(c.ports).toHaveLength(3))
    c.ports[2].reply(snapshot([run(2), run(3, "failed", 60000)], 60000))
    await ui
    c.ports[1].reply(snapshot([run(2, "running")]))
    await poll
    expect(c.state().monitoring).toMatchObject({ cursor: new Date(time + 60000).toISOString() })
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "2" })
  })
  it("only successful selected failure inspection marks seen and refresh cannot restore its count", async () => {
    const c = setup()
    await c.connect()
    let poll = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(2))
    c.ports[1].reply(snapshot([run(2)], 60000)); await poll
    const selection = { instance: snapshot([]).instance, workspace: "fixture", runId: run(2).id }
    const detail = { ok: true, ...selection, detail: { run: run(2), logs: { state: "unavailable" }, inputs: { state: "unavailable" }, result: { state: "unavailable" }, steps: { state: "unavailable" } } }
    let inspection = c.worker({ type: "connection:inspect", selection }, sender)
    await vi.waitFor(() => expect(c.ports).toHaveLength(3))
    c.ports[2].reply(detail); await inspection
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "1" })
    await c.worker({ type: "connection:select", selection }, sender)
    inspection = c.worker({ type: "connection:inspect", selection }, sender)
    await vi.waitFor(() => expect(c.ports).toHaveLength(4))
    c.ports[3].reply(detail); await inspection
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
    poll = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(5))
    c.ports[4].reply(snapshot([run(2)], 120000)); await poll
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
  })
  it("serializes a seen write against a simultaneous list response", async () => {
    const c = setup(); await c.connect()
    const selection = { instance: snapshot([]).instance, workspace: "fixture", runId: run(2).id }
    await c.worker({ type: "connection:select", selection }, sender)
    const inspection = c.worker({ type: "connection:inspect", selection }, sender)
    const refresh = c.worker({ type: "connection:refresh" }, sender)
    await vi.waitFor(() => expect(c.ports).toHaveLength(3))
    const original = c.storage.set.getMockImplementation()!
    let release: () => Promise<void> = async () => { throw new Error("Missing gated write") }
    c.storage.set.mockImplementationOnce(value => new Promise<void>(resolve => { release = async () => { await original(value); resolve() } }))
    c.ports[2].reply(snapshot([run(2)], 60000))
    await vi.waitFor(() => expect(c.storage.set).toHaveBeenCalledTimes(3))
    c.ports[1].reply({ ok: true, ...selection, detail: { run: run(2), logs: { state: "unavailable" }, inputs: { state: "unavailable" }, result: { state: "unavailable" }, steps: { state: "unavailable" } } })
    await release()
    expect(await inspection).toMatchObject({ ok: true })
    expect(await refresh).toMatchObject({ ok: true })
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
  })
  it("remembers inspection of a failed identity absent from the monitoring window", async () => {
    const c = setup(); await c.connect()
    const selection = { instance: snapshot([]).instance, workspace: "fixture", runId: run(9).id }
    await c.worker({ type: "connection:select", selection }, sender)
    const inspection = c.worker({ type: "connection:inspect", selection }, sender)
    await vi.waitFor(() => expect(c.ports).toHaveLength(2))
    c.ports[1].reply({ ok: true, ...selection, detail: { run: run(9), logs: { state: "unavailable" }, inputs: { state: "unavailable" }, result: { state: "unavailable" }, steps: { state: "unavailable" } } })
    await inspection
    const poll = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(3))
    c.ports[2].reply(snapshot([run(9)], 60000)); await poll
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
    await c.worker({ type: "connection:disconnect" }, sender)
    await c.worker.failureIndicator()
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
  })
  it("errors remain distinct and disconnect clears alarms, ports, badge, and state", async () => {
    const c = setup()
    await c.connect()
    for (const [code, text] of [["authentication_expired", "ERR"], ["network_failure", "ST"]]) {
      const count = c.ports.length
      const pending = c.worker.poll()
      await vi.waitFor(() => expect(c.ports).toHaveLength(count + 1))
      c.ports[count].reply({ ok: false, code }); await pending
      expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text })
    }
    const pending = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(4))
    await c.worker({ type: "connection:disconnect" }, sender)
    c.ports[3].reply(snapshot([run(2)], 60000)); await pending
    expect(c.state()).toEqual({})
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" })
    expect(c.services.alarms.clear).toHaveBeenCalledWith(MONITOR_ALARM)
    const count = c.ports.length
    await c.worker.poll()
    expect(c.ports).toHaveLength(count)
  })
  it("storage failure propagates and cannot claim a successful poll", async () => {
    const c = setup(); await c.connect()
    c.storage.set.mockRejectedValueOnce(new Error("private diagnostic"))
    const pending = c.worker.poll()
    await vi.waitFor(() => expect(c.ports).toHaveLength(2))
    c.ports[1].reply(snapshot([run(2)], 60000))
    await expect(pending).rejects.toThrow()
    await c.worker.failureIndicator()
    expect(c.services.action.setBadgeText).toHaveBeenLastCalledWith({ text: "ERR" })
    expect(c.state().monitoring).toMatchObject({ snapshotAt: start })
  })
})
