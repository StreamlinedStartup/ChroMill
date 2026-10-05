import { test, expect, chromium } from "@playwright/test"
import { attach } from "./protocol"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rm, writeFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"


test("production popup inspection and native side panel survive popup closure and tab switching", async ({}, testInfo) => {
  test.setTimeout(120000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-004")
  const profile = path.join(evidence, "native-profile")
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  const fifo = path.join(profile, "synthetic.fifo")
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), fifo], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const item = await stream.next()
    if (item.done) throw new Error("Inspection fixture exited")
    return JSON.parse(item.value)
  }
  await next()
  async function mode(value: string) { fixture.stdin.write(JSON.stringify({ mode: value }) + "\n"); return next() }
  const extension = path.join(root, "build/chrome-mv3-prod")
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const observations: string[] = []
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const registration = path.join(profile, "NativeMessagingHosts")
    const install = (fifoPath: string) => execFileSync("python3", [path.join(root, "native/install.py"), "install", "--extension-id", extensionId, "--fifo", fifoPath, "--directory", registration], { cwd: root })
    const remove = () => execFileSync("python3", [path.join(root, "native/install.py"), "remove", "--directory", registration], { cwd: root })
    install(fifo)
    const options = await context.newPage()
    await options.goto(`chrome-extension://${extensionId}/options.html`)
    const request = (message: Record<string, unknown>) => options.evaluate(async value => await chrome.runtime.sendMessage(value), message)
    const snapshot = await request({ type: "connection:connect", workspace: "fixture" })
    expect(snapshot.ok).toBe(true)
    const selection = { instance: snapshot.instance, workspace: snapshot.workspace, runId: snapshot.runs[0].id }
    const second = { ...selection, runId: snapshot.runs[1].id }
    const web = await context.newPage()
    await web.goto("about:blank")
    const browser = context.browser()
    if (!browser) throw new Error("Missing production browser")
    const session = await browser.newBrowserCDPSession()
    async function target(page: string) {
      const targets = await session.send("Target.getTargets")
      return targets.targetInfos.find(info => info.url === `chrome-extension://${extensionId}/${page}.html`)
    }
    async function openPopup() {
      await worker.evaluate(async () => await chrome.action.openPopup())
      await expect.poll(async () => Boolean(await target("popup"))).toBe(true)
      const info = await target("popup")
      if (!info) throw new Error("Missing toolbar popup")
      return { info, protocol: await attach(session, info.targetId) }
    }
    let popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    await popup.protocol.evaluate('document.querySelector(".run").click()')
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    expect(await popup.protocol.evaluate('({width:innerWidth,height:innerHeight,unsafe:document.querySelectorAll("img,script:not([src])").length})')).toEqual({ width: 380, height: 572, unsafe: 0 })
    expect(await popup.protocol.evaluate('Array.from(document.querySelectorAll(".detail-field h2"), node => node.textContent)')).toEqual(["Result", "Logs"])
    expect(await popup.protocol.evaluate('document.querySelector("[data-field=Result] pre")?.textContent')).toContain('"answer"')
    observations.push("The production toolbar popup shows the return value as text before Logs.")
    await popup.protocol.screenshot(path.join(evidence, "popup-inspection.png"))
    await popup.protocol.key("Escape", "Escape", 27)
    await expect.poll(() => popup.protocol.evaluate('document.activeElement?.id')).toBe(`run-${selection.runId}`)
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Back").click()')
    await expect.poll(() => popup.protocol.evaluate('document.activeElement?.id')).toBe(`run-${selection.runId}`)
    observations.push("Actual toolbar popup displays metadata and final log lines at 380 by 572 pixels. Back and Escape restore row focus.")
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    const openedPopupTab = context.waitForEvent("page")
    await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Open in Windmill").click()')
    const popupTab = await openedPopupTab
    await popupTab.waitForLoadState()
    expect(popupTab.url()).toBe(`${selection.instance}/run/${selection.runId}?workspace=fixture`)
    await popupTab.close()
    await web.bringToFront()
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    await popup.protocol.evaluate('document.querySelector(".run").click()')
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    // Input.dispatchKeyEvent supplies a real user gesture to sidePanel.open.
    await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Continue in side panel").focus()')
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(async () => Boolean(await target("sidepanel"))).toBe(true)
    const panelTarget = await target("sidepanel")
    if (!panelTarget) throw new Error("Native side panel did not open")
    const panel = await attach(session, panelTarget.targetId)
    await expect.poll(() => panel.evaluate('document.querySelectorAll("pre").length')).toBe(4)
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("step-a")
    expect(await panel.evaluate('document.querySelectorAll("img").length')).toBe(0)
    expect(await panel.evaluate('globalThis.pwned === true')).toBe(false)
    expect(await panel.evaluate('Array.from(document.querySelectorAll(".detail-field h2"), node => node.textContent)')).toEqual(["Result", "Logs", "Inputs", "Flow steps"])
    expect(await panel.evaluate('document.querySelector("[data-field=Result] pre")?.textContent')).toContain('"answer"')
    observations.push("The native panel shows Result first, Logs second, then Inputs and Flow steps. HTML in the result stays inert text.")
    await panel.screenshot(path.join(evidence, "native-sidepanel.png"))
    const remainingPopup = await target("popup")
    if (remainingPopup) await session.send("Target.closeTarget", { targetId: remainingPopup.targetId })
    expect(await request({ type: "connection:selection" })).toEqual({ ok: true, selection })
    const otherTab = await context.newPage()
    await otherTab.goto("about:blank")
    await otherTab.bringToFront()
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain(selection.runId)
    const workerTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!workerTarget) throw new Error("Missing worker target")
    await session.send("Target.closeTarget", { targetId: workerTarget.targetId })
    expect(await request({ type: "connection:selection" })).toEqual({ ok: true, selection })
    observations.push("Native panel opens from a keyboard user gesture. It retains the exact instance, workspace and run after popup closure, tab switching and worker restart.")
    const openedPanelTab = context.waitForEvent("page")
    await panel.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Open in Windmill").click()')
    const panelTab = await openedPanelTab
    await panelTab.waitForLoadState()
    expect(panelTab.url()).toBe(`${selection.instance}/run/${selection.runId}?workspace=fixture`)
    await panelTab.close()
    observations.push("Popup and native panel each open the exact Windmill run URL in a new browser tab.")
    // Synthetic delayed host response and new selection exercise the production race.
    await mode("detail_delay")
    await request({ type: "connection:select", selection: second })
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("Loading")
    await mode("normal")
    await request({ type: "connection:select", selection })
    await expect.poll(() => panel.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("final log line")
    await options.waitForTimeout(2300)
    expect(await panel.evaluate('document.querySelector(".identity").textContent')).toContain(selection.runId)
    expect(await panel.evaluate('document.querySelector(".identity").textContent')).not.toContain(second.runId)
    observations.push("Delayed native detail response cannot replace a newer selected run.")
    await mode("detail_delay")
    await request({ type: "connection:select", selection: second })
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("Loading")
    await otherTab.bringToFront()
    popup = await openPopup()
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".run").length')).toBe(5)
    await popup.protocol.evaluate('document.querySelectorAll(".run")[1].click()')
    await expect.poll(() => panel.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent'), { timeout: 10000 }).toContain("final log line")
    await expect.poll(() => popup.protocol.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent'), { timeout: 10000 }).toContain("final log line")
    expect(await panel.evaluate('document.querySelector("[role=alert]")?.textContent ?? null')).toBeNull()
    expect(await request({ type: "connection:selection" })).toEqual({ ok: true, selection: second })
    await panel.screenshot(path.join(evidence, "panel-same-selection.png"))
    await session.send("Target.closeTarget", { targetId: popup.info.targetId })
    observations.push("Reopening the actual toolbar popup refreshes its list during delayed panel inspection. Reselecting the same run preserves both pending inspections and the panel reaches content without retry.")
    await mode("unicode_logs")
    await request({ type: "connection:select", selection })
    await expect.poll(() => panel.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent?.length')).toBe(128000)
    expect(await panel.evaluate('Array.from(document.querySelector("[data-field=Logs] pre").textContent).length')).toBe(64000)
    expect(await panel.evaluate('document.querySelector("[data-field=Logs] pre").textContent === String.fromCodePoint(0x1f600).repeat(64000)')).toBe(true)
    await panel.screenshot(path.join(evidence, "panel-unicode.png"))
    observations.push("Production host and worker accept 64,000 complete supplementary Unicode characters after truncation from 64,001. The native panel renders all characters as text.")
    for (const [fixtureMode, expected, identity] of [["deleted", "deleted", second], ["denied", "forbidden", selection], ["malformed", "unsupported data", second]] as const) {
      await mode(fixtureMode)
      await request({ type: "connection:select", selection: identity })
      await expect.poll(() => panel.evaluate('document.querySelector("[role=alert]")?.textContent')).toContain(expected)
    }
    await mode("unavailable")
    await request({ type: "connection:select", selection })
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("Unavailable for this run")
    await mode("large_logs")
    await request({ type: "connection:select", selection: second })
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("last 64,000 characters")
    expect(await panel.evaluate('document.querySelector("[data-field=Logs] pre").textContent.length')).toBe(64000)
    await panel.screenshot(path.join(evidence, "panel-large-logs.png"))
    observations.push("Production panel reports deleted, forbidden, malformed, unavailable, loading and large-log states explicitly. HTML remains inert text.")
    const fixtureReceipt = await mode("normal")
    expect(fixtureReceipt.requests.every((entry: { method: string; authenticated: boolean; namedPath: string }) => entry.method === "GET" && (entry.namedPath.startsWith("/api/") ? entry.authenticated : !entry.authenticated))).toBe(true)
    await request({ type: "connection:disconnect" })
    await expect.poll(() => panel.evaluate('document.body.textContent')).toContain("Select a live run")
    expect(await options.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: expect.any(String) })
    remove()
    let liveSmoke: Record<string, unknown> = { proven: false, liveProven: false, blocker: testInfo.project.metadata.syntheticOnly ? "Live access pending; explicit synthetic-only mode" : "Recorded root FIFO unavailable" }
    if (!testInfo.project.metadata.syntheticOnly && (await stat("/Users/vulture/src/tries/plasmo-test/.env").catch(() => null))?.isFIFO()) {
      install("/Users/vulture/src/tries/plasmo-test/.env")
      // Private details stay in this evaluation. Only states and counts leave Chrome.
      liveSmoke = await options.evaluate(async () => {
        const access = await chrome.runtime.sendMessage({ type: "connection:workspaces" })
        if (!access.ok || !access.workspaces.length) return { proven: false, stage: "workspaces", code: access.code ?? "no_workspaces" }
        const recent = await chrome.runtime.sendMessage({ type: "connection:connect", workspace: access.workspaces[0] })
        if (!recent.ok || !recent.runs.length) return { proven: false, stage: "recent", code: recent.code ?? "no_runs" }
        const identity = { instance: recent.instance, workspace: recent.workspace, runId: recent.runs[0].id }
        const detail = await chrome.runtime.sendMessage({ type: "connection:inspect", selection: identity })
        await chrome.runtime.sendMessage({ type: "connection:disconnect" })
        return { proven: detail.ok === true, stage: "inspection", code: detail.code ?? null,
          fields: detail.ok ? Object.fromEntries(["logs", "inputs", "result", "steps"].map(key => [key, detail.detail[key].state])) : null }
      })
      remove()
    }
    await writeFile(path.join(evidence, "inspection-live-smoke.json"), JSON.stringify(liveSmoke, null, 2))
    await writeFile(path.join(evidence, "inspection-browser.json"), JSON.stringify({ browserVersion: browser.version(), extensionId,
      productionManifest: await options.evaluate(() => chrome.runtime.getManifest()), popupTarget: popup.info.type, panelTarget: panelTarget.type,
      panelOpenedBy: "Input.dispatchKeyEvent Enter in actual toolbar popup", observations, fixtureRequests: fixtureReceipt.requests, liveSmoke }, null, 2))
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
