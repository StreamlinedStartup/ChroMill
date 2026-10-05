import { test, expect, chromium } from "@playwright/test"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"
import type { Monitoring } from "../../../src/monitoring"
import { attach } from "./protocol"

test("production alarm monitors failures with popup closed and survives restart", async ({}, testInfo) => {
  test.setTimeout(240000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-006/browser", "badge")
  const profile = path.join(evidence, "native-profile")
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  const fifo = path.join(profile, "synthetic.fifo")
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), fifo], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const value = await stream.next()
    if (value.done) throw new Error("Badge fixture exited")
    return JSON.parse(value.value)
  }
  await next()
  async function mode(value: string) { fixture.stdin.write(JSON.stringify({ mode: value }) + "\n"); return next() }
  const extension = path.join(root, "build/chrome-mv3-prod")
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const observations: string[] = []
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const registration = path.join(profile, "NativeMessagingHosts")
    function install(fifoPath: string) {
      execFileSync("python3", [path.join(root, "native/install.py"), "install", "--extension-id", extensionId, "--fifo", fifoPath, "--directory", registration], { cwd: root })
    }
    install(fifo)
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html`)
    const request = (message: Record<string, unknown>) => options.evaluate(async value => await chrome.runtime.sendMessage(value), message)
    const snapshot = await request({ type: "connection:connect", workspace: "fixture" })
    expect(snapshot.ok).toBe(true)
    const identity = { instance: snapshot.instance, workspace: snapshot.workspace, runId: snapshot.runs[2].id }
    const web = await context.newPage()
    await web.goto("about:blank")
    const browser = context.browser()
    if (!browser) throw new Error("Missing Chrome")
    const session = await browser.newBrowserCDPSession()
    async function target(page: string) {
      return (await session.send("Target.getTargets")).targetInfos.find(info => info.url === `chrome-extension://${extensionId}/${page}.html`)
    }
    async function openPopup() {
      const existing = await target("popup")
      if (existing) await session.send("Target.closeTarget", { targetId: existing.targetId })
      await web.bringToFront()
      worker = context.serviceWorkers().find(item => item.url().includes(extensionId)) ?? await context.waitForEvent("serviceworker")
      const windowId = await options.evaluate(async () => (await chrome.windows.getCurrent()).id)
      if (windowId === undefined) throw new Error("Missing test window")
      await worker.evaluate(async id => await chrome.action.openPopup({ windowId: id }), windowId)
      await expect.poll(async () => Boolean(await target("popup"))).toBe(true)
      const info = await target("popup")
      if (!info) throw new Error("Missing toolbar popup")
      return { info, protocol: await attach(session, info.targetId) }
    }
    const badge = () => options.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}), monitoring: (await chrome.storage.local.get("monitoring")).monitoring as Monitoring }))
    expect((await badge()).text).toBe("")
    expect(await options.evaluate(async () => (await chrome.alarms.get("run-radar:recent"))?.periodInMinutes)).toBe(1)
    let popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    expect(await popup.protocol.evaluate('({width:innerWidth,height:innerHeight})')).toEqual({ width: 380, height: 572 })
    expect(await popup.protocol.evaluate('Boolean(document.querySelector(".mode-actions"))')).toBe(false)
    expect(await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).some(button => button.getAttribute("aria-label") === "Open settings")')).toBe(true)
    expect(await popup.protocol.evaluate('Boolean(document.querySelector(".monitor-status"))')).toBe(false)
    await popup.protocol.screenshot(path.join(evidence, "baseline.png"))
    await session.send("Target.closeTarget", { targetId: popup.info.targetId })
    await mode("badge_failed")
    const workerTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!workerTarget) throw new Error("Missing worker target")
    await session.send("Target.closeTarget", { targetId: workerTarget.targetId })
    const started = Date.now()
    // Leave the production one-minute alarm untouched. No UI refresh runs here.
    await expect.poll(async () => (await badge()).text, { timeout: 90000, intervals: [1000] }).toBe("1")
    expect(await target("popup")).toBeUndefined()
    const firstAlarm = await badge()
    observations.push(`The untouched one-minute alarm counts an active-to-failed transition after actual worker termination with the popup closed. Wait: ${Date.now() - started} ms. Historical failure stays seen.`)
    // Accelerate subsequent fault-injection alarms only in this unpacked test.
    async function alarm() {
      await options.evaluate(async () => { await chrome.alarms.create("run-radar:recent", { when: Date.now() + 300, periodInMinutes: 1 }) })
    }
    await alarm()
    await expect.poll(async () => (await badge()).monitoring.snapshotAt !== firstAlarm.monitoring.snapshotAt).toBe(true)
    expect((await badge()).text).toBe("1")
    const durable = (await badge()).monitoring
    worker = context.serviceWorkers().find(item => item.url().includes(extensionId)) ?? await context.waitForEvent("serviceworker")
    const restartedTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!restartedTarget) throw new Error("Missing restarted worker")
    await options.evaluate(async () => { await chrome.alarms.clear("run-radar:recent") })
    await session.send("Target.closeTarget", { targetId: restartedTarget.targetId })
    expect((await request({ type: "connection:monitor" })).monitoring).toEqual(durable)
    await expect.poll(async () => Boolean(await options.evaluate(async () => await chrome.alarms.get("run-radar:recent")))).toBe(true)
    observations.push("Duplicate alarm preserves count and cursor. Restart retains records and recreates a missing alarm.")
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    await expect.poll(() => popup.protocol.evaluate('document.querySelector(".monitor-status")?.textContent')).toBe("1 unseen failure")
    await popup.protocol.evaluate(`document.getElementById("run-${identity.runId}").focus()`)
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    await expect.poll(async () => (await badge()).text).toBe("")
    await popup.protocol.screenshot(path.join(evidence, "seen-inspection.png"))
    await session.send("Target.closeTarget", { targetId: popup.info.targetId })
    observations.push("Opening the failed run through the real toolbar popup marks it seen after successful inspection. The badge clears.")
    for (const [state, text] of [["expired", "ERR"], ["network", "ST"]]) {
      await mode(state)
      await alarm()
      await expect.poll(async () => (await badge()).text, { timeout: 20000 }).toBe(text)
      expect(await target("popup")).toBeUndefined()
      observations.push(`${state} alarm failure uses ${text} and preserves seen records.`)
    }
    await mode("badge_failed")
    await alarm()
    await expect.poll(async () => (await badge()).text).toBe("GAP")
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('Boolean(document.querySelector(".monitor-status"))')).toBe(false)
    // Wait for the popup's native refresh before removing monitoring below.
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    await popup.protocol.screenshot(path.join(evidence, "sampling-gap.png"))
    observations.push("Recovery retains the sampling-gap warning in the toolbar title. The popup hides its notice when all failures are seen.")
    await session.send("Target.closeTarget", { targetId: popup.info.targetId })
    // Model an upgrade with a saved connection but no successful monitoring sample.
    await options.evaluate(async () => { await chrome.storage.local.remove("monitoring") })
    for (const [state, text] of [["expired", "ERR"], ["network", "ST"]]) {
      await mode(state)
      await alarm()
      await expect.poll(async () => (await badge()).text, { timeout: 20000 }).toBe(text)
      expect((await badge()).monitoring.lastSuccess).toBe(0)
      expect((await badge()).monitoring.records).toEqual([])
      expect(await target("popup")).toBeUndefined()
    }
    worker = context.serviceWorkers().find(item => item.url().includes(extensionId)) ?? await context.waitForEvent("serviceworker")
    const errorTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!errorTarget) throw new Error("Missing error-state worker")
    await session.send("Target.closeTarget", { targetId: errorTarget.targetId })
    expect((await request({ type: "connection:monitor" })).monitoring.lastSuccess).toBe(0)
    await expect.poll(async () => (await badge()).text).toBe("ST")
    await mode("badge_failed")
    await alarm()
    await expect.poll(async () => (await badge()).monitoring.lastSuccess).toBeGreaterThan(0)
    expect((await badge()).monitoring.records.filter(record => record.status === "failed" && !record.seen)).toEqual([])
    expect((await badge()).text).toBe("GAP")
    observations.push("A saved connection without a baseline persists ERR and ST from popup-closed alarms across worker restart. First successful recovery marks terminal history seen and preserves GAP.")
    const requestsBeforeDelay = (await mode("delay")).requests.length
    await alarm()
    await expect.poll(async () => {
      const status = await mode("delay")
      return status.requests.length
    }).toBeGreaterThan(requestsBeforeDelay)
    await request({ type: "connection:disconnect" })
    expect(await options.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: expect.any(String) })
    expect(await options.evaluate(async () => await chrome.alarms.get("run-radar:recent"))).toBeUndefined()
    expect((await badge()).text).toBe("")
    await new Promise(resolve => setTimeout(resolve, 2500))
    expect(await options.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: expect.any(String) })
    const fixtureReceipt = await mode("normal")
    const countAfterDisconnect = fixtureReceipt.requests.length
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect((await mode("normal")).requests.length).toBe(countAfterDisconnect)
    observations.push("Disconnect during a delayed alarm clears the alarm, native work, private durable state, and badge. The timezone preference persists. Late responses cannot restore state. No more fixture requests occur.")
    await writeFile(path.join(evidence, "browser.json"), JSON.stringify({ browserVersion: browser.version(), extensionId,
      manifest: await options.evaluate(() => chrome.runtime.getManifest()), popupTarget: popup.info.type,
      naturalAlarm: { periodInMinutes: 1, popupClosed: true, workerTerminated: true, observedCount: firstAlarm.text },
      acceleratedFaultAlarms: true, observations, fixtureRequests: fixtureReceipt.requests,
      liveProven: false, liveScope: "Synthetic failure injection only. No live mutations or credentials used." }, null, 2))
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
