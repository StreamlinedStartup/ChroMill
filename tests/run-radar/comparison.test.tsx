import React from "react"
import { afterEach, expect, it, vi } from "vitest"
import { cleanup, render, screen, act } from "@testing-library/react"
import { difference, isComparisonResponse } from "../../src/comparison"
import RunComparison from "../../src/run-comparison"
import { createLiveWorker } from "../../src/live-worker"

const selection = { instance: "https://fixture.example", workspace: "fixture", runId: "00000000-0000-0000-0000-000000000009" }
const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/sidepanel.html` }
const field = (text: string) => ({ state: "available", text, truncated: false })
const snapshot = (id: string, minute: string, status: string) => ({ version: field("abc1"), detail: {
  run: { id, name: "fixture", path: "f/tests", status, startedAt: `2026-01-01T00:${minute}:00.000Z`, durationMs: 1, trigger: "Unknown" },
  logs: field("<img src=x onerror=globalThis.pwned=true>"), inputs: field('{"a":1}'), result: field("null"), steps: { state: "unavailable" }
} })
const response = { ok: true, ...selection, state: "available", searched: 1, kind: "script", selected: snapshot(selection.runId, "05", "failed"),
  baseline: snapshot(selection.runId.replace(/9$/, "1"), "01", "success") }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it.each(["inputs", "result"])("leaves %s equality unproven for unsupported numeric precision at every depth", label => {
  for (const wrap of [(n: string) => `{\"id\":${n}}`, (n: string) => `{\"nested\":{\"ids\":[${n}]}}`, (n: string) => `[{\"id\":${n}}]`]) {
    expect(difference(field(wrap("9007199254740992")), field(wrap("9007199254740993")), true)).toBe("Unsupported JSON numeric precision. Equality is unproven.")
  }
  const ports: ReturnType<typeof port>[] = []
  vi.stubGlobal("chrome", { runtime: { connect: () => { const p = port(); ports.push(p); return p } } })
  const view = render(<RunComparison selection={selection} />)
  const numeric = structuredClone(response)
  numeric.baseline.detail[label as "inputs" | "result"] = field('{"nested":{"ids":[9007199254740992]}}')
  numeric.selected.detail[label as "inputs" | "result"] = field('{"nested":{"ids":[9007199254740993]}}')
  act(() => ports[0].receive(numeric))
  const section = Array.from(view.container.querySelectorAll(".comparison-field")).find(item => item.querySelector("h3")?.textContent?.toLowerCase() === label)!
  expect(section.querySelector(".difference")?.textContent).toBe("Unsupported JSON numeric precision. Equality is unproven.")
})
it("supports ordinary JSON numbers and numeric strings without losing precision", () => {
  expect(difference(field('{"a":1.25,"b":1e3,"c":0.00001}'), field('{"c":0.00001,"b":1000,"a":1.25}'), true)).toBe("Same")
  expect(difference(field('{"id":"9007199254740992"}'), field('{"id":"9007199254740993"}'), true)).toBe("Changed: id")
  for (const [before, after] of [["1.00000000000000001", "1"], ["1e400", "2e400"], ["1e-400", "0"], ["1.1e-323", "1e-323"], ["-9007199254740992", "-9007199254740993"]]) {
    expect(difference(field(before), field(after), true)).toContain("numeric precision")
  }
})
it("compares key unions deterministically and never treats missing or truncated values as equal", () => {
  expect(difference(field('{"b":2,"a":{"x":1,"y":2}}'), field('{"a":{"y":2,"x":1},"b":2}'), true)).toBe("Same")
  expect(difference(field('{"gone":null,"change":1}'), field('{"new":2,"change":3}'), true)).toBe("Changed: change\nRemoved: gone\nAdded: new")
  expect(difference({ state: "unavailable" }, { state: "unavailable" })).toContain("unproven")
  expect(difference({ ...field("x"), truncated: true }, field("x"))).toContain("Large value")
  expect(difference(field("{bad"), field("{}"), true)).toContain("Unsupported")
})
it("rejects malformed comparisons, cross-workspace data, and invalid baseline order", () => {
  expect(isComparisonResponse(response)).toBe(true)
  expect(isComparisonResponse({ ...response, baseline: response.selected })).toBe(false)
  expect(isComparisonResponse({ ...response, workspace: "../other" })).toBe(false)
  expect(isComparisonResponse({ ...response, searched: 501 })).toBe(false)
  expect(isComparisonResponse({ ...response, baseline: { ...response.baseline, version: field("<script>") } })).toBe(false)
  expect(isComparisonResponse({ ...response, baseline: {} })).toBe(false)
  expect(isComparisonResponse({ ...response, selected: { detail: null } })).toBe(false)
  const early = { ...response.baseline, detail: { ...response.baseline.detail, run: { ...response.baseline.detail.run, startedAt: "2026-01-01T00:05:00.000001Z" } } }
  const late = { ...response.selected, detail: { ...response.selected.detail, run: { ...response.selected.detail.run, startedAt: "2026-01-01T00:05:00.000002Z" } } }
  expect(isComparisonResponse({ ...response, baseline: early, selected: late })).toBe(true)
  expect(isComparisonResponse({ ...response, baseline: early })).toBe(false)
})
function port(name = "run-radar-compare") {
  let receive: (value: unknown) => void = () => {}
  let close: () => void = () => {}
  return { name, sender, postMessage: vi.fn(), disconnect: vi.fn(),
    onMessage: { addListener: (fn: typeof receive) => { receive = fn } },
    onDisconnect: { addListener: (fn: typeof close) => { close = fn } },
    receive: (value: unknown) => receive(value), close: () => close() }
}
it("renders hostile text without elements and ignores late replies after a selection change", async () => {
  const ports: ReturnType<typeof port>[] = []
  vi.stubGlobal("chrome", { runtime: { connect: () => { const p = port(); ports.push(p); return p } } })
  const view = render(<RunComparison selection={selection} />)
  act(() => ports[0].receive(response))
  expect(screen.getAllByText("<img src=x onerror=globalThis.pwned=true>").length).toBe(2)
  expect(view.container.querySelector("img")).toBeNull()
  view.rerender(<RunComparison selection={{ ...selection, runId: selection.runId.replace(/9$/, "2") }} />)
  expect(ports[0].disconnect).toHaveBeenCalledOnce()
  act(() => ports[0].receive(response))
  expect(screen.getByText("Searching accessible retained history...")).toBeTruthy()
  view.unmount()
  expect(ports[1].disconnect).toHaveBeenCalledOnce()
})
it.each(["selection", "disconnect", "panel"])("worker cancels comparison on %s and ignores late native results", async reason => {
  const native = port("native")
  const runtime = { id: sender.id, connectNative: vi.fn(() => native) }
  let state: Record<string, unknown> = { connection: { instance: selection.instance, workspace: selection.workspace }, selection }
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, {
    get: async () => state, set: async (value: object) => { state = { ...state, ...value } }, clear: async () => { state = {} }
  } as unknown as chrome.storage.StorageArea)
  const panel = port()
  worker.follow(panel as unknown as chrome.runtime.Port)
  panel.receive({ selection })
  await vi.waitFor(() => expect(native.postMessage).toHaveBeenCalled())
  if (reason === "panel") panel.close()
  else await worker(reason === "disconnect" ? { type: "connection:disconnect" } : { type: "connection:select", selection: { ...selection, runId: selection.runId.replace(/9$/, "2") } }, sender)
  native.receive(response)
  await vi.waitFor(() => expect(native.disconnect).toHaveBeenCalledOnce())
  expect(panel.postMessage).not.toHaveBeenCalled()
})
it("worker rejects a comparison outside the saved workspace before native dispatch", async () => {
  const runtime = { id: sender.id, connectNative: vi.fn() }
  const worker = createLiveWorker(runtime as unknown as typeof chrome.runtime, { get: async () => ({ connection: { instance: selection.instance, workspace: "other" }, selection }) } as unknown as chrome.storage.StorageArea)
  const panel = port()
  worker.follow(panel as unknown as chrome.runtime.Port)
  panel.receive({ selection })
  await vi.waitFor(() => expect(panel.postMessage).toHaveBeenCalledWith({ ok: false, code: "request_invalid" }))
  expect(runtime.connectNative).not.toHaveBeenCalled()
})
