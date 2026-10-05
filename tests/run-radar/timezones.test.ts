import { describe, expect, it } from "vitest"
import { browserTimezone, formatTimestamp, isTimestamp, resolvedTimezone, runTime, validTimezone } from "../../src/timezones"
import { isRunSnapshot } from "../../src/runs"

describe("absolute timestamps", () => {
  it.each([
    ["2026-03-08T06:59:59Z", "America/New_York", "2026-03-08 01:59:59 GMT-5"],
    ["2026-03-08T07:00:00Z", "America/New_York", "2026-03-08 03:00:00 GMT-4"],
    ["2026-11-01T05:30:00Z", "America/New_York", "2026-11-01 01:30:00 GMT-4"],
    ["2026-11-01T06:30:00Z", "America/New_York", "2026-11-01 01:30:00 GMT-5"],
    ["2026-07-01T00:00:00Z", "America/Phoenix", "2026-06-30 17:00:00 GMT-7"],
    ["2026-01-01T00:00:00Z", "Asia/Kathmandu", "2026-01-01 05:45:00 GMT+5:45"],
    ["2026-01-01T00:00:00Z", "Asia/Kolkata", "2026-01-01 05:30:00 GMT+5:30"],
    ["2026-01-01T00:00:00Z", "UTC", "2026-01-01 00:00:00 GMT+0"],
    ["2026-01-01T00:00:00Z", "America/New_York", "2025-12-31 19:00:00 GMT-5"],
    ["2025-12-31T23:59:59Z", "Pacific/Auckland", "2026-01-01 12:59:59 GMT+13"]
  ])("renders %s in %s without changing its instant", (instant, zone, expected) => {
    expect(formatTimestamp(instant, zone)).toBe(`${expected} (${zone})`)
  })
  it("preserves equivalent Z, explicit offsets and fractional seconds", () => {
    const first = "2026-01-01T00:00:00.123456Z"
    const second = "2026-01-01T05:45:00.123456+05:45"
    expect(isTimestamp(second)).toBe(true)
    expect(formatTimestamp(first, "America/New_York")).toBe(formatTimestamp(second, "America/New_York"))
    expect(Date.parse(first)).toBe(Date.parse(second))
  })
  it.each(["2026-01-01T00:00:00", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+00:99", "2026-01-01", "garbage"]) ("rejects invalid or ambiguous timestamp %s", value => {
    expect(isTimestamp(value)).toBe(false)
    expect(formatTimestamp(value, "UTC")).toBe("Invalid timestamp")
    expect(isRunSnapshot({ snapshotAt: "2026-01-02T00:00:00.000Z", runs: [{ id: "a", name: "a", path: "a", status: "success", durationMs: 0, trigger: "Unknown", startedAt: value }] })).toBe(false)
  })
  it("uses valid run metadata before the preference and never infers a zone from Z", () => {
    expect(resolvedTimezone({ timezone: "Asia/Tokyo" }, "UTC")).toBe("Asia/Tokyo")
    expect(resolvedTimezone({}, "Asia/Kathmandu")).toBe("Asia/Kathmandu")
    expect(resolvedTimezone({ timezone: "bad/zone" }, "UTC")).toBe("UTC")
    expect(runTime({ startedAt: "2026-01-01T00:00:00Z", timezone: "Asia/Tokyo" }, "UTC")).toContain("[current schedule]")
    expect(validTimezone("+05:45")).toBe(false)
    expect(validTimezone("UTC")).toBe(true)
    expect(validTimezone(browserTimezone())).toBe(true)
  })
  it("keeps a run inspectable when the browser does not recognize its schedule timezone", () => {
    const run = { id: "a", name: "a", path: "a", status: "success", durationMs: 0, trigger: "Schedule", startedAt: "2026-01-01T00:00:00Z", timezone: "posix/America/New_York" }
    expect(isRunSnapshot({ snapshotAt: "2026-01-02T00:00:00Z", runs: [run] })).toBe(true)
    expect(runTime(run, "UTC")).toBe("2026-01-01 00:00:00 GMT+0 (UTC)")
    expect(isRunSnapshot({ snapshotAt: "2026-01-02T00:00:00Z", runs: [{ ...run, timezone: {} }] })).toBe(false)
  })
})
