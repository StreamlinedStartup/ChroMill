import { test, expect, chromium } from "@playwright/test"
import { attach } from "./protocol"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rm, writeFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"

test("production selected run following completes and recovers in the native panel", async ({}, testInfo) => {
  test.setTimeout(180000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-007/browser", "follow")
  const profile = path.join(evidence, "profile")
  await mkdir(evidence, { recursive: true })
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile)
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), path.join(profile, "synthetic.fifo")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const item = await stream.next()
    if (item.done) throw new Error("Follow fixture exited")
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
    const id = new URL(worker.url()).host
    const registration = path.join(profile, "NativeMessagingHosts")
    const install = (fifo: string) => execFileSync("python3", [path.join(root, "native/install.py"), "install", "--extension-id", id, "--fifo", fifo, "--directory", registration], { cwd: root })
    const remove = () => execFileSync("python3", [path.join(root, "native/install.py"), "remove", "--directory", registration], { cwd: root })
    install(path.join(profile, "synthetic.fifo"))
    const options = await context.newPage()
    await options.goto(`chrome-extension://${id}/options.html`)
    const request = (message: Record<string, unknown>) => options.evaluate(async value => await chrome.runtime.sendMessage(value), message)
    const snapshot = await request({ type: "connection:connect", workspace: "fixture" })
    expect(snapshot.ok).toBe(true)
    const selection = { instance: snapshot.instance, workspace: "fixture", runId: snapshot.runs[2].id }
    const second = { ...selection, runId: snapshot.runs[0].id }
    await mode("follow_start")
    const web = await context.newPage()
    await web.goto("about:blank")
    const windowId = await options.evaluate(async () => {
      const { id } = await chrome.windows.getCurrent()
      if (id === undefined) throw new Error("Missing test browser window")
      return id
    })
    const browser = context.browser()!
    const session = await browser.newBrowserCDPSession()
    const target = async (page: string) => (await session.send("Target.getTargets")).targetInfos.find(info => info.url === `chrome-extension://${id}/${page}.html`)
    async function openPanel() {
      await web.bringToFront()
      await worker.evaluate(async windowId => {
        await chrome.windows.update(windowId, { focused: true })
        await chrome.action.openPopup({ windowId })
      }, windowId)
      await expect.poll(async () => Boolean(await target("popup"))).toBe(true)
      const popupInfo = (await target("popup"))!
      const popup = await attach(session, popupInfo.targetId)
      await expect.poll(() => popup.evaluate('document.querySelectorAll(".run").length')).toBe(5)
      await popup.evaluate(`document.getElementById("run-${selection.runId}").click()`)
      await expect.poll(() => popup.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')).toContain("starté")
      await popup.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Continue in side panel").focus()')
      await popup.key("Enter", "Enter", 13)
      await expect.poll(async () => Boolean(await target("sidepanel"))).toBe(true)
      await session.send("Target.closeTarget", { targetId: popupInfo.targetId })
      return attach(session, (await target("sidepanel"))!.targetId)
    }
    let panel = await openPanel()
    const logs = () => panel.evaluate('document.querySelector("[data-field=Logs] pre")?.textContent')
    const text = () => panel.evaluate('document.body.textContent')
    await expect.poll(logs).toBe("starté\npar")
    await expect.poll(text).toContain("Compatible polling every 2 seconds")
    await expect.poll(text).toContain("InProgress")
    await panel.screenshot(path.join(evidence, "start.png"))
    await mode("follow_progress")
    await expect.poll(logs, { timeout: 10000 }).toBe("starté\npartial line\nstep-a done\n")
    await expect.poll(text).toContain("Success")
    await mode("network")
    await expect.poll(text, { timeout: 10000 }).toContain("unreachable")
    await panel.screenshot(path.join(evidence, "interrupted.png"))
    await mode("follow_progress")
    await panel.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Try again").click()')
    await expect.poll(logs, { timeout: 10000 }).toBe("starté\npartial line\nstep-a done\n")
    await mode("follow_complete")
    await expect.poll(text, { timeout: 10000 }).toContain("Run completed")
    await expect.poll(logs).toBe("starté\npartial line\nstep-a done\nfinished\n")
    await expect.poll(text).toContain('"finished": true')
    await panel.screenshot(path.join(evidence, "completed.png"))
    const atCompletion = (await mode("follow_complete")).requests.length
    await options.waitForTimeout(2600)
    expect((await mode("follow_complete")).requests.length).toBe(atCompletion)
    observations.push("The actual toolbar opens the native panel by Enter. Fragmented UTF-8 HTTP responses show active flow steps and growing partial log lines. Network interruption stops polling. Try again restores the snapshot without duplicates. Completion fetches final result and stops requests.")
    for (const [failure, expected] of [["expired", "Authentication expired"], ["oversized", "too large"], ["large_logs", "last 64,000"]]) {
      await mode("follow_start")
      await request({ type: "connection:select", selection: second })
      await expect.poll(logs).toBe("starté\npar")
      await mode(failure)
      await expect.poll(text, { timeout: 10000 }).toContain(expected)
      await panel.screenshot(path.join(evidence, failure + ".png"))
      await mode("follow_start")
      await request({ type: "connection:select", selection })
      await expect.poll(logs).toBe("starté\npar")
    }
    // The delayed active response must not replace the newer completed identity.
    await mode("detail_delay")
    await options.waitForTimeout(2100)
    await mode("normal")
    await request({ type: "connection:select", selection: second })
    await expect.poll(text, { timeout: 10000 }).toContain("Run completed")
    await options.waitForTimeout(2300)
    expect(await panel.evaluate('document.querySelector(".identity").textContent')).toContain(second.runId)
    observations.push("Authentication expiration and response limits show recovery controls. Truncated logs show the bounded view and Windmill action. A canceled delayed reply cannot overwrite the newer identity.")
    await mode("follow_start")
    await request({ type: "connection:select", selection })
    await expect.poll(logs).toBe("starté\npar")
    await session.send("Target.closeTarget", { targetId: (await target("sidepanel"))!.targetId })
    await options.waitForTimeout(600)
    const afterClose = (await mode("follow_start")).requests.length
    await options.waitForTimeout(2600)
    expect((await mode("follow_start")).requests.length).toBe(afterClose)
    panel = await openPanel()
    await expect.poll(logs).toBe("starté\npar")
    await request({ type: "connection:disconnect" })
    await expect.poll(text).toContain("Select a live run")
    expect(await options.evaluate(async () => await chrome.storage.local.get(null))).toEqual({ timezone: expect.any(String) })
    observations.push("Closing the actual panel stops native follow requests. Reopening resumes the selected identity. Disconnect clears the panel and private durable state while retaining the timezone preference.")
    const fixtureReceipt = await mode("normal")
    expect(fixtureReceipt.requests.every((item: { method: string }) => item.method === "GET")).toBe(true)
    remove()
    let live: Record<string, unknown> = { compatible: false, activeJourneyProven: false, blocker: "Explicit synthetic mode does not read the root FIFO" }
    if (!testInfo.project.metadata.syntheticOnly && (await stat("/Users/vulture/src/tries/plasmo-test/.env").catch(() => null))?.isFIFO()) {
      install("/Users/vulture/src/tries/plasmo-test/.env")
      live = await options.evaluate(async () => {
        try {
          const workspaces = await chrome.runtime.sendMessage({ type: "connection:workspaces" })
          if (!workspaces.ok || !workspaces.workspaces.length) return { compatible: false, activeJourneyProven: false, stage: "workspaces", code: workspaces.code ?? "no_workspaces" }
          const recent = await chrome.runtime.sendMessage({ type: "connection:connect", workspace: workspaces.workspaces[0] })
          if (!recent.ok || !recent.runs.length) return { compatible: false, activeJourneyProven: false, stage: "recent", code: recent.code ?? "no_runs" }
          const run = recent.runs.find((item: { status: string }) => ["running", "queued"].includes(item.status)) ?? recent.runs[0]
          const selection = { instance: recent.instance, workspace: recent.workspace, runId: run.id }
          const detail = await chrome.runtime.sendMessage({ type: "connection:inspect", selection })
          return { compatible: detail.ok === true, activeJourneyProven: false, stage: "existing-read-only-endpoints", code: detail.code ?? null, status: run.status,
            fields: detail.ok ? Object.fromEntries(["logs", "steps", "result"].map(key => [key, detail.detail[key].state])) : null,
            limit: "No real job was submitted or changed. This receipt proves endpoint compatibility only." }
        } finally { await chrome.runtime.sendMessage({ type: "connection:disconnect" }) }
      })
      remove()
    }
    await writeFile(path.join(evidence, "live-compatibility.json"), JSON.stringify(live, null, 2))
    await writeFile(path.join(evidence, "browser.json"), JSON.stringify({ browserVersion: browser.version(), extensionId: id, manifest: await options.evaluate(() => chrome.runtime.getManifest()),
      syntheticJourneyProven: true, observations, fixtureRequests: fixtureReceipt.requests, live }, null, 2))
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
