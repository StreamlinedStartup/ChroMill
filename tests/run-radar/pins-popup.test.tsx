import React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import Popup from "../../src/popup"

const connection = { instance: "https://fixture.example", workspace: "fixture" }
const selection = { ...connection, runId: "00000000-0000-0000-0000-000000000001" }
const run = { id: selection.runId, name: "Pinned fixture", path: "f/test/pin", status: "success", durationMs: 10, trigger: "Unknown", startedAt: "2026-01-01T00:00:00.000Z" }
const detail = { ...selection, ok: true, detail: { run, logs: { state: "available", text: "final log", truncated: false }, inputs: { state: "unavailable" }, result: { state: "unavailable" }, steps: { state: "unavailable" } } }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function setup(code?: string, recentFails = false) {
  let pins = [selection]
  const send = vi.fn(async message => {
    switch (message.type) {
      case "connection:get": return { ok: true, connection }
      case "connection:pins": return { ok: true, connection, pins }
      case "connection:refresh": return recentFails ? { ok: false, code: "network_failure" } : { ...connection, ok: true, mode: "live", snapshotAt: run.startedAt, runs: [] }
      case "connection:inspect": return code ? { ok: false, code } : detail
      case "connection:select": return { ok: true }
      case "connection:unpin": pins = []; return { ok: true, connection, pins }
      default: return { ok: false, code: "request_invalid" }
    }
  })
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } })
  return send
}
describe("pinned popup", () => {
  it("opens a persisted pin absent from recent history, returns focus and unpins", async () => {
    const send = setup()
    const user = userEvent.setup()
    render(<Popup />)
    await user.click(await screen.findByRole("button", { name: "Pinned (1)" }))
    await user.click(await screen.findByRole("button", { name: /Pinned fixture/ }))
    expect(await screen.findByText("final log")).toBeTruthy()
    expect(send).toHaveBeenCalledWith({ type: "connection:select", selection })
    await user.click(screen.getByRole("button", { name: "Back" }))
    await waitFor(() => expect(document.activeElement?.id).toBe(`run-${selection.runId}`))
    await user.click(screen.getByRole("button", { name: `Unpin run ${selection.runId}` }))
    await screen.findByText(/No pinned runs match/)
  })
  it.each(["deleted", "forbidden", "network_failure"])("shows %s and permits removal without successful inspection", async code => {
    const send = setup(code)
    const user = userEvent.setup()
    render(<Popup />)
    await user.click(await screen.findByRole("button", { name: "Pinned (1)" }))
    await waitFor(() => expect(document.getElementById(`run-${selection.runId}`)?.textContent).toContain(code === "network_failure" ? "unreachable" : code))
    await user.click(screen.getByRole("button", { name: `Unpin run ${selection.runId}` }))
    await screen.findByText(/No pinned runs match/)
    expect(send).toHaveBeenCalledWith({ type: "connection:unpin", selection })
  })
  it("keeps live inspection available when pin storage returns an error", async () => {
    const send = setup()
    const original = send.getMockImplementation()!
    send.mockImplementation(async message => message.type === "connection:pins" ? { ok: false, code: "helper_failure" } : message.type === "connection:refresh" ? { ...connection, ok: true, mode: "live", snapshotAt: run.startedAt, runs: [run] } : original(message))
    render(<Popup />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /Pinned fixture/ }))
    await screen.findByText("final log")
    expect(screen.queryByText(/Demo run selected/)).toBeNull()
  })
  it("keeps pins usable after recent-page retrieval fails", async () => {
    setup(undefined, true)
    render(<Popup />)
    await screen.findByRole("alert")
    await userEvent.setup().click(screen.getByRole("button", { name: "Pinned (1)" }))
    await screen.findByRole("button", { name: /Pinned fixture/ })
  })
})
