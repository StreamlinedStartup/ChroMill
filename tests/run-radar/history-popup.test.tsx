import React from "react"
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import Popup from "../../src/popup"
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const scope = { instance: "https://fixture.example", workspace: "fixture" }
const run = { id: "00000000-0000-0000-0000-000000000001", name: "old", path: "f/tests/old", status: "success", durationMs: 5, trigger: "Manual", startedAt: "2026-01-01T00:00:00Z" }
const snapshot = { ok: true, mode: "live", ...scope, snapshotAt: "2026-10-04T00:00:00Z", runs: [] }
function setup() {
  let connection: typeof scope | null = scope
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>()
  const history = vi.fn(async (page: number, flowPath: string | null, flowKind: "script" | "flow" | null) => ({ ...snapshot, page, flowPath, flowKind, hasMore: page === 1, runs: page === 1 ? [{ ...run, jobKind: flowKind ?? "flow" }] : [] }))
  const catalog = vi.fn(async (page: number): Promise<{ ok: true; instance: string; workspace: string; page: number; hasMore: boolean; flows: { path: string; summary: string; kind: "flow" | "script" }[] }> => ({ ok: true, ...scope, page, hasMore: false, flows: [{ path: run.path, summary: "Old payroll", kind: "flow" }] }))
  const send = vi.fn(async (message: { type: string; page?: number; flowPath?: string | null; flowKind?: "script" | "flow" | null }) => {
    switch (message.type) {
      case "connection:get": return { ok: true, connection }
      case "connection:pins": return { ok: true, connection, pins: [] }
      case "connection:refresh": return { ...snapshot, ...connection }
      case "demo:list": return { ok: true, mode: "demo", snapshotAt: snapshot.snapshotAt, runs: [] }
      case "connection:timezone": return { ok: true, timezone: "UTC" }
      case "connection:flows": return catalog(message.page!)
      case "connection:history": return history(message.page!, message.flowPath!, message.flowKind!)
      default: return { ok: false, code: "request_invalid" }
    }
  })
  vi.stubGlobal("chrome", { runtime: { sendMessage: send }, storage: { local: { get: async () => ({ connection, timezone: "UTC" }) }, onChanged: {
    addListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.add(listener), removeListener: (listener: typeof listeners extends Set<infer T> ? T : never) => listeners.delete(listener)
  } } })
  return { send, history, catalog, changed: (changes: Record<string, unknown>) => {
    if (changes.connection) connection = (changes.connection as { newValue: typeof scope | null }).newValue
    listeners.forEach(listener => listener(changes, "local"))
  } }
}
it("finds a flow by summary outside recent runs and keeps older/newer pages restricted", async () => {
  const c = setup(); render(<Popup />)
  await screen.findByText(/No recent top-level runs/)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "payroll" } })
  fireEvent.click(await screen.findByRole("button", { name: /Old payroll/ }))
  await screen.findByText("old")
  expect(c.history).toHaveBeenLastCalledWith(1, run.path, "flow")
  fireEvent.click(screen.getByRole("button", { name: "Older" }))
  await screen.findByText("Final page")
  await screen.findByText("No runs on this history page.")
  expect(c.history).toHaveBeenLastCalledWith(2, run.path, "flow")
  expect((screen.getByRole("button", { name: "Older" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "Newer" }))
  await screen.findByText("old")
  expect(c.history).toHaveBeenLastCalledWith(1, run.path, "flow")
  fireEvent.click(screen.getByRole("button", { name: "Workspace history" }))
  await waitFor(() => expect(c.history).toHaveBeenLastCalledWith(1, null, null))
})
it("keeps equal paths selectable by kind and drops late flow history after script selection", async () => {
  const c = setup()
  c.catalog.mockResolvedValue({ ok: true, ...scope, page: 1, hasMore: false, flows: [
    { path: run.path, summary: "Shared payroll", kind: "flow" }, { path: run.path, summary: "Shared payroll", kind: "script" }
  ] })
  let settle!: (value: Awaited<ReturnType<typeof c.history>>) => void
  c.history.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Find scripts and flows" }))
  fireEvent.click(await screen.findByRole("button", { name: /FlowShared payroll/ }))
  await waitFor(() => expect(c.history).toHaveBeenLastCalledWith(1, run.path, "flow"))
  fireEvent.click(screen.getByRole("button", { name: "Find scripts and flows" }))
  fireEvent.click(await screen.findByRole("button", { name: /ScriptShared payroll/ }))
  await screen.findByText("old")
  expect(c.history).toHaveBeenLastCalledWith(1, run.path, "script")
  expect(screen.getByText("Script", { selector: ".kind-pill" })).toBeTruthy()
  await act(async () => settle({ ...snapshot, page: 1, flowPath: run.path, flowKind: "flow", hasMore: false, runs: [{ ...run, name: "stale flow", jobKind: "flow" }] }))
  expect(screen.queryByText("stale flow")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Older" }))
  await screen.findByText("Final page")
  expect(c.history).toHaveBeenLastCalledWith(2, run.path, "script")
})
it("deduplicates script versions across pages without losing equal flow paths", async () => {
  const c = setup()
  c.catalog.mockImplementation(async page => ({ ok: true, ...scope, page, hasMore: page === 1, flows: page === 1 ? [
    { path: run.path, summary: "Latest script", kind: "script" }
  ] : [{ path: run.path, summary: "Older script", kind: "script" }, { path: run.path, summary: "Flow summary", kind: "flow" }] }))
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Find scripts and flows" }))
  await screen.findByText("Catalog complete: 2 scripts and flows")
  expect(screen.getByRole("button", { name: /Latest script/ })).toBeTruthy()
  expect(screen.getByRole("button", { name: /Flow summary/ })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Older script/ })).toBeNull()
})
it("labels script, flow, unsupported, and absent run kinds truthfully in history", async () => {
  const c = setup()
  c.history.mockResolvedValue({ ...snapshot, page: 1, flowPath: null, flowKind: null, hasMore: false, runs: [
    { ...run, id: "run1", jobKind: "script" }, { ...run, id: "run2", jobKind: "flow" },
    { ...run, id: "run3", jobKind: "preview" }, { ...run, id: "run4" }
  ] } as never)
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Workspace history" }))
  for (const label of ["Script", "Flow", "Other", "Unknown"]) await screen.findByText(label, { selector: ".kind-pill" })
})
it.each(["query", "flow", "credentials", "connection", "workspace"])("rejects a late history result after %s changes", async change => {
  const c = setup(); let settle!: (value: Awaited<ReturnType<typeof c.history>>) => void
  c.history.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Workspace history" }))
  await waitFor(() => expect(c.history).toHaveBeenCalledTimes(1))
  if (change === "query") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "different" } })
  if (change === "flow") {
    fireEvent.click(screen.getByRole("button", { name: "Find scripts and flows" }))
    fireEvent.click(await screen.findByRole("button", { name: /Old payroll/ }))
    await screen.findByText("old")
  }
  if (change === "credentials" || change === "connection") await act(async () => c.changed(change === "credentials" ? { encryptedCredentials: { newValue: {} } } : { connection: { oldValue: scope, newValue: null } }))
  if (change === "workspace") await act(async () => c.changed({ connection: { oldValue: scope, newValue: { ...scope, workspace: "second" } } }))
  await act(async () => settle({ ...snapshot, page: 1, flowPath: null, flowKind: null, hasMore: false, runs: [{ ...run, name: "stale result", jobKind: "flow" }] }))
  expect(screen.queryByText("stale result")).toBeNull()
})
it("keeps catalog and history failures explicit and retries the same history page", async () => {
  const c = setup(); c.catalog.mockResolvedValueOnce({ ok: false, code: "access_denied" } as never)
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Find scripts and flows" }))
  await screen.findByText("Lookup incomplete")
  expect(screen.queryByText("No accessible scripts or flows match.")).toBeNull()
  c.history.mockResolvedValueOnce({ ok: false, code: "network_failure" } as never)
  fireEvent.click(screen.getByRole("button", { name: "Workspace history" }))
  await screen.findByText("History unavailable")
  fireEvent.click(screen.getByRole("button", { name: "Try again" }))
  await screen.findByText("old")
  expect(c.history).toHaveBeenLastCalledWith(1, null, null)
})
it("reports catalog coverage limits and never claims a complete no-match result", async () => {
  const c = setup()
  c.catalog.mockImplementation(async page => ({ ok: true, ...scope, page, hasMore: true,
    flows: Array.from({ length: 100 }, (_, i) => ({ path: `f/tests/page_${page}_${i}`, summary: `Catalog ${i}`, kind: "flow" as const })) }))
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent" } })
  await screen.findByText(/Lookup limited to 2,000 script rows/)
  expect(c.catalog).toHaveBeenCalledTimes(20)
  expect(screen.queryByText("No accessible scripts or flows match.")).toBeNull()
  expect(screen.getByText("No matches in loaded scripts and flows yet.")).toBeTruthy()
})
it("drops an outdated catalog page after a new query", async () => {
  const c = setup(); let settle!: (value: Awaited<ReturnType<typeof c.catalog>>) => void
  c.catalog.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
  render(<Popup />); await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Find scripts and flows" }))
  await waitFor(() => expect(c.catalog).toHaveBeenCalledTimes(1))
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "payroll" } })
  await screen.findByRole("button", { name: /Old payroll/ })
  await act(async () => settle({ ok: true, ...scope, page: 1, hasMore: false, flows: [{ path: "f/tests/stale", summary: "Stale payroll", kind: "flow" as const }] }))
  expect(screen.queryByRole("button", { name: /Stale payroll/ })).toBeNull()
})
