import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import RunInspection from "../../src/run-inspection"
import { isInspectionResponse, isSelection, runUrl } from "../../src/inspection"

const first = { instance: "https://fixture.example", workspace: "fixture", runId: "00000000-0000-0000-0000-000000000001" }
const second = { ...first, runId: "00000000-0000-0000-0000-000000000002" }
const field = { state: "available", text: '<img src=x onerror="globalThis.pwned=true">', truncated: false }
const response = (selection = first) => ({ ...selection, ok: true, detail: {
  run: { id: selection.runId, name: selection.runId, path: "f/tests/run", status: "success", durationMs: 250, trigger: "Unknown", startedAt: "2026-01-01T00:00:00.000Z" },
  logs: field, inputs: field, result: field, steps: { state: "unavailable" }
} })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
describe("run inspection", () => {
  it("validates exact identities and bounded fields", () => {
    expect(isSelection(first)).toBe(true)
    expect(isSelection({ ...first, runId: "../admin" })).toBe(false)
    expect(isInspectionResponse(response())).toBe(true)
    expect(isInspectionResponse({ ...response(), detail: { ...response().detail, logs: { ...field, text: "x".repeat(64001) } } })).toBe(false)
    expect(isInspectionResponse({ ...response(), runId: second.runId })).toBe(false)
    expect(runUrl(first)).toBe(`https://fixture.example/run/${first.runId}?workspace=fixture`)
  })
  it("renders malicious logs, inputs and results only as text", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => response()) } })
    const { container } = render(<RunInspection selection={first} />)
    await waitFor(() => expect(container.querySelectorAll("pre")).toHaveLength(3))
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
    expect(screen.getByText("Unavailable for this run.")).toBeTruthy()
  })
  it.each([false, true])("shows Result before Logs with compact=%s", async compact => {
    const value = { ...response(), detail: { ...response().detail, result: { state: "available", text: '{"new":0,"total":4}', truncated: false } } }
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => value) } })
    const view = render(<RunInspection selection={first} compact={compact} />)
    await screen.findByRole("heading", { name: "Result" })
    expect(Array.from(view.container.querySelectorAll(".detail-field h2")).map(node => node.textContent)).toEqual(compact ? ["Result", "Logs"] : ["Result", "Logs", "Inputs", "Flow steps"])
    expect(screen.getByText('{"new":0,"total":4}')).toBeTruthy()
  })
  it.each(["false", "0", "null"])("preserves the result %s in the popup", async text => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => ({ ...response(), detail: { ...response().detail, result: { state: "available", text, truncated: false } } })) } })
    render(<RunInspection selection={first} compact />)
    expect(await screen.findByText(text)).toBeTruthy()
  })
  it.each([false, true])("reports unavailable and truncated results with compact=%s", async compact => {
    const value = response()
    value.detail.result = { state: "unavailable" } as typeof field
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => value) } })
    const view = render(<RunInspection selection={first} compact={compact} />)
    await screen.findByRole("heading", { name: "Result" })
    expect(view.container.querySelector('.detail-field')?.textContent).toContain("Unavailable for this run.")
    value.detail.result = { ...field, text: "x".repeat(32000), truncated: true }
    cleanup()
    render(<RunInspection selection={first} compact={compact} />)
    expect(await screen.findByText(/Only the first 32,000 characters/)).toBeTruthy()
  })
  it("a slow response cannot replace a newer selection", async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(message => message.selection.runId === first.runId ? new Promise(resolve => { resolveFirst = resolve }) : Promise.resolve(response(second))) } })
    const view = render(<RunInspection selection={first} />)
    expect(screen.getByRole("status").textContent).toContain("Loading")
    view.rerender(<RunInspection selection={second} />)
    await screen.findByRole("heading", { name: second.runId })
    resolveFirst(response())
    await waitFor(() => expect(screen.queryByRole("heading", { name: first.runId })).toBeNull())
  })
  it("shows forbidden, deleted and error responses explicitly", async () => {
    const send = vi.fn(async () => ({ ok: false, code: "forbidden" }))
    vi.stubGlobal("chrome", { runtime: { sendMessage: send } })
    const view = render(<RunInspection selection={first} />)
    expect((await screen.findByRole("alert")).textContent).toContain("forbidden")
    send.mockResolvedValue({ ok: false, code: "deleted" })
    view.rerender(<RunInspection selection={second} />)
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("deleted"))
  })
})

describe("panel follow UI", () => {
  it("replaces fragmented snapshots, retries from the saved offset and ignores closed ports", async () => {
    const ports: { reply: (value: unknown) => void; drop: () => void; postMessage: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal("chrome", { runtime: { connect: () => {
      const port = { reply: (() => {}) as (value: unknown) => void, drop: () => {}, postMessage: vi.fn(), disconnect: vi.fn() }
      ports.push(port)
      return { ...port, onMessage: { addListener: (fn: typeof port.reply) => { port.reply = fn } }, onDisconnect: { addListener: (fn: () => void) => { port.drop = fn } } }
    } } })
    const view = render(<RunInspection selection={first} follow />)
    expect(screen.getAllByRole("status")[0].textContent).toContain("Compatible polling")
    const snapshot = (text: string) => ({ ...response(), detail: { ...response().detail, run: { ...response().detail.run, status: "running" }, logs: { ...field, text } }, offsets: { start: 0, end: Array.from(text).length } })
    act(() => ports[0].reply(snapshot("par")))
    act(() => ports[0].reply(snapshot("partial\né")))
    expect(view.container.querySelector('[data-field="Logs"] pre')?.textContent).toBe("partial\né")
    act(() => ports[0].reply({ ok: false, code: "authentication_expired" }))
    expect(screen.getByRole("alert").textContent).toContain("Authentication expired")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(ports[1].postMessage).toHaveBeenCalledWith({ selection: first, offset: 9 })
    act(() => ports[0].reply(snapshot("late old reply")))
    expect(view.container.querySelector("pre")).toBeNull()
    act(() => ports[1].reply(response()))
    expect(screen.getAllByRole("status")[0].textContent).toContain("Run completed")
    view.unmount()
    expect(ports[1].disconnect).toHaveBeenCalled()
  })
})
