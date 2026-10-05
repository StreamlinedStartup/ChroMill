import { test, expect, chromium } from "@playwright/test"
import type { CDPSession } from "@playwright/test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Chrome exposes the toolbar popup as a detached page target. Attach directly
// through CDP rather than substituting a normal browser tab for the popup.
function popupProtocol(session: CDPSession, sessionId: string, pageErrors: string[]) {
  let id = 0
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  session.on("Target.receivedMessageFromTarget", event => {
    if (event.sessionId !== sessionId) return
    const response = JSON.parse(event.message)
    if (response.method === "Runtime.exceptionThrown") pageErrors.push(response.params.exceptionDetails.exception?.description ?? response.params.exceptionDetails.text)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.error) request.reject(new Error(response.error.message))
    else request.resolve(response.result)
  })
  return async (method: string, params: Record<string, unknown> = {}) => {
    const requestId = ++id
    const response = new Promise<Record<string, unknown>>((resolve, reject) => pending.set(requestId, { resolve, reject }))
    try {
      await session.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: requestId, method, params }) })
    } catch (error) {
      pending.delete(requestId)
      throw error
    }
    return response
  }
}

test("production toolbar popup demo journey", async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), "run-radar-chrome-"))
  const extension = path.resolve("build/chrome-mv3-prod")
  const evidenceRoot = testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-004"
  const evidence = path.resolve(evidenceRoot, "regression-003/demo-browser")
  await mkdir(evidence, { recursive: true })
  await mkdir(path.resolve(evidenceRoot, "regression-003/fix-ed2d"), { recursive: true })
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: false, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  })
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const extensionId = new URL(worker.url()).host
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest())
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.action?.default_popup).toBe("popup.html")
    expect((manifest.permissions ?? []).sort()).toEqual(["alarms", "nativeMessaging", "sidePanel", "storage"])
    expect(manifest.host_permissions ?? []).toEqual([])
    const browser = context.browser()
    if (!browser) throw new Error("Missing Chromium browser")
    const session = await browser.newBrowserCDPSession()
    await worker.evaluate(async () => { await chrome.action.openPopup() })
    const targets = await session.send("Target.getTargets")
    const target = targets.targetInfos.find(info => info.url === `chrome-extension://${extensionId}/popup.html`)
    if (!target) throw new Error("Chrome did not open the toolbar popup target")
    await writeFile(path.join(evidence, "browser-targets.json"), JSON.stringify(targets, null, 2))
    const attached = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false })
    const pageErrors: string[] = []
    const send = popupProtocol(session, attached.sessionId, pageErrors)
    await send("Runtime.enable")
    await send("Page.enable")
    await send("Runtime.runIfWaitingForDebugger")
    async function evaluate(expression: string) {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails))
      return (response.result as { value: unknown }).value
    }
    const count = () => evaluate('document.querySelectorAll(".run").length')
    const click = (label: string) => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`)
    const search = (value: string) => evaluate(`(() => { const input = document.querySelector('input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    async function screenshot(name: string) {
      const image = await send("Page.captureScreenshot", { format: "png" })
      await writeFile(path.join(evidence, name), Buffer.from(image.data as string, "base64"))
    }
    async function key(key: string, code: string, virtualKey: number) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, text: key === "Enter" ? "\r" : key === " " ? " " : undefined })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey })
    }
    await expect.poll(count).toBe(12)
    expect(await evaluate('document.body.textContent.includes("Demo mode")')).toBe(true)
    const geometry = await evaluate(`(() => { const list = document.querySelector('.run-list'); return {
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
      listWidth: list.clientWidth, listScrollWidth: list.scrollWidth, listHeight: list.clientHeight, listScrollHeight: list.scrollHeight
    }; })()`) as Record<string, number>
    expect(geometry.width).toBe(380)
    expect(geometry.height).toBe(572)
    expect(geometry.documentWidth).toBe(380)
    expect(geometry.listScrollWidth).toBe(geometry.listWidth)
    expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listHeight)
    const fixture = await evaluate('chrome.runtime.sendMessage({ type: "demo:list" })') as { ok: boolean; mode: string; snapshotAt: string; runs: { id: string; name: string; startedAt: string; status: string; durationMs: number; trigger: string }[] }
    expect(fixture.ok).toBe(true)
    expect(fixture.mode).toBe("demo")
    expect(fixture.snapshotAt).toBe("2026-10-03T18:30:00.000Z")
    const rows = await evaluate('Array.from(document.querySelectorAll(".run")).map(row => ({ text: row.textContent, startedAt: row.querySelector("time").dateTime }))') as { text: string; startedAt: string }[]
    for (const [index, run] of fixture.runs.entries()) {
      expect(rows[index].startedAt).toBe(run.startedAt)
      expect(rows[index].text).toContain(run.name)
      expect(rows[index].text).toContain(run.id)
      expect(rows[index].text).toContain(run.trigger)
      expect(rows[index].text).toContain((run.durationMs / 1000).toFixed(1) + "s")
      expect(rows[index].text.toLowerCase()).toContain(run.status)
    }
    await screenshot("popup-all.png")
    await click("Failed (3)")
    await expect.poll(count).toBe(3)
    await screenshot("popup-failed.png")
    await click("Running")
    await expect.poll(count).toBe(2)
    expect(await evaluate('document.body.textContent.includes("8.2s elapsed")')).toBe(true)
    await click("All runs")
    await search("sync_customers")
    await expect.poll(count).toBe(1)
    await search("019A-8EC4")
    await expect.poll(count).toBe(1)
    expect(await evaluate('document.querySelector(".run").textContent.includes("Process invoice queue")')).toBe(true)
    await search("no-matching-script")
    await expect.poll(count).toBe(0)
    expect(await evaluate('document.querySelector(".run-list [role=status]").textContent')).toContain("No matching runs")
    await screenshot("popup-empty.png")
    await search("")
    await evaluate('document.querySelector("input").focus()')
    await key("Tab", "Tab", 9)
    expect(await evaluate('document.activeElement.textContent')).toBe("All runs")
    await key("Tab", "Tab", 9)
    await key("Enter", "Enter", 13)
    await expect.poll(count).toBe(3)
    await key("Tab", "Tab", 9)
    await key(" ", "Space", 32)
    await expect.poll(count).toBe(2)
    await click("All runs")
    await expect.poll(count).toBe(12)
    await evaluate('document.querySelector(".run-list").focus()')
    await key("End", "End", 35)
    await expect.poll(() => evaluate('document.querySelector(".run-list").scrollTop')).toBeGreaterThan(0)
    await screenshot("popup-scroll.png")
    expect(await evaluate('chrome.runtime.sendMessage({ type: "unknown" })')).toEqual({ ok: false, error: "Unsupported demo request." })
    // Inject transport failure only inside this test. Production has no error switch.
    await evaluate('globalThis.__runRadarSendMessage = chrome.runtime.sendMessage; chrome.runtime.sendMessage = async () => { throw new Error("Injected transport failure") }')
    await evaluate('document.querySelector(".refresh").click()')
    await expect.poll(count).toBe(0)
    expect(await evaluate('document.querySelector("[role=alert]").textContent')).toContain("unavailable")
    await screenshot("popup-error.png")
    await evaluate('chrome.runtime.sendMessage = globalThis.__runRadarSendMessage; delete globalThis.__runRadarSendMessage; document.querySelector(".empty button").click()')
    await expect.poll(count).toBe(12)
    expect(pageErrors).toEqual([])
    await writeFile(path.join(evidence, "browser-observations.json"), JSON.stringify({
      browserVersion: browser.version(), extensionId, workerUrl: worker.url(), popupUrl: target.url,
      openedBy: "chrome.action.openPopup from production service worker, actual toolbar popup target",
      attachedBy: "Target.attachToTarget CDP session, no browser-tab substitute",
      geometry, pageErrors, fixtureRowsMatchWorkerResponse: true, observations: ["12 fixture runs", "3 failed", "2 running", "script search", "run-ID search", "empty search", "Tab, Enter, Space filters", "End scrolls list", "unsupported message rejected", "transport failure clears data and shows error", "Try again recovers"]
    }, null, 2))
    // Startup failure must retry discovery before choosing a data source.
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `
      globalThis.startupRequests = [];
      globalThis.discoveryRecovered = false;
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = async message => {
        startupRequests.push(message.type);
        if (message.type === 'connection:get') return discoveryRecovered
          ? { ok: true, connection: { instance: 'https://fixture.example', workspace: 'fixture' } }
          : { ok: false, code: 'helper_failure' };
        if (message.type === 'connection:pins') return { ok: true, connection: { instance: 'https://fixture.example', workspace: 'fixture' }, pins: [] };
        if (message.type === 'connection:refresh') return {
          ok: true, mode: 'live', instance: 'https://fixture.example', workspace: 'fixture',
          snapshotAt: '2026-10-03T18:30:00.000Z', runs: []
        };
        return original(message);
      };
    ` })
    await send("Page.reload")
    await expect.poll(() => evaluate('document.querySelector("[role=alert]")?.textContent')).toContain("helper failed")
    await click("Try again")
    await expect.poll(() => evaluate('startupRequests.length')).toBe(2)
    await expect.poll(() => evaluate('document.querySelector("[role=alert]")?.textContent')).toContain("helper failed")
    expect(await count()).toBe(0)
    expect(await evaluate('startupRequests')).toEqual(["connection:get", "connection:get"])
    await send("Page.captureScreenshot", { format: "png" }).then(image => writeFile(path.resolve(evidenceRoot, "regression-003/fix-ed2d/startup-failure.png"), Buffer.from(image.data as string, "base64")))
    const repeatedFailure = await evaluate('({ requests: [...startupRequests], rows: document.querySelectorAll(".run").length, mode: document.querySelector(".workspace strong").textContent })')
    await evaluate('globalThis.discoveryRecovered = true')
    await click("Try again")
    await expect.poll(() => evaluate('document.querySelector(".run-list [role=status]")?.textContent')).toContain("No recent top-level runs")
    expect(await evaluate('startupRequests')).toEqual(["connection:get", "connection:get", "connection:get", "connection:pins", "connection:refresh"])
    expect(await evaluate('document.querySelector(".workspace strong").textContent')).toBe("Live mode")
    expect(await evaluate('document.querySelector("[role=alert]")')).toBeNull()
    expect(pageErrors).toEqual([])
    await writeFile(path.resolve(evidenceRoot, "regression-003/fix-ed2d/startup-retry.json"), JSON.stringify({
      browserVersion: browser.version(), targetType: target.type,
      openedBy: "chrome.action.openPopup, production toolbar popup",
      injection: "Synthetic connection:get failure, then public live metadata and empty live response",
      action: "Try again twice; Demo button never selected", repeatedFailure,
      successfulRetry: await evaluate('({ requests: startupRequests, rows: document.querySelectorAll(".run").length, mode: document.querySelector(".workspace strong").textContent })'),
      implicitDemoRequests: 0, pageErrors
    }, null, 2))
  } finally {
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
