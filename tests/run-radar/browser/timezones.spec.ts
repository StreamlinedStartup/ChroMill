import { test, expect, chromium } from "@playwright/test"
import { attach } from "./protocol"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"

test("production toolbar and native panel resolve schedule zones and persist the user fallback", async ({}, testInfo) => {
  test.setTimeout(120000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-011/browser")
  const profile = path.join(evidence, "profile")
  await mkdir(profile, { recursive: true })
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), path.join(profile, "synthetic.fifo")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const item = await stream.next()
    if (item.done) throw new Error("Timezone fixture exited")
    return JSON.parse(item.value)
  }
  await next()
  async function mode(value: string) { fixture.stdin.write(JSON.stringify({ mode: value }) + "\n"); return next() }
  await mode("timezone")
  const extension = path.join(root, "build/chrome-mv3-prod")
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const observations: string[] = []
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const registration = path.join(profile, "NativeMessagingHosts")
    execFileSync("python3", [path.join(root, "native/install.py"), "install", "--extension-id", extensionId, "--fifo", path.join(profile, "synthetic.fifo"), "--directory", registration], { cwd: root })
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html`)
    const request = (message: Record<string, unknown>) => options.evaluate(async value => await chrome.runtime.sendMessage(value), message)
    await expect.poll(() => options.evaluate(async () => (await chrome.storage.local.get("timezone")).timezone)).toBe(await options.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
    async function save(zone: string) {
      await options.bringToFront()
      await options.getByRole("textbox", { name: "Fallback timezone" }).fill(zone)
      await options.getByRole("button", { name: "Save timezone" }).click()
      await expect(options.getByRole("status").filter({ hasText: "Timezone saved" })).toBeVisible()
      expect(await options.evaluate(async () => (await chrome.storage.local.get("timezone")).timezone)).toBe(zone)
    }
    await save("America/New_York")
    const snapshot = await request({ type: "connection:connect", workspace: "fixture" })
    expect(snapshot.ok).toBe(true)
    const scheduled = snapshot.runs.find((run: { timezone?: string }) => run.timezone === "Asia/Tokyo")
    const fallback = snapshot.runs.find((run: { id: string }) => run.id.endsWith("000000000002"))
    const selection = { instance: snapshot.instance, workspace: "fixture", runId: fallback.id }
    const web = await context.newPage()
    await web.goto("about:blank")
    const browser = context.browser()
    if (!browser) throw new Error("Missing production browser")
    const session = await browser.newBrowserCDPSession()
    async function target(page: string) {
      return (await session.send("Target.getTargets")).targetInfos.find(info => info.url === `chrome-extension://${extensionId}/${page}.html`)
    }
    async function openPopup() {
      await web.bringToFront()
      await worker.evaluate(async () => await chrome.action.openPopup())
      await expect.poll(async () => Boolean(await target("popup"))).toBe(true)
      const info = await target("popup")
      if (!info) throw new Error("Missing toolbar popup")
      return { info, protocol: await attach(session, info.targetId) }
    }
    let popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(3)
    expect(await popup.protocol.evaluate('({width:innerWidth,height:innerHeight})')).toEqual({ width: 380, height: 572 })
    await expect.poll(() => popup.protocol.evaluate('document.body.textContent')).toContain("2025-12-31 19:01:00 GMT-5 (America/New_York)")
    expect(await popup.protocol.evaluate('document.body.textContent')).toContain("2026-01-01 09:00:00 GMT+9 (Asia/Tokyo) [current schedule]")
    await popup.protocol.screenshot(path.join(evidence, "toolbar-times.png"))
    await popup.protocol.evaluate(`document.getElementById("run-${fallback.id}").click()`)
    await expect.poll(() => popup.protocol.evaluate('document.body.textContent')).toContain("2025-12-31 19:01:00")
    await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Continue in side panel").focus()')
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(async () => Boolean(await target("sidepanel"))).toBe(true)
    const panelTarget = await target("sidepanel")
    if (!panelTarget) throw new Error("Missing native side panel")
    const panel = await attach(session, panelTarget.targetId)
    await expect.poll(() => panel.evaluate('document.querySelector("dl")?.textContent')).toContain("2025-12-31 19:01:00")
    await save("Asia/Kathmandu")
    await expect.poll(() => panel.evaluate('document.querySelector("dl")?.textContent')).toContain("2026-01-01 05:46:00 GMT+5:45 (Asia/Kathmandu)")
    expect(await panel.evaluate('document.querySelector("[data-field=Inputs] pre").textContent')).toContain("2026-01-01T00:00:00Z")
    await panel.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Compare").click()')
    await expect.poll(() => panel.evaluate('document.querySelector(".comparison")?.textContent')).toContain("2026-01-01 09:00:00 GMT+9 (Asia/Tokyo)")
    expect(await panel.evaluate('document.querySelector(".comparison").textContent')).toContain("2026-01-01 05:46:00 GMT+5:45 (Asia/Kathmandu)")
    await save("UTC")
    await expect.poll(() => panel.evaluate('document.querySelector(".comparison")?.textContent')).toContain("2026-01-01 00:01:00 GMT+0 (UTC)")
    expect(await panel.evaluate('document.querySelector(".comparison").textContent')).toContain("2026-01-01 09:00:00 GMT+9 (Asia/Tokyo)")
    await panel.screenshot(path.join(evidence, "panel-comparison.png"))
    observations.push("Actual 380 by 572 toolbar and native panel display schedule and fallback dates. Saving the preference updates the open panel and comparison. Raw JSON retains its original timestamp.")
    await request({ type: "connection:select", selection: { ...selection, runId: scheduled.id } })
    await expect.poll(() => panel.evaluate('document.querySelector("dl")?.textContent')).toContain("Asia/Tokyo")
    for (const value of ["timezone_deleted", "timezone_denied", "timezone_invalid", "timezone_unsupported"]) {
      await mode(value)
      await request({ type: "connection:select", selection })
      await expect.poll(() => panel.evaluate('document.querySelector("dl")?.textContent')).toContain("00:01:00")
      await request({ type: "connection:select", selection: { ...selection, runId: scheduled.id } })
      await expect.poll(() => panel.evaluate('document.querySelector("dl")?.textContent')).toContain("2026-01-01 00:00:00 GMT+0 (UTC)")
      expect(await panel.evaluate('document.querySelector("[role=alert]")?.textContent ?? null')).toBeNull()
    }
    await mode("timezone")
    observations.push("Deleted, denied, invalid, and browser-unsupported schedule metadata preserve inspection with the user fallback.")
    const workerTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!workerTarget) throw new Error("Missing worker target")
    await session.send("Target.closeTarget", { targetId: workerTarget.targetId })
    expect(await request({ type: "connection:timezone" })).toEqual({ ok: true, timezone: "UTC" })
    worker = context.serviceWorkers().find(item => item.url().includes(extensionId)) ?? await context.waitForEvent("serviceworker")
    expect((await request({ type: "connection:switch", workspace: "second" })).ok).toBe(true)
    expect(await request({ type: "connection:timezone" })).toEqual({ ok: true, timezone: "UTC" })
    expect((await request({ type: "connection:switch", workspace: "fixture" })).ok).toBe(true)
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.body.textContent')).toContain("2026-01-01 00:01:00 GMT+0 (UTC)")
    await request({ type: "connection:disconnect" })
    expect(await options.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: "UTC" })
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("Select a live run")
    observations.push("Popup reopening, worker restart, workspace switching, and disconnect retain only the public timezone preference. Private run content is absent from durable storage.")
    const fixtureReceipt = await mode("timezone")
    expect(fixtureReceipt.requests.every((entry: { method: string; authenticated: boolean }) => entry.method === "GET" && entry.authenticated)).toBe(true)
    await writeFile(path.join(evidence, "browser.json"), JSON.stringify({ proven: true, browserVersion: browser.version(), observations, fixtureOnly: true }, null, 2))
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
