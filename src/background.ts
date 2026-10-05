import { handleDemoRequest } from "./demo"
import { MONITOR_ALARM } from "./monitoring"
import { createLiveWorker } from "./live-worker"

const trustedStorage = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
])
const live = createLiveWorker(chrome.runtime, chrome.storage.local, { alarms: chrome.alarms, action: chrome.action },
  { session: chrome.storage.session, permissions: chrome.permissions })

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (message && typeof message === "object" && "type" in message && /^(connection|credentials):/.test(String(message.type))) {
    void trustedStorage.then(() => live(message, sender)).then(sendResponse, () => sendResponse({ ok: false, code: "storage_failure" }))
    return true
  }
  sendResponse(handleDemoRequest(message, sender, chrome.runtime.id))
  return false
})

// Register synchronously so production worker wake-up can receive alarm events.
const restore = () => { void trustedStorage.then(() => live.restore()).catch(() => live.failureIndicator()) }
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MONITOR_ALARM) void live.poll().catch(() => live.failureIndicator())
})
chrome.runtime.onStartup.addListener(restore)
chrome.runtime.onInstalled.addListener(restore)
restore()

chrome.runtime.onConnect?.addListener(port => live.follow(port))
