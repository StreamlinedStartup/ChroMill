import { test, expect, chromium } from "@playwright/test"
import { attach } from "./protocol"
import { spawn, execFileSync } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import path from "node:path"
import type { Monitoring } from "../../../src/monitoring"

test("production workspace switching isolates identical IDs and delayed old responses", async ({}, testInfo) => {
  test.setTimeout(240000)
  const root = process.cwd()
  const evidence = path.join(root, testInfo.project.metadata.evidenceRoot ?? "evidence/WMLC-009/browser", "workspaces")
  const profile = path.join(evidence, "profile")
  await mkdir(evidence, { recursive: true })
  await rm(profile, { recursive: true, force: true })
  await mkdir(profile)
  const fixture = spawn("python3", ["-u", path.join(root, "tests/run-radar/native/browser_fixture.py"), path.join(profile, "synthetic.fifo")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
  const lines = createInterface({ input: fixture.stdout })
  const stream = lines[Symbol.asyncIterator]()
  async function next() {
    const item = await stream.next()
    if (item.done) throw new Error("Workspace fixture exited")
    return JSON.parse(item.value)
  }
  await next()
  async function mode(value: string) { fixture.stdin.write(JSON.stringify({ mode: value }) + "\n"); return next() }
  await mode("workspace_start")
  const extension = path.join(root, "build/chrome-mv3-prod")
  const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: false, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
  const observations: string[] = []
  const id3 = "00000000-0000-0000-0000-000000000003"
  const id2 = "00000000-0000-0000-0000-000000000002"
  let diagnostic = async (error: unknown) => { await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error) }, null, 2)) }
  try {
    let worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker")
    const id = new URL(worker.url()).host
    const registration = path.join(profile, "NativeMessagingHosts")
    execFileSync("python3", [path.join(root, "native/install.py"), "install", "--extension-id", id, "--fifo", path.join(profile, "synthetic.fifo"), "--directory", registration], { cwd: root })
    const options = await context.newPage()
    await options.goto(`chrome-extension://${id}/options.html`)
    const request = (message: Record<string, unknown>) => options.evaluate(async value => await chrome.runtime.sendMessage(value), message)
    await options.getByRole("button", { name: "Load workspaces" }).click()
    await expect(options.getByRole("combobox")).toHaveValue("fixture")
    expect(await options.locator("option").allTextContents()).toEqual(["fixture", "second"])
    await options.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(options.getByRole("status")).toContainText("Connected to fixture")
    const connection = (await request({ type: "connection:get" })).connection
    const identity = { ...connection, runId: id3 }
    const web = await context.newPage(); await web.goto("about:blank")
    const browser = context.browser()!
    const session = await browser.newBrowserCDPSession()
    const target = async (page: string) => (await session.send("Target.getTargets")).targetInfos.find(info => info.url === `chrome-extension://${id}/${page}.html`)
    async function openPopup() {
      worker = context.serviceWorkers().find(item => item.url().includes(id)) ?? await context.waitForEvent("serviceworker")
      await worker.evaluate(async () => await chrome.action.openPopup())
      await expect.poll(async () => Boolean(await target("popup"))).toBe(true)
      const info = (await target("popup"))!
      return { info, protocol: await attach(session, info.targetId) }
    }
    let popup = await openPopup()
    const body = () => popup.protocol.evaluate('document.body?.textContent ?? ""')
    const rows = () => popup.protocol.evaluate('Array.from(document.querySelectorAll(".path")).map(item => item.textContent).join(" | ")')
    const click = (text: string) => popup.protocol.evaluate(`Array.from(document.querySelectorAll("button")).find(button => button.textContent === ${JSON.stringify(text)}).click()`)
    const change = (scope: string) => popup.protocol.evaluate(`(()=>{const select=document.querySelector('[aria-label="Workspace"]');select.value=${JSON.stringify(scope)};select.dispatchEvent(new Event("change",{bubbles:true}));})()`)
    const badge = () => options.evaluate(async () => await chrome.action.getBadgeText({}))
    await expect.poll(rows).toContain("f/fixture/run")
    expect(await popup.protocol.evaluate("({width:innerWidth,height:innerHeight})")).toEqual({ width: 380, height: 572 })
    await popup.protocol.screenshot(path.join(evidence, "baseline.png"))
    await writeFile(path.join(evidence, "baseline.json"), JSON.stringify(await body()))
    await click("Workspaces")
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".workspace option").length')).toBe(2)
    await popup.protocol.evaluate(`document.querySelector('[aria-label="Pin run ${id3}"]').click()`)
    await expect.poll(body).toContain("Pinned (1)")
    await popup.protocol.evaluate(`document.getElementById("run-${id3}").click()`)
    await expect.poll(body).toContain("fixture private logs")
    await popup.protocol.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Continue in side panel").focus()')
    await popup.protocol.key("Enter", "Enter", 13)
    await expect.poll(async () => Boolean(await target("sidepanel"))).toBe(true)
    const panel = await attach(session, (await target("sidepanel"))!.targetId)
    const panelText = () => panel.evaluate('document.body?.textContent ?? ""')
    diagnostic = async error => {
      await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), popup: await body(), panel: await panelText(),
        storage: await options.evaluate(async () => await chrome.storage.local.get(null)), fixture: await mode("workspace_start") }, null, 2))
      await popup.protocol.screenshot(path.join(evidence, "failure.png"))
    }
    await expect.poll(panelText).toContain("fixture private logs")
    await expect.poll(panelText).toContain("Compatible polling")
    await panel.screenshot(path.join(evidence, "fixture-follow.png"))
    await click("Back")
    const start = (await mode("workspace_delay")).requests.length
    await popup.protocol.evaluate('document.querySelector(".refresh").click()')
    // Start independent old inspection work while the old list and panel follow are delayed.
    await options.evaluate(selection => { void chrome.runtime.sendMessage({ type: "connection:inspect", selection }) }, identity)
    await expect.poll(async () => (await mode("workspace_delay")).requests.slice(start).some((item: { namedPath: string }) => item.namedPath.includes("/fixture/jobs/list"))).toBe(true)
    await expect.poll(async () => (await mode("workspace_delay")).requests.slice(start).filter((item: { namedPath: string }) => item.namedPath.includes("/fixture/jobs_u/get/")).length, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
    await change("second")
    await expect.poll(rows).toContain("f/second/run")
    await expect.poll(body).toContain("Pinned (0)")
    await expect.poll(panelText).toContain("Select a live run")
    await options.waitForTimeout(4500)
    const delayed = (await mode("workspace_delay")).requests.slice(start).filter((item: { delayedSeconds?: number }) => item.delayedSeconds === 4)
    expect(delayed.length).toBeGreaterThanOrEqual(3)
    expect(delayed.every((item: { responseAttempted?: boolean }) => item.responseAttempted)).toBe(true)
    await writeFile(path.join(evidence, "delayed-responses.json"), JSON.stringify(delayed, null, 2))
    expect(await body()).not.toContain("f/fixture/run")
    expect(await panelText()).not.toContain("fixture private logs")
    expect(await badge()).toBe("")
    await popup.protocol.screenshot(path.join(evidence, "second-after-delay.png"))
    await panel.screenshot(path.join(evidence, "cleared-panel.png"))
    observations.push("The actual toolbar switches to second during delayed fixture list, detail, and follow reads. The native panel clears. Old payloads remain absent after the four-second responses are attempted.")
    await mode("workspace_start")
    await popup.protocol.evaluate(`document.querySelector('[aria-label="Pin run ${id3}"]').click()`)
    await expect.poll(body).toContain("Pinned (1)")
    await popup.protocol.evaluate(`document.getElementById("run-${id3}").click()`)
    await expect.poll(body).toContain("second private logs")
    await expect.poll(panelText).toContain("second private logs")
    await click("Back")
    await change("fixture")
    await expect.poll(rows).toContain("f/fixture/run")
    await expect.poll(body).toContain("Pinned (1)")
    // Accelerate this fault-injection alarm. The production one-minute alarm has separate regression coverage.
    await mode("workspace_failed")
    await options.evaluate(async () => await chrome.alarms.create("run-radar:recent", { when: Date.now() + 300, periodInMinutes: 1 }))
    await expect.poll(badge, { timeout: 20000 }).toBe("1")
    await change("second")
    await expect.poll(rows).toContain("f/second/run")
    await expect.poll(badge).toBe("")
    await change("fixture")
    await expect.poll(rows).toContain("f/fixture/run")
    await expect.poll(badge).toBe("1")
    await popup.protocol.screenshot(path.join(evidence, "restored-count.png"))
    await popup.protocol.evaluate(`document.getElementById("run-${id3}").click()`)
    await expect.poll(body).toContain("fixture private logs")
    await expect.poll(badge).toBe("")
    await click("Back")
    const saved = await options.evaluate(async () => await chrome.storage.local.get(null)) as { pins: unknown; monitoring: Monitoring; monitoringScopes: Monitoring[] }
    expect(saved.pins).toEqual(expect.arrayContaining([identity, { ...identity, workspace: "second" }]))
    expect(saved.monitoring.workspace).toBe("fixture")
    expect(saved.monitoring.records.find((record: { id: string }) => record.id === id3)?.seen).toBe(true)
    expect(saved.monitoringScopes[0].workspace).toBe("second")
    expect(JSON.stringify(saved)).not.toContain("private logs")
    expect(JSON.stringify(saved)).not.toContain("f/fixture")
    await writeFile(path.join(evidence, "scoped-storage.json"), JSON.stringify(saved, null, 2))
    observations.push("Identical run IDs produce separate pins and monitoring records. Switching back restores the unseen count and cursor. Successful selected inspection changes only that scope's seen flag. Durable storage excludes private metadata.")
    // Kill the production worker, wake it through an authorized extension page, then reopen the actual popup.
    await session.send("Target.closeTarget", { targetId: popup.info.targetId })
    const workerTarget = (await session.send("Target.getTargets")).targetInfos.find(info => info.type === "service_worker" && info.url === worker.url())
    if (!workerTarget) throw new Error("Missing worker target")
    await session.send("Target.closeTarget", { targetId: workerTarget.targetId })
    expect((await request({ type: "connection:monitor" })).monitoring).toEqual(saved.monitoring)
    popup = await openPopup()
    await expect.poll(rows).toContain("f/fixture/run")
    await click("Workspaces")
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".workspace option").length')).toBe(2)
    await mode("workspace_empty"); await change("second")
    await expect.poll(body).toContain("No recent top-level runs")
    await popup.protocol.screenshot(path.join(evidence, "empty.png"))
    await mode("workspace_revoked")
    await change("fixture"); await expect.poll(rows).toContain("f/fixture/run")
    await change("second")
    await expect.poll(body).toContain("Workspace access is denied")
    expect(await rows()).toBe("")
    expect(await badge()).toBe("ERR")
    await popup.protocol.screenshot(path.join(evidence, "permission-denied.png"))
    await mode("workspace_start"); await click("Try again")
    await expect.poll(rows).toContain("f/second/run")
    // Comparison stays scoped and is canceled by switching, with the same IDs in both scopes.
    await change("fixture"); await expect.poll(rows).toContain("f/fixture/run")
    await popup.protocol.evaluate(`document.getElementById("run-${id2}").click()`)
    await expect.poll(panelText).toContain(id2)
    await expect.poll(panelText).toContain("fixture private logs")
    const compareStart = (await mode("workspace_delay")).requests.length
    await panel.evaluate('Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Compare").click()')
    await expect.poll(async () => (await mode("workspace_delay")).requests.slice(compareStart).some((item: { delayedSeconds?: number }) => item.delayedSeconds === 4)).toBe(true)
    await click("Back"); await change("second")
    await expect.poll(panelText).toContain("Select a live run")
    await options.waitForTimeout(4500)
    expect(await panelText()).not.toContain("fixture private logs")
    // Rapid toolbar switches must leave only the last chosen scope visible.
    await mode("workspace_start")
    for (const scope of ["fixture", "second", "fixture", "second"]) await change(scope)
    await expect.poll(rows).toContain("f/second/run")
    expect(await rows()).not.toContain("f/fixture/run")
    await popup.protocol.screenshot(path.join(evidence, "rapid-final.png"))
    observations.push("The production worker restarts with scoped state. Empty and revoked workspaces show explicit states. Retry restores access. Comparison clears during switching. Rapid toolbar changes retain only the final workspace.")
    await mode("workspace_delay")
    await change("fixture")
    await expect.poll(async () => (await request({ type: "connection:get" })).connection.workspace).toBe("fixture")
    await popup.protocol.evaluate('document.querySelector(".refresh").click()')
    await expect.poll(rows, { timeout: 15000 }).toContain("f/fixture/run")
    await mode("workspace_start")
    const externalSwitch = await request({ type: "connection:switch", workspace: "second" })
    if (!externalSwitch.ok) expect(externalSwitch).toMatchObject({ code: "request_canceled" })
    expect((await request({ type: "connection:get" })).connection.workspace).toBe("second")
    await expect.poll(rows).toContain("f/second/run")
    expect(await rows()).not.toContain("f/fixture/run")
    await popup.protocol.screenshot(path.join(evidence, "refresh-external-switch.png"))
    await writeFile(path.join(evidence, "refresh-switch-race.json"), JSON.stringify({ externalSwitch, actualConnection: (await request({ type: "connection:get" })).connection.workspace, visibleRows: await rows(), body: await body() }, null, 2))
    observations.push("Refresh supersedes a delayed switch. A later external switch updates the label and rows to second without fixture payloads.")
    await mode("workspace_discovery_delay"); await click("Workspaces")
    await expect.poll(body).toContain("Loading...")
    await mode("workspace_start")
    const discoverySwitch = await request({ type: "connection:switch", workspace: "fixture" })
    if (!discoverySwitch.ok) expect(discoverySwitch).toMatchObject({ code: "request_canceled" })
    expect((await request({ type: "connection:get" })).connection.workspace).toBe("fixture")
    await expect.poll(rows).toContain("f/fixture/run")
    await click("Workspaces")
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".workspace option").length')).toBe(2)
    await mode("workspace_discovery_delay"); await click("Workspaces")
    await expect.poll(body).toContain("Loading...")
    expect(await request({ type: "connection:disconnect" })).toMatchObject({ ok: true })
    await expect.poll(body).toContain("Demo mode")
    await mode("workspace_start")
    const reconnected = await request({ type: "connection:connect", workspace: "second" })
    if (!reconnected.ok) expect(reconnected).toMatchObject({ code: "request_canceled" })
    expect((await request({ type: "connection:get" })).connection.workspace).toBe("second")
    await expect.poll(rows).toContain("f/second/run")
    await click("Workspaces")
    await expect.poll(() => popup.protocol.evaluate('document.querySelectorAll(".workspace option").length')).toBe(2)
    await options.waitForTimeout(4500)
    expect(await body()).not.toContain("Loading...")
    expect(await rows()).not.toContain("f/fixture/run")
    await popup.protocol.screenshot(path.join(evidence, "discovery-reconnected.png"))
    observations.push("External switching and disconnect cancel delayed discovery. Reconnect restores an enabled selector and successful discovery, even after old responses settle.")
    const replyRaces: unknown[] = []
    for (const action of ["switch", "disconnect"]) {
      for (const successful of [true, false]) {
        await mode("workspace_start")
        const current = await request({ type: "connection:get" })
        if (!current.connection) {
          const connected = await request({ type: "connection:connect", workspace: "second" })
          if (!connected.ok) expect(connected).toMatchObject({ code: "request_canceled" })
        }
        await expect.poll(rows).toContain("f/second/run")
        await popup.protocol.evaluate(`document.querySelector('[aria-label="Pin run ${id3}"]')?.click()`)
        await expect.poll(body).toContain("Pinned (1)")
        await popup.protocol.evaluate(`document.getElementById("run-${id3}").click()`)
        await expect.poll(panelText).toContain("second private logs")
        await click("Back")
        await click("Workspaces")
        await expect.poll(() => popup.protocol.evaluate('document.querySelector(".workspace button").disabled')).toBe(false)
        await expect.poll(() => popup.protocol.evaluate('Array.from(document.querySelectorAll(".workspace option")).map(item=>item.value)')).toEqual(["second", "fixture"])
        // Hold delivery of the real worker reply. Storage events and native work stay active.
        await popup.protocol.evaluate(`(()=>{
          const send=chrome.runtime.sendMessage.bind(chrome.runtime);
          window.__switchHeld=false;window.__switchDelivered=false;
          window.__restoreSend=()=>{chrome.runtime.sendMessage=send;};
          chrome.runtime.sendMessage=async (...args)=>{
            const result=await send(...args);
            if(args[0]?.type==="connection:switch"){
              window.__switchResult=result;
              await new Promise(resolve=>{window.__releaseSwitch=resolve;window.__switchHeld=true;});
              window.__switchDelivered=true;
            }
            return result;
          };
        })()`)
        if (!successful) await mode("workspace_delay")
        await change("fixture")
        await expect.poll(async () => (await request({ type: "connection:get" })).connection.workspace).toBe("fixture")
        if (successful) {
          await expect.poll(() => popup.protocol.evaluate('window.__switchHeld')).toBe(true)
          expect(await popup.protocol.evaluate('window.__switchResult.ok')).toBe(true)
        } else {
          await expect.poll(async () => (await mode("workspace_delay")).requests.some((item: { namedPath: string; delayedSeconds?: number; responseAttempted?: boolean }) =>
            item.namedPath.includes("/fixture/jobs/list") && item.delayedSeconds === 4 && !item.responseAttempted)).toBe(true)
          await mode("workspace_start")
        }
        const external = await request({ type: action === "disconnect" ? "connection:disconnect" : "connection:switch", ...(action === "switch" ? { workspace: "second" } : {}) })
        if (!external.ok) expect(external).toMatchObject({ code: "request_canceled" })
        await expect.poll(body).toContain(action === "disconnect" ? "Demo mode" : `${connection.instance} / second`)
        await expect.poll(panelText).toContain("Select a live run")
        await expect.poll(() => popup.protocol.evaluate('window.__switchHeld')).toBe(true)
        expect(await popup.protocol.evaluate('window.__switchResult.ok')).toBe(successful)
        if (!successful) expect(await popup.protocol.evaluate('window.__switchResult.code')).toBe("request_canceled")
        await popup.protocol.evaluate('window.__releaseSwitch()')
        await expect.poll(() => popup.protocol.evaluate('window.__switchDelivered')).toBe(true)
        await options.waitForTimeout(4500)
        expect(await rows()).not.toContain("f/fixture/run")
        expect(await body()).not.toContain(`${connection.instance} / fixture`)
        expect(await body()).not.toContain("fixture private logs")
        expect(await body()).not.toContain("second private logs")
        expect(await panelText()).not.toContain("private logs")
        expect(await popup.protocol.evaluate('document.querySelector(".inspection")')).toBeNull()
        const storage = await options.evaluate(async () => await chrome.storage.local.get(null))
        if (action === "disconnect") {
          expect(storage).toEqual({ timezone: expect.any(String) })
          expect(await badge()).toBe("")
          expect(await options.evaluate(async () => await chrome.alarms.get("run-radar:recent"))).toBeUndefined()
          expect(await body()).not.toContain("Live mode")
          expect(await body()).not.toContain("Pinned (")
          expect(await popup.protocol.evaluate('document.querySelectorAll(".pin").length')).toBe(0)
        } else {
          expect(storage.connection).toEqual({ ...connection, workspace: "second" })
          expect(storage.selection).toBeNull()
          expect(await rows()).toContain("f/second/run")
          expect(await body()).toContain("Pinned (1)")
        }
        const name = `reply-${action}-${successful ? "success" : "canceled"}`
        await popup.protocol.screenshot(path.join(evidence, `${name}.png`))
        await panel.screenshot(path.join(evidence, `${name}-panel.png`))
        replyRaces.push({ action, successful, realReply: await popup.protocol.evaluate('({ok:window.__switchResult.ok,code:window.__switchResult.code})'),
          popup: await body(), panel: await panelText(), storage, withoutRefresh: true })
        await popup.protocol.evaluate('window.__restoreSend()')
      }
    }
    await writeFile(path.join(evidence, "reply-delivery-races.json"), JSON.stringify(replyRaces, null, 2))
    observations.push("External disconnect and switching to a different scope supersede held successful and canceled real switch replies without refresh. Late delivery cannot restore prior rows, labels, pins, selection, or private panel content.")
    const receipt = await mode("workspace_start")
    expect(receipt.requests.every((item: { method: string; authenticated: boolean }) => item.method === "GET" && item.authenticated)).toBe(true)
    observations.push("Disconnect during a delayed switch clears every scope, alarm, badge, and panel. All fixture HTTP operations use authenticated GET requests. The test never reads the root FIFO or mutates a real instance.")
    await writeFile(path.join(evidence, "browser.json"), JSON.stringify({ browserVersion: browser.version(), extensionId: id,
      manifest: await options.evaluate(() => chrome.runtime.getManifest()), observations, fixtureRequests: receipt.requests, syntheticOnly: true }, null, 2))
    execFileSync("python3", [path.join(root, "native/install.py"), "remove", "--directory", registration], { cwd: root })
  } catch (error) {
    await diagnostic(error)
    throw error
  } finally {
    await context.close()
    fixture.stdin.end()
    await new Promise<void>(resolve => { if (fixture.exitCode !== null) resolve(); else { fixture.once("exit", () => resolve()); setTimeout(() => { fixture.kill(); resolve() }, 2000).unref() } })
    lines.close()
    await rm(profile, { recursive: true, force: true })
  }
})
