import { test, expect, chromium } from "@playwright/test"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rename, rm, writeFile, readFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"

test("production native helper, connection recovery, restrictions, disconnect, and live smoke", async ({}, testInfo) => {
  test.setTimeout(120000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-004", "regression-003")
  const profile = path.join(evidence, "native-profile")
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  const fifo = path.join(profile, "synthetic.fifo")
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), fifo], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const line = await stream.next()
    if (line.done) throw new Error("Synthetic fixture exited")
    return JSON.parse(line.value)
  }
  await next()
  async function mode(value: string) { fixture.stdin.write(JSON.stringify({ mode: value }) + "\n"); return await next() }
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
    const page = await context.newPage()
    await page.goto(`chrome-extension://${extensionId}/options.html`)
    const request = (type: string, workspace?: string) => page.evaluate(async ({ type, workspace }) => await chrome.runtime.sendMessage(workspace ? { type, workspace } : { type }), { type, workspace })
    await page.getByRole("button", { name: "Test helper" }).click()
    await expect(page.getByRole("alert")).toContainText("helper is unavailable")
    observations.push("Missing helper shows installation recovery in the actual production options page")
    install(fifo)
    const nativeManifest = JSON.parse(await readFile(path.join(registration, "app.run_radar.windmill.json"), "utf8"))
    expect(nativeManifest.allowed_origins).toEqual([`chrome-extension://${extensionId}/`])
    await page.getByRole("button", { name: "Test helper" }).click()
    await expect(page.getByRole("status")).toContainText("Helper installed")
    await page.getByRole("button", { name: "Load workspaces" }).click()
    await expect(page.getByRole("combobox")).toHaveValue("fixture")
    await expect(page.getByLabel("Fallback timezone", { exact: true })).toBeVisible()
    await expect(page.getByLabel("Fallback timezone", { exact: true })).toHaveAttribute("id", "timezone")
    await expect(page.getByLabel("API key", { exact: true })).toHaveAttribute("type", "password")
    await expect(page.locator("input:not(#timezone)")).toHaveCount(4)
    observations.push("The labeled fallback timezone field is visible; masked credential inputs appear in the production options page")
    await page.getByRole("button", { name: /^Connect$/ }).click()
    await expect(page.getByRole("status")).toContainText("5 recent runs")
    const snapshot = await request("connection:refresh")
    expect(snapshot.runs.map((run: { status: string }) => run.status)).toEqual(["success", "failed", "running", "queued", "canceled"])
    observations.push("Exact extension ID registered inside isolated Chrome profile; actual framed native requests list five truthful run states")
    await page.screenshot({ path: path.join(evidence, "connection-configured.png") })
    // Open and attach to the actual toolbar popup, rather than a browser tab.
    await page.bringToFront()
    await worker.evaluate(async () => {
      const window = await chrome.windows.getCurrent()
      await chrome.action.openPopup({ windowId: window.id })
    })
    const browser = context.browser()
    if (!browser) throw new Error("Missing browser")
    const session = await browser.newBrowserCDPSession()
    const targets = await session.send("Target.getTargets")
    const target = targets.targetInfos.find(info => info.url === `chrome-extension://${extensionId}/popup.html`)
    if (!target) throw new Error("Missing actual toolbar popup")
    const attached = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false })
    let sequence = 0
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    session.on("Target.receivedMessageFromTarget", event => {
      if (event.sessionId !== attached.sessionId) return
      const response = JSON.parse(event.message)
      pending.get(response.id)?.(response)
      pending.delete(response.id)
    })
    async function send(method: string, params: Record<string, unknown>) {
      const id = ++sequence
      const result = new Promise<Record<string, unknown>>(resolve => pending.set(id, resolve))
      await session.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id, method, params }) })
      const response = await result
      if (response.error) throw new Error("Popup protocol failure")
      return response.result as Record<string, unknown>
    }
    async function popup(expression: string) {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error("Popup evaluation failure")
      return (response.result as { value: unknown }).value
    }
    await expect.poll(() => popup('document.querySelectorAll(".run").length')).toBe(5)
    expect(await popup('document.body.textContent.includes("Live mode")')).toBe(true)
    expect(await popup('({width:innerWidth,height:innerHeight})')).toEqual({ width: 380, height: 572 })
    const image = await send("Page.captureScreenshot", { format: "png" })
    await writeFile(path.join(evidence, "popup-live-synthetic.png"), Buffer.from(image.data as string, "base64"))
    await mode("expired")
    await popup('document.querySelector(".refresh").click()')
    await expect.poll(() => popup('document.querySelector("[role=alert]")?.textContent')).toContain("Authentication expired")
    expect(await popup('document.querySelectorAll(".run").length')).toBe(0)
    const failureImage = await send("Page.captureScreenshot", { format: "png" })
    await writeFile(path.join(evidence, "popup-live-recovery.png"), Buffer.from(failureImage.data as string, "base64"))
    await mode("normal")
    await popup('document.querySelector(".empty button").click()')
    await expect.poll(() => popup('document.querySelectorAll(".run").length')).toBe(5)
    await mode("empty")
    await popup('document.querySelector(".refresh").click()')
    await expect.poll(() => popup('document.querySelector(".run-list [role=status]")?.textContent')).toContain("No recent top-level runs")
    observations.push("Production live popup clears rows on expired authentication, retries successfully, and shows empty history without Demo fallback")
    await mode("normal")
    await popup('Array.from(document.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Open settings").click()')
    observations.push("Production toolbar popup restores public connection metadata and shows five synthetic runs at 380 by 572 pixels")
    const workerTargets = await session.send("Target.getTargets")
    const workerTarget = workerTargets.targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!workerTarget) throw new Error("Missing production service worker target")
    expect((await session.send("Target.closeTarget", { targetId: workerTarget.targetId })).success).toBe(true)
    await expect.poll(async () => (await session.send("Target.getTargets")).targetInfos.some(info => info.targetId === workerTarget.targetId)).toBe(false)
    expect(await request("connection:get")).toEqual({ ok: true, connection: { instance: snapshot.instance, workspace: "fixture" } })
    expect((await request("connection:refresh")).runs).toHaveLength(5)
    observations.push("Production worker stops and restarts; it restores only public metadata and fetches fresh runs through the native host")
    for (const [fixtureMode, code] of [["expired", "authentication_expired"], ["denied", "access_denied"], ["redirect", "redirect_rejected"], ["malformed", "response_invalid"], ["oversized", "response_too_large"], ["network", "network_failure"], ["missing_variables", "variables_missing"], ["stalled", "fifo_locked_or_stalled"]]) {
      await mode(fixtureMode)
      expect(await request("connection:refresh")).toEqual({ ok: false, code })
      await page.getByRole("button", { name: "Load workspaces" }).click()
      await expect(page.getByRole("alert")).toBeVisible()
      observations.push(`Production helper reports ${code}; options page shows a recovery action`)
    }
    await mode("normal")
    await rename(fifo, fifo + ".held")
    expect(await request("connection:status")).toEqual({ ok: false, code: "fifo_missing" })
    await rename(fifo + ".held", fifo)
    await mode("malformed_job")
    expect(await request("connection:refresh")).toEqual({ ok: false, code: "response_invalid" })
    observations.push("Missing mount and malformed job payloads produce explicit errors")
    await mode("empty")
    expect((await request("connection:refresh")).runs).toEqual([])
    observations.push("Empty history returns no runs")
    await mode("delay")
    const stale = request("connection:refresh")
    await page.waitForTimeout(100)
    expect(await request("connection:disconnect")).toEqual({ ok: true, connection: null })
    expect(await stale).toEqual({ ok: false, code: "request_canceled" })
    expect(await page.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: expect.any(String) })
    expect((await stat(fifo)).isFIFO()).toBe(true)
    observations.push("Disconnect cancels an active request, clears private extension state, and preserves the timezone preference and synthetic FIFO")
    await mode("normal")
    for (const message of [{ type: "connection:connect", workspace: "../invalid" }, { type: "connection:connect", workspace: "fixture", url: "https://evil.example" }, { type: "connection:status", data: "x".repeat(9000) }, { type: "connection:delete" }]) {
      expect(await page.evaluate(async value => await chrome.runtime.sendMessage(value), message)).toEqual({ ok: false, code: "request_invalid" })
    }
    for (const message of [{ op: "delete" }, { op: "recent", workspace: "../invalid" }, { op: "recent", workspace: "fixture", url: "https://evil.example" }]) {
      expect(await page.evaluate(async value => await chrome.runtime.sendNativeMessage("app.run_radar.windmill", value), message)).toEqual({ ok: false, code: "request_invalid" })
    }
    const oversizedRejected = await page.evaluate(async () => {
      try { await chrome.runtime.sendNativeMessage("app.run_radar.windmill", { op: "status", data: "x".repeat(9000) }); return false }
      catch { return true }
    })
    expect(oversizedRejected).toBe(true)
    // A normal web page cannot invoke the extension's privileged message listener.
    const webpage = await context.newPage()
    await webpage.goto("about:blank")
    expect(await webpage.evaluate(() => typeof chrome.runtime)).toBe("undefined")
    await webpage.close()
    const fixtureReceipt = await mode("normal")
    expect(fixtureReceipt.requests.every((value: { method: string; authenticated: boolean; namedPath: string }) => value.method === "GET" && value.authenticated && ["/api/workspaces/list", "/api/w/fixture/jobs/list"].includes(value.namedPath))).toBe(true)
    expect(JSON.stringify(await page.evaluate(async () => await chrome.storage.local.get(null)))).not.toContain("synthetic-browser-credential")
    expect(await page.locator("body").textContent()).not.toContain("synthetic-browser-credential")
    observations.push("Mutations, arbitrary URLs, oversized messages, and invalid IDs rejected; fixture sees only named authenticated GETs; no synthetic credential appears in UI or storage")
    remove()
    expect(await request("connection:status")).toEqual({ ok: false, code: "helper_missing" })
    observations.push("Helper removal restores missing-helper recovery")
    // Live data never leaves this evaluation. Capture only codes and counts.
    const liveFifo = "/Users/vulture/src/tries/plasmo-test/.env"
    const liveMetadata = testInfo.project.metadata.syntheticOnly ? null : await stat(liveFifo).catch(() => null)
    let liveSmoke: Record<string, unknown> = { proven: false, liveProven: false, blocker: testInfo.project.metadata.syntheticOnly ? "Live access pending; explicit synthetic-only mode" : "Recorded root FIFO is unavailable" }
    if (liveMetadata?.isFIFO()) {
      install(liveFifo)
      liveSmoke = await page.evaluate(async () => {
        const status = await chrome.runtime.sendMessage({ type: "connection:status" })
        if (!status.ok) return { proven: false, stage: "status", code: status.code }
        const access = await chrome.runtime.sendMessage({ type: "connection:workspaces" })
        if (!access.ok) return { proven: false, stage: "workspaces", code: access.code }
        if (!access.workspaces.length) return { proven: false, stage: "workspaces", blocker: "No accessible workspace" }
        const recent = await chrome.runtime.sendMessage({ type: "connection:connect", workspace: access.workspaces[0] })
        const stored = await chrome.storage.local.get(null)
        const publicMetadataOnly = recent.ok && Object.keys(stored).sort().join(",") === "connection,monitoring,timezone" && typeof stored.timezone === "string" && stored.connection !== null && typeof stored.connection === "object" && Object.keys(stored.connection).sort().join(",") === "instance,workspace"
        const disconnect = await chrome.runtime.sendMessage({ type: "connection:disconnect" })
        const after = await chrome.storage.local.get(null)
        const privateStateCleared = Object.keys(after).join(",") === "timezone" && after.timezone === stored.timezone
        return { proven: recent.ok === true && disconnect.ok === true && publicMetadataOnly && privateStateCleared, stage: "recent", code: recent.code ?? null,
          accessibleWorkspaceCount: access.workspaces.length, recentRunCount: recent.ok ? recent.runs.length : null,
          states: recent.ok ? [...new Set(recent.runs.map((run: { status: string }) => run.status))] : [],
          disconnected: disconnect.ok === true, publicMetadataOnly, privateStateCleared }
      })
      remove()
    }
    await writeFile(path.join(evidence, "live-smoke.json"), JSON.stringify(liveSmoke, null, 2))
    await writeFile(path.join(evidence, "connection-browser.json"), JSON.stringify({ browserVersion: browser.version(), extensionId,
      productionManifest: await page.evaluate(() => chrome.runtime.getManifest()),
      nativeAllowedOrigins: nativeManifest.allowed_origins, framedFlow: "Chrome connectNative to real Python host with separate synthetic FIFO and local HTTP fixture",
      observations, fixtureRequests: fixtureReceipt.requests, liveSmoke }, null, 2))
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
