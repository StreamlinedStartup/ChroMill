import { describe, expect, it, vi, afterEach } from "vitest"
import { handleDemoRequest } from "../../src/demo"
import { filterRuns, isDemoResponse, requestDemoRuns } from "../../src/runs"

const sender = { id: "test-extension", url: "chrome-extension://test-extension/popup.html" }
const fixture = () => handleDemoRequest({ type: "demo:list" }, sender, sender.id)
afterEach(() => vi.unstubAllGlobals())

describe("demo service boundary", () => {
  it("returns truthful, ordered, independent fixture responses", () => {
    const response = fixture()
    expect(isDemoResponse(response)).toBe(true)
    if (!response.ok) throw new Error("Fixture failed")
    expect(response.runs).toHaveLength(12)
    expect(response.runs.filter(run => run.status === "failed")).toHaveLength(3)
    expect(response.runs.filter(run => run.status === "running")).toHaveLength(2)
    expect(response.runs[0].id).toBe("019a-8f31")
    expect(response.runs[0].durationMs).toBe(Date.parse(response.snapshotAt) - Date.parse(response.runs[0].startedAt))
    response.runs[0].name = "Changed"
    expect(fixture()).not.toEqual(response)
  })
  it.each([undefined, null, [], { type: "live:list" }, { type: "demo:list", url: "https://example.com" }])("rejects unsupported requests %j", message => {
    expect(handleDemoRequest(message, sender, sender.id).ok).toBe(false)
  })
  it.each([
    { id: "foreign", url: sender.url },
    { id: sender.id, url: "https://example.com/popup.html" },
    { id: sender.id, url: "chrome-extension://test-extension/contents.html" },
    { id: sender.id },
  ])("rejects unauthorized senders %j", foreign => {
    expect(handleDemoRequest({ type: "demo:list" }, foreign, sender.id).ok).toBe(false)
  })
  it("registers the production listener and returns its fixture response", async () => {
    const addListener = vi.fn()
    const setBadgeText = vi.fn().mockResolvedValue(undefined)
    const localAccess = vi.fn().mockResolvedValue(undefined), sessionAccess = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("chrome", { storage: { local: { get: vi.fn().mockResolvedValue({}), setAccessLevel: localAccess },
      session: { setAccessLevel: sessionAccess } }, permissions: {},
      alarms: { onAlarm: { addListener: vi.fn() }, clear: vi.fn().mockResolvedValue(true) },
      action: { setBadgeText, setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined), setTitle: vi.fn().mockResolvedValue(undefined) },
      runtime: { id: sender.id, onMessage: { addListener }, onStartup: { addListener: vi.fn() }, onInstalled: { addListener: vi.fn() } } })
    await import("../../src/background")
    await vi.waitFor(() => expect(setBadgeText).toHaveBeenCalledWith({ text: "" }))
    expect(localAccess).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" })
    expect(sessionAccess).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" })
    const respond = vi.fn()
    expect(addListener.mock.calls[0][0]({ type: "demo:list" }, sender, respond)).toBe(false)
    expect(respond).toHaveBeenCalledWith(fixture())
  })
  it("sends the explicit demo request through runtime messaging", async () => {
    const sendMessage = vi.fn().mockResolvedValue(fixture())
    vi.stubGlobal("chrome", { storage: { local: {} }, runtime: { sendMessage } })
    expect(await requestDemoRuns()).toEqual(fixture())
    expect(sendMessage).toHaveBeenCalledWith({ type: "demo:list" })
  })
  it("reports transport failures, rejected operations, and malformed responses", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("internal detail"))
    vi.stubGlobal("chrome", { storage: { local: {} }, runtime: { sendMessage } })
    await expect(requestDemoRuns()).rejects.toThrow("unavailable")
    sendMessage.mockResolvedValue({ ok: false, error: "Unsupported demo request." })
    await expect(requestDemoRuns()).rejects.toThrow("Unsupported demo request.")
    sendMessage.mockResolvedValue({ ok: true, runs: [] })
    await expect(requestDemoRuns()).rejects.toThrow("invalid response")
  })
  it("accepts empty data and rejects malformed run data", () => {
    const response = fixture()
    if (!response.ok) throw new Error("Fixture failed")
    expect(isDemoResponse({ ...response, runs: [] })).toBe(true)
    for (const patch of [{ durationMs: -1 }, { status: "other" }, { startedAt: "invalid" }, { startedAt: "2026-10-03T19:30:00.000Z" }, { trigger: "other" }]) {
      expect(isDemoResponse({ ...response, runs: [{ ...response.runs[0], ...patch }] })).toBe(false)
    }
    expect(isDemoResponse({ ...response, runs: [response.runs[0], response.runs[0]] })).toBe(false)
  })
})

describe("run filtering", () => {
  it("combines status with case-insensitive name, path, and ID searches", () => {
    const response = fixture()
    if (!response.ok) throw new Error("Fixture failed")
    expect(filterRuns(response.runs, "failed", "")).toHaveLength(3)
    expect(filterRuns(response.runs, "running", "")).toHaveLength(2)
    expect(filterRuns(response.runs, "all", " SYNC_CUSTOMERS ").map(run => run.id)).toEqual(["019a-8f2c"])
    expect(filterRuns(response.runs, "all", "019A-8EC4")).toHaveLength(1)
    expect(filterRuns(response.runs, "running", "customer")).toEqual([])
    expect(filterRuns([], "all", "")).toEqual([])
  })
})
