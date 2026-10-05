import { browserTimezone, validTimezone } from "./timezones"
import { isFollowResponse, isSelection, runUrl, sameSelection } from "./inspection"
import { HOST, isConnection, isNativeResponse, workspaceId, pageNumber, historyTarget } from "./connection"
import { isMonitoring, refreshMonitoring, monitorDisplay, MONITOR_ALARM, POLL_MINUTES, RECORD_LIMIT } from "./monitoring"
import type { Monitoring } from "./monitoring"
import type { NativeResponse } from "./connection"
import { isComparisonResponse } from "./comparison"
import { CREDENTIALS, CredentialError, createCredentialStore, credentialInput } from "./credentials"
import { directRequest } from "./direct-transport"

// Private run content is never cached. Credentials use a separate encrypted record.
export function createLiveWorker(runtime: typeof chrome.runtime, storage: chrome.storage.StorageArea, services?: { alarms: typeof chrome.alarms; action: typeof chrome.action; now?: () => number },
  credentialServices?: { session: chrome.storage.StorageArea; permissions: typeof chrome.permissions; fetch?: typeof fetch }) {
  const credentials = credentialServices ? createCredentialStore(storage, credentialServices.session) : null
  let generation = 0
  let listGeneration = 0
  let browseGeneration = 0
  let browseCancel: (() => void) | null = null
  const cancellations = new Map<() => void, boolean>()
  let writes = Promise.resolve()
  const serialized = <T,>(action: () => Promise<T>) => {
    const pending = writes.then(action)
    writes = pending.then(() => {}, () => { /* The caller receives the failure. Later reads still wait for settlement. */ })
    return pending
  }
  const now = () => services?.now?.() ?? Date.now()
  async function display(state: Monitoring | null) {
    if (!services) return
    const badge = monitorDisplay(state, now())
    await services.action.setBadgeBackgroundColor({ color: badge.color })
    await services.action.setBadgeText({ text: badge.text })
    await services.action.setTitle({ title: badge.title })
  }
  const monitorKeys = ["connection", "monitoring", "monitoringScopes"]
  const sameScope = (a: import("./connection").Connection, b: import("./connection").Connection) => a.instance === b.instance && a.workspace === b.workspace
  function scopes(state: Record<string, unknown>): Monitoring[] {
    const retained = state.monitoringScopes ?? []
    if (!Array.isArray(retained) || retained.length > 20 || !retained.every(isMonitoring) ||
      retained.some((item, index) => retained.slice(0, index).some(other => sameScope(item, other)))) throw new Error("Invalid retained monitoring")
    if (state.monitoring !== undefined && state.monitoring !== null && !isMonitoring(state.monitoring)) throw new Error("Invalid monitoring state")
    return isMonitoring(state.monitoring) ? [...retained.filter(item => !sameScope(item, state.monitoring as Monitoring)), state.monitoring] : retained
  }
  function monitor(state: Record<string, unknown>, connection = state.connection): Monitoring | null {
    const retained = scopes(state)
    return isConnection(connection) ? retained.find(item => sameScope(item, connection)) ?? null : null
  }
  function monitorWrite(state: Record<string, unknown>, next: Monitoring | null, connection = state.connection) {
    const retained = scopes(state).filter(item => !isConnection(connection) || !sameScope(item, connection))
    if (retained.length > 20) throw new Error("Monitoring scope limit")
    return { monitoring: next, ...(retained.length || state.monitoringScopes !== undefined ? { monitoringScopes: retained } : {}) }
  }
  function failedMonitor(state: Record<string, unknown>, error: string): Monitoring | null {
    if (!isConnection(state.connection)) return null
    const previous = monitor(state) ?? { ...state.connection, cursor: "1970-01-01T00:00:00.000Z",
      snapshotAt: "1970-01-01T00:00:00.000Z", lastSuccess: 0, records: [] }
    return { ...previous, gap: true, error }
  }
  async function schedule() {
    if (services && !await services.alarms.get(MONITOR_ALARM)) await services.alarms.create(MONITOR_ALARM, { periodInMinutes: POLL_MINUTES })
  }
  async function restore() {
    await serialized(async () => {
      const state = await storage.get(monitorKeys)
      if (isConnection(state.connection)) {
        await schedule()
        if (credentials && (await credentials.status()).locked) await display(failedMonitor(state, "credentials_locked"))
        else await display(monitor(state))
      } else {
        if (services) await services.alarms.clear(MONITOR_ALARM)
        await display(null)
      }
    })
  }
  let polling: Promise<void> | null = null
  function poll(): Promise<void> {
    if (polling) return polling
    polling = (async () => {
      const current = generation
      const currentList = listGeneration
      await writes
      const state = await storage.get(monitorKeys)
      if (current !== generation || currentList !== listGeneration || !isConnection(state.connection)) return
      const connection = state.connection
      const response = await native({ op: "recent", ...connection })
      await serialized(async () => {
        if (current !== generation || currentList !== listGeneration) return
        const saved = await storage.get(monitorKeys)
        if (current !== generation || currentList !== listGeneration) return
        if (!isConnection(saved.connection) || saved.connection.instance !== connection.instance || saved.connection.workspace !== connection.workspace) return
        const previous = monitor(saved)
        let next: Monitoring | null = previous
        if (response.ok && "mode" in response && !("page" in response) && response.instance === connection.instance && response.workspace === connection.workspace) next = refreshMonitoring(previous, response, now())
        else next = failedMonitor(saved, response.ok ? "response_invalid" : response.code)
        if (next) await storage.set(monitorWrite(saved, next))
        await display(next)
      })
    })().finally(() => { polling = null })
    return polling
  }
  async function failureIndicator() {
    await serialized(async () => {
      if (!services) return
      const saved = await storage.get("connection")
      if (!isConnection(saved.connection)) { await display(null); return }
      await services.action.setBadgeText({ text: "ERR" })
      await services.action.setTitle({ title: "ChroMill: monitoring state failed. Reconnect and try again." })
    })
  }
  const follows = new Set<() => void>()
  function stop(listOnly = false) {
    if (!listOnly) for (const cancel of follows) cancel()
    if (!listOnly) generation++
    listGeneration++
    for (const [cancel, inspection] of cancellations) {
      if (!listOnly || !inspection) cancel()
    }
  }
  function native(message: Record<string, unknown>, onCancel?: (cancel: () => void) => void): Promise<NativeResponse> {
    if (!credentials || !credentialServices) return nativeHost(message, onCancel)
    const controller = new AbortController()
    let hostCancel: (() => void) | undefined
    const cancel = () => { controller.abort(); hostCancel?.() }
    cancellations.set(cancel, ["inspect", "follow", "compare"].includes(String(message.op)))
    onCancel?.(cancel)
    const timeout = setTimeout(() => controller.abort("timeout"), message.op === "compare" ? 60000 : 15000)
    return (async (): Promise<NativeResponse> => {
      try {
        const saved = await serialized(async () => {
          if (controller.signal.aborted) throw new CredentialError("request_canceled")
          return credentials.read()
        })
        if (controller.signal.aborted) return { ok: false, code: "request_canceled" }
        const response = saved ? await directRequest(saved, message, controller.signal, credentialServices.permissions, credentialServices.fetch) :
          await nativeHost(message, value => { hostCancel = value; if (controller.signal.aborted) value() })
        return controller.signal.reason === "timeout" ? { ok: false, code: "network_timeout" } : response
      } catch (error) { return { ok: false, code: error instanceof CredentialError ? error.code : "storage_failure" } }
      finally { clearTimeout(timeout); cancellations.delete(cancel) }
    })()
  }
  function nativeHost(message: Record<string, unknown>, onCancel?: (cancel: () => void) => void): Promise<NativeResponse> {
    return new Promise(resolve => {
      let port: chrome.runtime.Port
      try { port = runtime.connectNative(HOST) }
      catch { resolve({ ok: false, code: "helper_missing" }); return }
      let settled = false
      const timer = setTimeout(() => finish({ ok: false, code: "network_timeout" }), message.op === "compare" ? 60000 : 15000)
      function finish(response: NativeResponse) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        port.disconnect()
        cancellations.delete(cancel)
        resolve(response)
      }
      const cancel = () => finish({ ok: false, code: "request_canceled" })
      cancellations.set(cancel, ["inspect", "follow", "compare"].includes(String(message.op)))
      onCancel?.(cancel)
      if (settled) return
      port.onMessage.addListener(value => finish(isNativeResponse(value) ? value : { ok: false, code: "response_invalid" }))
      port.onDisconnect.addListener(() => {
        // Reading lastError prevents Chrome from logging unsanitized diagnostics.
        void runtime.lastError
        finish({ ok: false, code: "helper_missing" })
      })
      try { port.postMessage(message) }
      catch { finish({ ok: false, code: "helper_failure" }) }
    })
  }
  const handle = async (message: unknown, sender: chrome.runtime.MessageSender, onCancel?: (cancel: () => void) => void, isCanceled = () => false): Promise<unknown> => {
    if (sender.id !== runtime.id || !["popup.html", "options.html", "sidepanel.html"].some(page => sender.url === `chrome-extension://${runtime.id}/${page}`)) {
      return { ok: false, code: "request_invalid" }
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false, code: "request_invalid" }
    const request = message as Record<string, unknown>
    const type = request.type
    if (typeof type === "string" && type.startsWith("credentials:")) {
      if (!credentials || !credentialServices || sender.url !== `chrome-extension://${runtime.id}/options.html`) return { ok: false, code: "request_invalid" }
      const expected = ["credentials:save", "credentials:replace"].includes(type) ? "apiKey,instance,password,type" : type === "credentials:unlock" ? "password,type" : "type"
      if (!["credentials:get", "credentials:save", "credentials:replace", "credentials:unlock", "credentials:lock", "credentials:remove"].includes(type) ||
        Object.keys(request).sort().join(",") !== expected ||
        ["credentials:save", "credentials:replace"].includes(type) && !credentialInput(request.instance, request.apiKey, request.password)) return { ok: false, code: "credentials_invalid" }
      if (type === "credentials:get") {
        try { await writes; return await credentials.status() } catch (error) { return { ok: false, code: error instanceof CredentialError ? error.code : "storage_failure" } }
      }
      stop()
      let result: unknown
      try {
        await serialized(async () => {
          stop()
          try {
            if (["credentials:save", "credentials:replace"].includes(type)) {
              if (!await credentialServices.permissions.contains({ origins: [String(request.instance) + "/*"] })) throw new CredentialError("permission_denied")
              if (!!await credentials.record() !== (type === "credentials:replace")) throw new CredentialError("credentials_conflict")
              await credentials.lock()
              await storage.remove(["connection", "selection", "pins", "monitoring", "monitoringScopes"])
              if (services) await services.alarms.clear(MONITOR_ALARM)
              await display(null)
              await credentials.save(request.instance as string, request.apiKey as string, request.password as string, type === "credentials:replace")
            } else if (type === "credentials:unlock") await credentials.unlock(request.password)
            else if (type === "credentials:lock") await credentials.lock()
            else {
              // Keep the record locked until scope cleanup succeeds. A cleanup
              // failure must not expose an old connection to the host route.
              await credentials.lock()
              await storage.remove(["connection", "selection", "pins", "monitoring", "monitoringScopes"])
              if (services) await services.alarms.clear(MONITOR_ALARM)
              await display(null)
              await credentials.remove()
            }
            const state = await storage.get(monitorKeys)
            if (type === "credentials:lock" && isConnection(state.connection)) {
              const next = failedMonitor(state, "credentials_locked")
              if (next) await storage.set(monitorWrite(state, next))
              await display(next)
            }
            result = await credentials.status()
          } finally {
            // Requests started during a mutation cannot commit its previous scope
            // or fall back to the host after removal, including on storage failure.
            stop()
          }
        })
        if (type === "credentials:unlock") await poll()
        return result
      } catch (error) { return { ok: false, code: error instanceof CredentialError ? error.code : "storage_failure" } }
    }
    if (typeof type !== "string" || !["connection:flows", "connection:history", "connection:get", "connection:status", "connection:workspaces", "connection:connect", "connection:switch", "connection:refresh", "connection:disconnect", "connection:select", "connection:selection", "connection:inspect", "connection:open", "connection:pins", "connection:pin", "connection:unpin", "connection:monitor", "connection:timezone", "connection:timezone-save"].includes(type) ||
      Object.keys(request).sort().join(",") !== (type === "connection:flows" ? "page,type" : type === "connection:history" ? "flowKind,flowPath,page,type" : type === "connection:timezone-save" ? "timezone,type" : ["connection:connect", "connection:switch"].includes(type) ? "type,workspace" : ["connection:select", "connection:inspect", "connection:open", "connection:pin", "connection:unpin"].includes(type) ? "selection,type" : "type") ||
      ["connection:connect", "connection:switch"].includes(type) && !workspaceId(request.workspace)) return { ok: false, code: "request_invalid" }
    if (["connection:select", "connection:inspect", "connection:open", "connection:pin", "connection:unpin"].includes(type) && !isSelection(request.selection)) return { ok: false, code: "request_invalid" }
    if (type === "connection:timezone-save" && !validTimezone(request.timezone)) return { ok: false, code: "request_invalid" }
    if (["connection:flows", "connection:history"].includes(type) && (!pageNumber(request.page) ||
      type === "connection:history" && !historyTarget(request.flowPath, request.flowKind))) return { ok: false, code: "request_invalid" }
    try {
      if (["connection:flows", "connection:history"].includes(type)) {
        const browse = ++browseGeneration
        browseCancel?.()
        browseCancel = null
        const current = generation
        await writes
        const saved = await storage.get("connection")
        if (current !== generation || browse !== browseGeneration) return { ok: false, code: "request_canceled" }
        if (!isConnection(saved.connection)) return { ok: false, code: "request_invalid" }
        const response = await native({ op: type === "connection:flows" ? "flows" : "history", ...saved.connection,
          page: request.page, ...(type === "connection:history" ? { flowPath: request.flowPath, flowKind: request.flowKind } : {}) }, cancel => { browseCancel = cancel })
        if (browse === browseGeneration) browseCancel = null
        if (current !== generation || browse !== browseGeneration) return { ok: false, code: "request_canceled" }
        if (response.ok && (!("page" in response) || response.page !== request.page || response.instance !== saved.connection.instance ||
          response.workspace !== saved.connection.workspace || (type === "connection:flows" ? !("flows" in response) : !("flowPath" in response) || response.flowPath !== request.flowPath || response.flowKind !== request.flowKind))) return { ok: false, code: "response_invalid" }
        return response
      }
      if (type === "connection:timezone" || type === "connection:timezone-save") {
        let timezone = browserTimezone()
        await serialized(async () => {
          const state = await storage.get("timezone")
          if (type === "connection:timezone-save") {
            timezone = request.timezone as string
            await storage.set({ timezone })
          } else {
            if (state.timezone !== undefined && !validTimezone(state.timezone)) throw new Error("Invalid timezone preference")
            timezone = state.timezone ?? timezone
            if (state.timezone === undefined) await storage.set({ timezone })
          }
        })
        return { ok: true, timezone }
      }
      if (type === "connection:monitor") {
        await writes
        const state = await storage.get(monitorKeys)
        if (credentials && (await credentials.status()).locked) return { ok: true, monitoring: failedMonitor(state, "credentials_locked") }
        return { ok: true, monitoring: monitor(state) }
      }
      if (["connection:pins", "connection:pin", "connection:unpin"].includes(type)) {
        const current = generation
        let result: unknown = { ok: false, code: "request_canceled" }
        await serialized(async () => {
          if (current !== generation) return
          const state = await storage.get(["connection", "pins"])
          if (current !== generation) return
          if (!isConnection(state.connection)) { result = { ok: false, code: "request_invalid" }; return }
          if (state.pins !== undefined && (!Array.isArray(state.pins) || state.pins.length > 1000 || !state.pins.every(isSelection))) {
            result = { ok: false, code: "response_invalid" }; return
          }
          let pins = (state.pins ?? []) as import("./inspection").Selection[]
          if (type !== "connection:pins" && isSelection(request.selection)) {
            const selection = request.selection
            if (selection.instance !== state.connection.instance || selection.workspace !== state.connection.workspace) {
              result = { ok: false, code: "request_invalid" }; return
            }
            pins = pins.filter(pin => !sameSelection(pin, selection))
            if (type === "connection:pin") {
              if (pins.length >= 1000) { result = { ok: false, code: "response_too_large" }; return }
              pins.push(selection)
            }
            await storage.set({ pins })
            if (current !== generation) return
          }
          const connection = state.connection
          result = { ok: true, connection, pins: pins.filter(pin => pin.instance === connection.instance && pin.workspace === connection.workspace) }
        })
        return result
      }
      if (type === "connection:selection") {
        await writes
        const state = await storage.get(["connection", "selection"])
        const selection = isSelection(state.selection) && isConnection(state.connection) &&
          state.selection.instance === state.connection.instance && state.selection.workspace === state.connection.workspace ? state.selection : null
        return { ok: true, selection }
      }
      if (["connection:select", "connection:inspect", "connection:open"].includes(type) && isSelection(request.selection)) {
        const selection = request.selection
        if (type === "connection:select") {
          let accepted = false
          await serialized(async () => {
            const current = generation
            const state = await storage.get(["connection", "selection"])
            if (current !== generation) return
            if (!isConnection(state.connection) || state.connection.instance !== selection.instance || state.connection.workspace !== selection.workspace) return
            if (!isSelection(state.selection) || state.selection.instance !== selection.instance || state.selection.workspace !== selection.workspace || state.selection.runId !== selection.runId) {
              stop()
              await storage.set({ selection })
            }
            accepted = true
          })
          return accepted ? { ok: true } : { ok: false, code: "request_invalid" }
        }
        const current = generation
        await writes
        const state = await storage.get("connection")
        if (isCanceled() || current !== generation) return { ok: false, code: "request_canceled" }
        if (!isConnection(state.connection) || state.connection.instance !== selection.instance || state.connection.workspace !== selection.workspace) return { ok: false, code: "request_invalid" }
        if (type === "connection:open") {
          await chrome.tabs.create({ url: runUrl(selection) })
          return { ok: true }
        }
        const response = await native({ op: "inspect", ...selection }, onCancel)
        if (isCanceled() || current !== generation) return { ok: false, code: "request_canceled" }
        if (response.ok && (!("detail" in response) || response.instance !== selection.instance || response.workspace !== selection.workspace || response.runId !== selection.runId)) return { ok: false, code: "response_invalid" }
        if (response.ok && "detail" in response && response.detail.run.status === "failed") {
          await serialized(async () => {
            if (current !== generation) return
            const saved = await storage.get([...monitorKeys, "selection"])
            if (current !== generation) return
            if (!isSelection(saved.selection) || !sameSelection(saved.selection, selection)) return
            const monitoring = monitor(saved)
            if (!monitoring) return
            const record = monitoring.records.find(item => item.id === selection.runId)
            if (record) { record.status = "failed"; record.seen = true }
            else {
              if (monitoring.records.length >= RECORD_LIMIT) {
                const expendable = monitoring.records.findIndex(item => item.seen && !["running", "queued"].includes(item.status))
                monitoring.records.splice(expendable < 0 ? monitoring.records.length - 1 : expendable, 1)
                monitoring.gap = true
              }
              monitoring.records.push({ id: selection.runId, startedAt: response.detail.run.startedAt, status: "failed", seen: true })
            }
            await storage.set(monitorWrite(saved, monitoring))
            await display(monitoring)
          })
        }
        return response
      }
      if (type === "connection:get") {
        await writes
        const state = await storage.get("connection")
        return { ok: true, connection: isConnection(state.connection) ? state.connection : null }
      }
      if (type === "connection:status" || type === "connection:workspaces") {
        const current = generation
        await writes
        const saved = await storage.get("connection")
        if (current !== generation) return { ok: false, code: "request_canceled" }
        const response = await native({ op: type === "connection:status" ? "status" : "workspaces",
          ...(type === "connection:workspaces" && isConnection(saved.connection) ? { instance: saved.connection.instance } : {}) })
        return current === generation ? response : { ok: false, code: "request_canceled" }
      }
      stop(type === "connection:refresh")
      const current = generation
      const currentList = listGeneration
      if (type === "connection:disconnect") {
        await serialized(async () => {
          if (credentials) await credentials.lock()
          if (services) await services.alarms.clear(MONITOR_ALARM)
          // Preserve the public timezone preference and the locked credential record.
          const state = await storage.get("timezone")
          if (validTimezone(state.timezone) || credentials && await credentials.record()) {
            const keys = Object.keys(await storage.get(null)).filter(key => key !== "timezone" && key !== CREDENTIALS)
            await storage.remove(keys)
          } else await storage.clear()
          await display(null)
        })
        return { ok: true, connection: null }
      }
      let workspace = request.workspace
      let expectedInstance: string | undefined
      if (type === "connection:switch") {
        let failure: string | undefined
        await serialized(async () => {
          if (current !== generation) return
          const saved = await storage.get(monitorKeys)
          if (current !== generation) return
          if (!isConnection(saved.connection)) { failure = "request_invalid"; return }
          const connection = { instance: saved.connection.instance, workspace: workspace as string }
          if (scopes(saved).filter(item => !sameScope(item, connection)).length > 20) { failure = "scope_limit"; return }
          expectedInstance = connection.instance
          const monitoring = monitor(saved, connection)
          await storage.set({ connection, selection: null, ...monitorWrite(saved, monitoring, connection) })
          await display(monitoring)
        })
        if (failure) return { ok: false, code: failure }
        if (!expectedInstance) return { ok: false, code: "request_canceled" }
      }
      if (type === "connection:refresh") {
        await writes
        const state = await storage.get("connection")
        if (!isConnection(state.connection)) return { ok: false, code: "request_invalid" }
        workspace = state.connection.workspace
        expectedInstance = state.connection.instance
      }
      if (current !== generation || currentList !== listGeneration) return { ok: false, code: "request_canceled" }
      const response = await native({ op: "recent", workspace, ...(expectedInstance ? { instance: expectedInstance } : {}) })
      if (current !== generation || currentList !== listGeneration) return { ok: false, code: "request_canceled" }
      if (response.ok && "mode" in response && !("page" in response)) {
        if (response.workspace !== workspace || expectedInstance && response.instance !== expectedInstance) return { ok: false, code: "response_invalid" }
        await serialized(async () => {
          if (current !== generation || currentList !== listGeneration) return
          const saved = await storage.get(monitorKeys)
          if (current !== generation || currentList !== listGeneration) return
          const connection = { instance: response.instance, workspace: response.workspace }
          const monitoring = refreshMonitoring(monitor(saved, connection), response, now())
          await storage.set({ connection, ...monitorWrite(saved, monitoring, connection),
            ...(isConnection(saved.connection) && !sameScope(saved.connection, connection) ? { selection: null } : {}) })
          await schedule()
          await display(monitoring)
        })
        if (current !== generation || currentList !== listGeneration) return { ok: false, code: "request_canceled" }
      }
      if (!response.ok && ["connection:refresh", "connection:switch"].includes(type) && response.code !== "request_canceled") {
        await serialized(async () => {
          if (current !== generation || currentList !== listGeneration) return
          const saved = await storage.get(monitorKeys)
          if (current !== generation || currentList !== listGeneration) return
          const monitoring = failedMonitor(saved, response.code)
          if (monitoring) {
            await storage.set(monitorWrite(saved, monitoring))
            await display(monitoring)
          }
        })
      }
      return response
    } catch { return { ok: false, code: "helper_failure" } }
  }
  function follow(port: chrome.runtime.Port) {
    if (port.name === "run-radar-compare") { compare(port); return }
    if (port.name !== "run-radar-follow" || port.sender?.id !== runtime.id || port.sender.url !== `chrome-extension://${runtime.id}/sidepanel.html`) {
      port.disconnect()
      return
    }
    let canceled = false
    let started = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending: (() => void) | undefined
    const cancel = () => {
      if (canceled) return
      canceled = true
      clearTimeout(timer)
      pending?.()
      follows.delete(cancel)
      port.disconnect()
    }
    follows.add(cancel)
    port.onDisconnect.addListener(cancel)
    port.onMessage.addListener(async (message: unknown) => {
      if (started || !message || typeof message !== "object") { cancel(); return }
      const request = message as Record<string, unknown>
      if (Object.keys(request).sort().join(",") !== "offset,selection" || !isSelection(request.selection) ||
        !Number.isSafeInteger(request.offset) || (request.offset as number) < 0) { cancel(); return }
      started = true
      const selection = request.selection
      let offset = request.offset as number
      const current = generation
      async function tick() {
        try {
          await writes
          const state = await storage.get(["connection", "selection"])
          if (canceled || current !== generation) { cancel(); return }
          if (!isConnection(state.connection) || state.connection.instance !== selection.instance || state.connection.workspace !== selection.workspace ||
            !isSelection(state.selection) || !sameSelection(state.selection, selection)) { cancel(); return }
          const response = await native({ op: "follow", ...selection, offset }, cancelNative => { pending = cancelNative })
          pending = undefined
          if (canceled || current !== generation) return
          if (!isFollowResponse(response) || !sameSelection(response, selection)) {
            port.postMessage(response.ok ? { ok: false, code: "response_invalid" } : response)
            cancel(); return
          }
          offset = response.offsets.end
          if (!["running", "queued"].includes(response.detail.run.status)) {
            const final = await handle({ type: "connection:inspect", selection }, port.sender!, cancelNative => { pending = cancelNative; if (canceled) cancelNative() }, () => canceled)
            pending = undefined
            if (canceled || current !== generation) return
            port.postMessage(final)
            cancel(); return
          }
          port.postMessage(response)
          if (response.detail.logs.state !== "available" || response.detail.logs.truncated) { cancel(); return }
          timer = setTimeout(() => { void tick() }, 2000)
        } catch {
          if (!canceled) { try { port.postMessage({ ok: false, code: "helper_failure" }) } finally { cancel() } }
        }
      }
      await tick()
    })
  }
  function compare(port: chrome.runtime.Port) {
    if (port.sender?.id !== runtime.id || port.sender.url !== `chrome-extension://${runtime.id}/sidepanel.html`) {
      port.disconnect(); return
    }
    let canceled = false
    let started = false
    let pending: (() => void) | undefined
    const current = generation
    const cancel = () => {
      if (canceled) return
      canceled = true
      pending?.()
      follows.delete(cancel)
      port.disconnect()
    }
    follows.add(cancel)
    port.onDisconnect.addListener(cancel)
    port.onMessage.addListener(async (message: unknown) => {
      if (started || !message || typeof message !== "object" || Object.keys(message).join(",") !== "selection" ||
        !isSelection((message as { selection: unknown }).selection)) { cancel(); return }
      started = true
      const selection = (message as { selection: import("./inspection").Selection }).selection
      try {
        await writes
        const state = await storage.get(["connection", "selection"])
        if (canceled || current !== generation) { cancel(); return }
        if (!isConnection(state.connection) || state.connection.instance !== selection.instance || state.connection.workspace !== selection.workspace ||
          !isSelection(state.selection) || !sameSelection(state.selection, selection)) {
          port.postMessage({ ok: false, code: "request_invalid" }); cancel(); return
        }
        const response = await native({ op: "compare", ...selection }, value => { pending = value; if (canceled) value() })
        pending = undefined
        if (canceled || current !== generation) return
        port.postMessage(response.ok && (!isComparisonResponse(response) || !sameSelection(response, selection)) ? { ok: false, code: "response_invalid" } : response)
        cancel()
      } catch {
        if (!canceled) { try { port.postMessage({ ok: false, code: "helper_failure" }) } finally { cancel() } }
      }
    })
  }
  return Object.assign(handle, { poll, restore, failureIndicator, follow })
}
