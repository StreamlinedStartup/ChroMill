import React from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { useTimezone } from "../../src/use-timezone"
import { runTime } from "../../src/timezones"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it("updates open fallback views while preserving run-specific dates", async () => {
  let zone = "UTC"
  let changed: (value: Record<string, chrome.storage.StorageChange>, area: string) => void = () => {}
  const removeListener = vi.fn()
  vi.stubGlobal("chrome", { storage: { local: { get: vi.fn(async () => ({ timezone: zone })) }, onChanged: { addListener: (callback: typeof changed) => { changed = callback }, removeListener } } })
  function View() {
    const preference = useTimezone()
    return <><p>{runTime({ startedAt: "2026-01-01T00:00:00Z" }, preference.timezone)}</p><p>{runTime({ startedAt: "2026-01-01T00:00:00Z", timezone: "Asia/Tokyo" }, preference.timezone)}</p></>
  }
  const view = render(<View />)
  await screen.findByText(/2026-01-01 00:00:00 GMT\+0 \(UTC\)/)
  await act(async () => { zone = "America/New_York"; changed({ timezone: { newValue: zone } }, "local") })
  await screen.findByText(/2025-12-31 19:00:00 GMT-5/)
  expect(screen.getByText(/2026-01-01 09:00:00 GMT\+9/)).toBeTruthy()
  view.unmount()
  expect(removeListener).toHaveBeenCalledWith(changed)
})
it("ignores stale preference reads and shows storage errors explicitly", async () => {
  let changed: (value: Record<string, chrome.storage.StorageChange>, area: string) => void = () => {}
  let release: (value: unknown) => void = () => {}
  const get = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve })).mockResolvedValueOnce({ timezone: "Asia/Kathmandu" }).mockRejectedValueOnce(new Error("private diagnostic"))
  vi.stubGlobal("chrome", { storage: { local: { get }, onChanged: { addListener: (callback: typeof changed) => { changed = callback }, removeListener: vi.fn() } } })
  function View() { const preference = useTimezone(); return <p>{preference.timezone} {preference.error}</p> }
  render(<View />)
  await act(async () => { changed({ timezone: { newValue: "Asia/Kathmandu" } }, "local") })
  await screen.findByText("Asia/Kathmandu")
  await act(async () => { release({ timezone: "UTC" }) })
  expect(screen.getByText("Asia/Kathmandu")).toBeTruthy()
  await act(async () => { changed({ timezone: { newValue: "UTC" } }, "local") })
  await screen.findByText(/Timezone preference is unavailable/)
  expect(screen.queryByText(/private diagnostic/)).toBeNull()
})
