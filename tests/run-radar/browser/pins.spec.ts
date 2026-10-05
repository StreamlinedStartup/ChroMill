import { test, expect, chromium } from "@playwright/test"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rm, writeFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"
import { attach } from "./protocol"

test("production pins restore after worker restart and remain inspectable outside recent history", async ({}, testInfo) => {
  test.setTimeout(120000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-005/browser", "pins")
  const profile = path.join(evidence, "native-profile")
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  const fifo = path.join(profile, "synthetic.fifo")
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), fifo], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const value = await stream.next()
    if (value.done) throw new Error("Pin fixture exited")
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
    const identity = { instance: snapshot.instance, workspace: snapshot.workspace, runId: snapshot.runs[0].id }
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
      await options.evaluate(async id => await chrome.windows.update(id, { focused: true }), windowId)
      await worker.evaluate(async id => await chrome.action.openPopup({ windowId: id }), windowId)
      await expect.poll(async () => Boolean(await target("popup"))).toBe(true)
      const info = await target("popup")
      if (!info) throw new Error("Missing toolbar popup")
      return { info, protocol: await attach(session, info.targetId) }
    }
    let popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    // Real keyboard activation of the row pin control.
    await popup.protocol.evaluate('document.querySelector(".pin").focus()')
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(() => popup.protocol.evaluate('document.querySelector(".pin").textContent')).toBe("Unpin")
    expect(await request({ type: "connection:pins" })).toEqual({ ok: true, connection: { instance: identity.instance, workspace: identity.workspace }, pins: [identity] })
    await popup.protocol.screenshot(path.join(evidence, "pinned-recent.png"))
    await session.send("Target.closeTarget", { targetId: popup.info.targetId })
    await mode("pin_older")
    const workerTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!workerTarget) throw new Error("Missing worker target")
    await session.send("Target.closeTarget", { targetId: workerTarget.targetId })
    expect(await request({ type: "connection:pins" })).toEqual({ ok: true, connection: { instance: identity.instance, workspace: identity.workspace }, pins: [identity] })
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(1)
    expect(await popup.protocol.evaluate('document.querySelector(".run").id')).not.toBe(`run-${identity.runId}`)
    async function click(label: string) {
      await popup.protocol.evaluate(`Array.from(document.querySelectorAll("button")).find(button => button.textContent === ${JSON.stringify(label)}).click()`)
    }
    await click("Pinned (1)")
    await expect.poll(() => popup.protocol.evaluate('document.querySelector(".run")?.id')).toBe(`run-${identity.runId}`)
    expect(await popup.protocol.evaluate('({width:innerWidth,height:innerHeight})')).toEqual({ width: 380, height: 572 })
    await popup.protocol.evaluate('document.querySelector(".run").focus()')
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    await popup.protocol.screenshot(path.join(evidence, "pinned-inspection.png"))
    await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Continue in side panel").focus()')
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(async () => Boolean(await target("sidepanel"))).toBe(true)
    const panelTarget = await target("sidepanel")
    if (!panelTarget) throw new Error("Missing side panel")
    const panel = await attach(session, panelTarget.targetId)
    await expect.poll(() => panel.evaluate('document.querySelectorAll("pre").length')).toBe(4)
    await panel.screenshot(path.join(evidence, "pinned-sidepanel.png"))
    observations.push("Keyboard pin action persists only identity. Popup closure and actual worker termination preserve the pin. The pin is absent from recent history but opens inspection and the native panel.")
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(1)
    await click("Pinned (1)")
    await expect.poll(() => popup.protocol.evaluate('document.querySelector(".run")?.id')).toBe(`run-${identity.runId}`)
    for (const [state, text] of [["pin_deleted", "deleted"], ["pin_denied", "forbidden"]]) {
      await mode(state)
      await click("All runs")
      await click("Pinned (1)")
      await expect.poll(() => popup.protocol.evaluate('document.querySelector(".run [role=status]")?.textContent')).toContain(text)
      await popup.protocol.screenshot(path.join(evidence, `${state}.png`))
    }
    await popup.protocol.evaluate('document.querySelector(".pin").click()')
    await expect.poll(() => popup.protocol.evaluate('document.querySelector(".run-list").textContent')).toContain("No pinned runs match")
    expect((await request({ type: "connection:pins" })).pins).toEqual([])
    observations.push("Deleted and forbidden pins show explicit states in Pinned. Unpin removes an inaccessible identity without fetching private content.")
    await mode("normal")
    const second = { ...identity, runId: snapshot.runs[1].id }
    await Promise.all([request({ type: "connection:pin", selection: identity }), request({ type: "connection:pin", selection: second })])
    const pins = (await request({ type: "connection:pins" })).pins
    expect(pins).toHaveLength(2)
    expect(pins.every((pin: Record<string, unknown>) => Object.keys(pin).sort().join(",") === "instance,runId,workspace")).toBe(true)
    await request({ type: "connection:disconnect" })
    expect(await options.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: expect.any(String) })
    observations.push("Concurrent production messages preserve both edits. Persisted pin records contain only instance, workspace and run ID. Disconnect clears them.")
    const fixtureReceipt = await mode("normal")
    execFileSync("python3", [path.join(root, "native/install.py"), "remove", "--directory", registration], { cwd: root })
    let liveSmoke: Record<string, unknown> = { proven: false, blocker: "Live FIFO unavailable or explicit synthetic-only mode" }
    if (!testInfo.project.metadata.syntheticOnly && (await stat("/Users/vulture/src/tries/plasmo-test/.env").catch(() => null))?.isFIFO()) {
      install("/Users/vulture/src/tries/plasmo-test/.env")
      liveSmoke = await options.evaluate(async () => {
        const access = await chrome.runtime.sendMessage({ type: "connection:workspaces" })
        if (!access.ok || !access.workspaces.length) return { proven: false, stage: "workspaces", code: access.code ?? "no_workspaces" }
        const recent = await chrome.runtime.sendMessage({ type: "connection:connect", workspace: access.workspaces[0] })
        if (!recent.ok || !recent.runs.length) return { proven: false, stage: "recent", code: recent.code ?? "no_runs" }
        const selection = { instance: recent.instance, workspace: recent.workspace, runId: recent.runs[0].id }
        const pin = await chrome.runtime.sendMessage({ type: "connection:pin", selection })
        const restored = await chrome.runtime.sendMessage({ type: "connection:pins" })
        const detail = await chrome.runtime.sendMessage({ type: "connection:inspect", selection })
        const unpin = await chrome.runtime.sendMessage({ type: "connection:unpin", selection })
        await chrome.runtime.sendMessage({ type: "connection:disconnect" })
        return { proven: pin.ok && restored.pins?.length === 1 && detail.ok && unpin.ok && unpin.pins.length === 0,
          stage: "pin-inspection-unpin", code: detail.code ?? null }
      })
    }
    await writeFile(path.join(evidence, "browser.json"), JSON.stringify({ browserVersion: browser.version(), extensionId,
      manifest: await options.evaluate(() => chrome.runtime.getManifest()), popupTarget: popup.info.type,
      workerRestart: "Target.closeTarget on production service_worker followed by a storage request",
      observations, fixtureRequests: fixtureReceipt.requests, liveSmoke }, null, 2))
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
