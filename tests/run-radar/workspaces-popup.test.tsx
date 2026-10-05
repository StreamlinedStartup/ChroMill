import React from "react"
import { afterEach, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import Popup from "../../src/popup"
import type { Connection } from "../../src/connection"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function setup(populated = false) {
  let connection: Connection | null = { instance: "https://fixture.example", workspace: "alpha" }
  const listeners = new Set<(changes: unknown, area: string) => void>()
  let switchReply!: (value: unknown) => void
  let switchSnapshot: unknown
  let discoveryReply!: (value: unknown) => void
  let holdDiscovery = false
  const runId = "00000000-0000-0000-0000-000000000003"
  const snapshot = () => ({ ok: true, mode: "live", ...connection, snapshotAt: "2026-10-04T00:00:00.000Z", runs: populated && connection ? [{
    id: runId, name: `${connection.workspace} run`, path: `f/${connection.workspace}/run`, status: "running", durationMs: 1000,
    trigger: "Manual", startedAt: "2026-10-03T00:00:00.000Z"
  }] : [] })
  const change = (workspace: string | null, instance = "https://fixture.example") => {
    const oldValue = connection
    connection = workspace ? { instance, workspace } : null
    for (const listener of listeners) listener({ connection: { oldValue, newValue: connection } }, "local")
  }
  const send = vi.fn(async (message: { type: string; workspace?: string }) => {
    switch (message.type) {
      case "connection:get": return { ok: true, connection }
      case "connection:pins": return { ok: true, connection, pins: populated && connection ? [{ ...connection, runId }] : [] }
      case "connection:refresh": return snapshot()
      case "demo:list": return { ok: true, mode: "demo", runs: [], snapshotAt: "2026-10-04T00:00:00.000Z" }
      case "connection:workspaces": return holdDiscovery ? new Promise(resolve => { discoveryReply = resolve }) : { ok: true, instance: connection?.instance, workspaces: ["alpha", "beta"] }
      case "connection:switch": change(message.workspace!); switchSnapshot = snapshot(); return new Promise(resolve => { switchReply = resolve })
      case "connection:disconnect": change(null); return { ok: true, connection: null }
      default: throw new Error(`Unexpected operation: ${message.type}`)
    }
  })
  vi.stubGlobal("chrome", { runtime: { sendMessage: send }, storage: { local: { get: async () => ({ connection, timezone: "UTC" }) }, onChanged: {
    addListener: (listener: (changes: unknown, area: string) => void) => listeners.add(listener),
    removeListener: (listener: (changes: unknown, area: string) => void) => listeners.delete(listener)
  } } })
  return { change, send, hold: () => { holdDiscovery = true }, resume: () => { holdDiscovery = false },
    settleDiscovery: () => discoveryReply({ ok: false, code: "request_canceled" }), settleSwitch: (success = false) => switchReply(success ? switchSnapshot : { ok: false, code: "request_canceled" }) }
}

it.each(["switch", "disconnect"])("processes external %s after refresh supersedes a delayed switch", async action => {
  const c = setup(); render(<Popup />)
  await screen.findByText(/No recent top-level runs/)
  fireEvent.click(screen.getByRole("button", { name: "Workspaces" }))
  await screen.findByRole("option", { name: "beta" })
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } })
  fireEvent.click(screen.getByRole("button", { name: "Refresh live runs" }))
  await screen.findByText(/No recent top-level runs/)
  await act(async () => { c.settleSwitch(); c.change(action === "switch" ? "alpha" : null) })
  await screen.findByText(action === "switch" ? "https://fixture.example / alpha" : "Demo mode")
  expect(screen.queryByText("https://fixture.example / beta")).toBeNull()
  expect(screen.queryByRole("button", { name: /Unpin run/ })).toBeNull()
})

it.each(["switch", "disconnect"])("allows discovery after an external %s cancels discovery and reconnects", async action => {
  const c = setup(); render(<Popup />)
  await screen.findByText(/No recent top-level runs/)
  c.hold(); fireEvent.click(screen.getByRole("button", { name: "Workspaces" }))
  await screen.findByRole("button", { name: "Loading..." })
  await act(async () => c.change(action === "switch" ? "beta" : null))
  await screen.findByText(action === "switch" ? "https://fixture.example / beta" : "Demo mode")
  await act(async () => { c.settleDiscovery(); c.resume() })
  if (action === "disconnect") {
    await act(async () => c.change("beta"))
    await screen.findByText("https://fixture.example / beta")
  }
  const button = screen.getByRole("button", { name: "Workspaces" }) as HTMLButtonElement
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2))
  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("beta")
})

it.each([
  ["disconnect", true], ["disconnect", false],
  ["workspace", true], ["workspace", false],
  ["instance", true], ["instance", false]
] as const)("ignores a late switch reply after external %s (success=%s) without refresh", async (action, success) => {
  const c = setup(true); render(<Popup />)
  await screen.findByText("alpha run")
  expect(screen.getByRole("button", { name: /Unpin run/ })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Workspaces" }))
  await screen.findByRole("option", { name: "beta" })
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } })
  expect(screen.queryByText("alpha run")).toBeNull()
  expect(screen.queryByRole("button", { name: /Unpin run/ })).toBeNull()
  await act(async () => c.change(action === "disconnect" ? null : "alpha",
    action === "instance" ? "https://other.example" : "https://fixture.example"))
  await screen.findByText(action === "disconnect" ? "Demo mode" :
    `${action === "instance" ? "https://other.example" : "https://fixture.example"} / alpha`)
  if (action !== "disconnect") await screen.findByText("alpha run")
  await act(async () => c.settleSwitch(success))
  expect(screen.queryByText("beta run")).toBeNull()
  expect(screen.queryByText("https://fixture.example / beta")).toBeNull()
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  expect(screen.queryByRole("alert")).toBeNull()
  if (action === "disconnect") {
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.queryByRole("button", { name: /Unpin run/ })).toBeNull()
  } else {
    expect(screen.getByText("alpha run")).toBeTruthy()
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
  }
})
