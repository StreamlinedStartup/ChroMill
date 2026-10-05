import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import Popup from "../../src/popup"
import { handleDemoRequest } from "../../src/demo"

const response = handleDemoRequest({ type: "demo:list" }, { id: "test", url: "chrome-extension://test/popup.html" }, "test")
const sendMessage = vi.fn()
beforeEach(() => {
  sendMessage.mockReset().mockImplementation(async message => message.type === "connection:get" ? { ok: true, connection: null } : response)
  vi.stubGlobal("chrome", { runtime: { sendMessage } })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("popup journey", () => {
  it("opens settings without the connection and mode action row", async () => {
    const openOptionsPage = vi.fn().mockResolvedValue(undefined)
    chrome.runtime.openOptionsPage = openOptionsPage
    render(<Popup />)
    await screen.findByText("Sync customer records")
    for (const name of ["Connection", "Live", "Demo", "Disconnect"]) expect(screen.queryByRole("button", { name })).toBeNull()
    await userEvent.setup().click(screen.getByRole("button", { name: "Open settings" }))
    expect(openOptionsPage).toHaveBeenCalledOnce()
  })
  it.each([0, 1])("shows the failure notice only for a positive unseen count (%s)", async count => {
    const connection = { instance: "https://fixture.example", workspace: "fixture" }
    const timestamp = new Date().toISOString()
    const monitoring = { ...connection, cursor: timestamp, snapshotAt: timestamp, lastSuccess: Date.now(), gap: true, error: null,
      records: count ? [{ id: "00000000-0000-0000-0000-000000000001", startedAt: timestamp, status: "failed", seen: false }] : [] }
    vi.stubGlobal("chrome", { runtime: { sendMessage }, storage: { local: { get: async () => ({ connection, monitoring, timezone: "UTC" }) }, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } })
    sendMessage.mockImplementation(async message => message.type === "connection:get" ? { ok: true, connection } : message.type === "connection:pins" ? { ok: true, connection, pins: [] } : { ok: true, mode: "live", ...connection, snapshotAt: timestamp, runs: [] })
    const { container } = render(<Popup />)
    await screen.findByText(/No recent top-level runs/)
    if (count) expect(screen.getByText("1 unseen failure")).toBeTruthy()
    else expect(container.querySelector(".monitor-status")).toBeNull()
    expect(screen.queryByText(/Sampling gap/)).toBeNull()
  })
  it("shows explicit Demo mode and filters and searches by keyboard", async () => {
    const user = userEvent.setup()
    render(<Popup />)
    expect(screen.getByRole("status").textContent).toContain("Loading")
    await screen.findByText("Sync customer records")
    expect(screen.getByText("Demo mode")).toBeTruthy()
    expect(screen.getByText("No live connection")).toBeTruthy()
    expect(screen.getAllByRole("listitem")).toHaveLength(12)
    await user.click(screen.getByRole("button", { name: "Failed (3)" }))
    expect(screen.getAllByRole("listitem")).toHaveLength(3)
    await user.click(screen.getByRole("button", { name: "Running" }))
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    await user.click(screen.getByRole("button", { name: "All runs" }))
    await user.click(screen.getByRole("searchbox"))
    await user.keyboard("019A-8EC4")
    expect(screen.getAllByRole("listitem")).toHaveLength(1)
    await user.clear(screen.getByRole("searchbox"))
    await user.type(screen.getByRole("searchbox"), "does-not-exist")
    expect(screen.getByRole("status").textContent).toContain("No matching runs")
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })
  it("shows empty results from the worker", async () => {
    sendMessage.mockImplementation(async message => message.type === "connection:get" ? { ok: true, connection: null } : { ...response, runs: [] })
    render(<Popup />)
    expect((await screen.findByRole("status")).textContent).toBeTruthy()
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("No matching runs."))
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })
  it("shows errors without fixtures and retries successfully", async () => {
    const user = userEvent.setup()
    sendMessage.mockResolvedValueOnce({ ok: true, connection: null }).mockRejectedValueOnce(new Error("secret internal message"))
    render(<Popup />)
    expect((await screen.findByRole("alert")).textContent).toContain("unavailable")
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.queryByText("secret internal message")).toBeNull()
    await user.click(screen.getByRole("button", { name: "Try again" }))
    await screen.findByText("Sync customer records")
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("ignores a late response after a newer refresh", async () => {
    let resolveOld: (value: unknown) => void = () => { throw new Error("Missing pending request") }
    sendMessage.mockResolvedValueOnce({ ok: true, connection: null }).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const user = userEvent.setup()
    render(<Popup />)
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    await user.click(screen.getByRole("button", { name: "Refresh demo runs" }))
    await screen.findByText("Sync customer records")
    await act(async () => resolveOld({ ok: false, error: "Old response" }))
    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getAllByRole("listitem")).toHaveLength(12)
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3))
  })
  it("reports failed connection metadata without falling back to demo", async () => {
    sendMessage.mockResolvedValue({ ok: false, code: "helper_failure" })
    render(<Popup />)
    expect((await screen.findByRole("alert")).textContent).toContain("helper failed")
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })
  it("retries discovery failures without requesting Demo data", async () => {
    sendMessage.mockResolvedValue({ ok: false, code: "helper_failure" })
    render(<Popup />)
    await screen.findByRole("alert")
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Try again" }))
    await screen.findByRole("alert")
    await user.click(screen.getByRole("button", { name: "Retry connection discovery" }))
    expect((await screen.findByRole("alert")).textContent).toContain("helper failed")
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["connection:get", "connection:get", "connection:get"])
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
    expect(screen.queryByText("Demo mode")).toBeNull()
  })
  it("recovers startup discovery into live mode without a Demo request", async () => {
    const live = { ok: true, mode: "live", instance: "https://fixture.example", workspace: "fixture", snapshotAt: "2026-10-03T18:30:00.000Z", runs: [] }
    sendMessage.mockResolvedValueOnce({ ok: false, code: "helper_failure" })
      .mockResolvedValueOnce({ ok: true, connection: { instance: live.instance, workspace: live.workspace } })
      .mockResolvedValueOnce({ ok: true, connection: { instance: live.instance, workspace: live.workspace }, pins: [] })
      .mockResolvedValueOnce(live)
    render(<Popup />)
    await screen.findByRole("alert")
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }))
    await screen.findByText(/No recent top-level runs/)
    expect(screen.getByText("Live mode")).toBeTruthy()
    expect(screen.queryByRole("alert")).toBeNull()
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual(["connection:get", "connection:get", "connection:pins", "connection:refresh"])
  })
  it("clears live rows on failure and shows empty live history", async () => {
    const live = { ok: true, mode: "live", instance: "https://fixture.example", workspace: "fixture", snapshotAt: "2026-10-03T18:30:00.000Z", runs: [] }
    sendMessage.mockImplementation(async message => message.type === "connection:get" ? { ok: true, connection: { instance: live.instance, workspace: live.workspace } } : message.type === "connection:pins" ? { ok: true, connection: { instance: live.instance, workspace: live.workspace }, pins: [] } : live)
    render(<Popup />)
    await screen.findByText(/No recent top-level runs/)
    sendMessage.mockImplementation(async message => message.type === "connection:pins" ? { ok: true, connection: { instance: live.instance, workspace: live.workspace }, pins: [] } : { ok: false, code: "authentication_expired" })
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh live runs" }))
    expect((await screen.findByRole("alert")).textContent).toContain("Authentication expired")
    expect(screen.queryAllByRole("listitem")).toHaveLength(0)
  })
  it("restores focus after Back and Escape from run metadata", async () => {
    const user = userEvent.setup()
    render(<Popup />)
    const row = await screen.findByRole("button", { name: /Sync customer records/ })
    await user.click(row)
    expect(screen.getByRole("heading", { name: "Sync customer records" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Back" }))
    await waitFor(() => expect(document.activeElement?.id).toBe("run-019a-8f2c"))
    await user.keyboard("{Enter}")
    await screen.findByRole("button", { name: "Back" })
    await user.keyboard("{Escape}")
    await waitFor(() => expect(document.activeElement?.id).toBe("run-019a-8f2c"))
  })

})
