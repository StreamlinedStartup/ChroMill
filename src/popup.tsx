import { runTime, formatTimestamp } from "./timezones"
import { useTimezone } from "./use-timezone"
import { isMonitoring } from "./monitoring"
import type { Monitoring } from "./monitoring"
import React, { useEffect, useRef, useState } from "react"
import { filterRuns, requestDemoRuns, kindLabel } from "./runs"
import RunInspection from "./run-inspection"
import { isInspectionResponse, isPinsResponse, sameSelection } from "./inspection"
import type { Selection } from "./inspection"
import type { Run } from "./runs"
import type { DemoResponse, RunFilter } from "./runs"
import { connectionRequest, failureText, isConnection, isNativeResponse } from "./connection"
import type { Connection, LiveSnapshot, Flow, HistoryPage } from "./connection"
import "./popup.css"

type Snapshot = Extract<DemoResponse, { ok: true }> | LiveSnapshot

export default function Popup() {
  const preference = useTimezone()
  const [monitoring, setMonitoring] = useState<Monitoring | null>(null)
  const [monitorError, setMonitorError] = useState("")
  useEffect(() => {
    let active = true
    async function load() {
      if (!chrome.storage?.local) return
      try {
        const saved = await chrome.storage.local.get(["connection", "monitoring"])
        if (!active) return
        if (saved.monitoring === undefined || saved.monitoring === null || isMonitoring(saved.monitoring)) {
          setMonitoring(isMonitoring(saved.monitoring) && isConnection(saved.connection) && saved.monitoring.instance === saved.connection.instance &&
            saved.monitoring.workspace === saved.connection.workspace ? saved.monitoring : null)
          setMonitorError("")
        } else setMonitorError("Monitoring status unavailable")
      } catch { if (active) setMonitorError("Monitoring status unavailable") }
    }
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes.monitoring || changes.connection)) void load()
    }
    void load()
    chrome.storage?.onChanged?.addListener(changed)
    return () => { active = false; chrome.storage?.onChanged?.removeListener(changed) }
  }, [])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selectedDemo, setSelectedDemo] = useState<Run | null>(null)
  const rowId = useRef("")
  const windowId = useRef<number | null>(null)
  const selectionGeneration = useRef(0)
  const [panelError, setPanelError] = useState("")
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [filter, setFilter] = useState<RunFilter | "pinned">("all")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const generation = useRef(0)
  const [browse, setBrowse] = useState<"recent" | "flows" | "history">("recent")
  const [flows, setFlows] = useState<Flow[]>([])
  const [catalogState, setCatalogState] = useState("Loading scripts and flows...")
  const [catalogRetry, setCatalogRetry] = useState(0)
  const [catalogError, setCatalogError] = useState("")
  const [history, setHistory] = useState<HistoryPage | null>(null)
  const [historyPage, setHistoryPage] = useState(1)
  const [selectedFlow, setSelectedFlow] = useState<Flow | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState("")
  const [historyRetry, setHistoryRetry] = useState(0)
  const browseGeneration = useRef(0)
  function resetBrowse() {
    browseGeneration.current++
    setBrowse("recent"); setFlows([]); setHistory(null); setHistoryPage(1); setSelectedFlow(null)
    setHistoryError(""); setCatalogError(""); setSearch("")
  }
  const [mode, setMode] = useState<"demo" | "live" | null>(null)

  const [connection, setConnection] = useState<Connection | null>(null)
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [workspaceError, setWorkspaceError] = useState("")
  const [workspacesLoading, setWorkspacesLoading] = useState(false)
  const workspaceGeneration = useRef(0)
  const switching = useRef<Connection | null>(null)
  const [pins, setPins] = useState<Selection[]>([])
  const [pinError, setPinError] = useState("")
  const [pinBusy, setPinBusy] = useState(false)
  const [pinnedRows, setPinnedRows] = useState<{ selection: Selection; run?: Run; error?: string }[]>([])
  const [pinsLoading, setPinsLoading] = useState(false)

  async function loadPins(request: number) {
    const response = await connectionRequest({ type: "connection:pins" })
    if (request !== generation.current) return
    if (isPinsResponse(response)) { setConnection(response.connection); setPins(response.pins); setPinError("") }
    else { setPins([]); setPinError(failureText(response)) }
  }
  async function changePin(identity: Selection) {
    const current = generation.current
    setPinBusy(true)
    setPinError("")
    const response = await connectionRequest({ type: pins.some(pin => sameSelection(pin, identity)) ? "connection:unpin" : "connection:pin", selection: identity })
    if (current !== generation.current) return
    setPinBusy(false)
    if (isPinsResponse(response)) setPins(response.pins)
    else setPinError(failureText(response))
  }
  useEffect(() => {
    if (filter !== "pinned" || mode !== "live") return
    let active = true
    setPinsLoading(true)
    setPinnedRows([])
    void Promise.all(pins.map(async identity => {
      const response = await connectionRequest({ type: "connection:inspect", selection: identity })
      return isInspectionResponse(response) && sameSelection(response, identity)
        ? { selection: identity, run: response.detail.run }
        : { selection: identity, error: failureText(response) }
    })).then(rows => { if (active) { setPinnedRows(rows); setPinsLoading(false) } })
    return () => { active = false }
  }, [pins, filter, mode, connection?.instance, connection?.workspace])

  async function loadWorkspaces() {
    const current = ++workspaceGeneration.current
    setWorkspacesLoading(true)
    setWorkspaceError("")
    const response = await connectionRequest({ type: "connection:workspaces" })
    if (current !== workspaceGeneration.current) return
    if (isNativeResponse(response) && response.ok && "workspaces" in response && response.instance === connection?.instance) {
      setWorkspaces(response.workspaces)
      if (!response.workspaces.length) setWorkspaceError("No accessible workspaces. Review the key permissions.")
    } else { setWorkspaces([]); setWorkspaceError(failureText(response)) }
    setWorkspacesLoading(false)
  }
  async function switchWorkspace(workspace: string) {
    if (!connection || workspace === connection.workspace) return
    resetBrowse()
    const request = ++generation.current
    selectionGeneration.current++
    workspaceGeneration.current++
    setWorkspacesLoading(false)
    setWorkspaceError("")
    const target = { instance: connection.instance, workspace }
    switching.current = target
    setConnection(target)
    setSelection(null)
    setSelectedDemo(null)
    setSnapshot(null)
    setPins([])
    setPinnedRows([])
    setPinBusy(false)
    setPinError("")
    setPanelError("")
    setMonitoring(null)
    setFilter("all")
    setSearch("")
    setError("")
    setLoading(true)
    const response = await connectionRequest({ type: "connection:switch", workspace })
    if (request !== generation.current) return
    switching.current = null
    if (isNativeResponse(response) && response.ok && "mode" in response && response.instance === target.instance && response.workspace === target.workspace) setSnapshot(response)
    else setError(failureText(response))
    await loadPins(request)
    if (request === generation.current) setLoading(false)
  }

  async function refresh(selectedMode = mode) {
    switching.current = null
    if (selectedMode === null) return discoverConnection()
    resetBrowse()
    selectionGeneration.current++
    setSelection(null)
    setSelectedDemo(null)
    const request = ++generation.current
    setLoading(true)
    setError("")
    setSnapshot(null)
    setPinBusy(false)
    if (selectedMode === "live") await loadPins(request)
    else { setPins([]); setConnection(null); setPinError(""); setFilter("all") }
    if (request !== generation.current) return
    try {
      let result: Snapshot
      if (selectedMode === "demo") result = await requestDemoRuns()
      else {
        const response = await connectionRequest({ type: "connection:refresh" })
        if (!isNativeResponse(response) || !response.ok || !("mode" in response)) throw new Error(failureText(response))
        result = response
      }
      if (request === generation.current) {
        setSnapshot(result)
        if ("instance" in result) setConnection({ instance: result.instance, workspace: result.workspace })
      }
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Unable to load runs.")
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }

  async function discoverConnection() {
    switching.current = null
    const request = ++generation.current
    setLoading(true)
    setError("")
    setSnapshot(null)
    const response = await connectionRequest({ type: "connection:get" })
    if (request !== generation.current) return
    if (!response || typeof response !== "object" || !("ok" in response) || response.ok !== true || !("connection" in response) || response.connection !== null && !isConnection(response.connection)) {
      setError(failureText(response))
      setLoading(false)
      return
    }
    const selectedMode = isConnection(response.connection) ? "live" : "demo"
    setMode(selectedMode)
    await refresh(selectedMode)
  }

  useEffect(() => {
    if (chrome.windows) void chrome.windows.getCurrent().then(window => { windowId.current = window.id ?? null }).catch(() => setPanelError("The browser window is unavailable."))
    void discoverConnection()
    return () => { generation.current++; selectionGeneration.current++ }
  }, [])

  useEffect(() => {
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local" || !(changes.connection || changes.encryptedCredentials || isMonitoring(changes.monitoring?.newValue) && changes.monitoring.newValue.error === "credentials_locked")) return
      resetBrowse()
      const before = changes.connection?.oldValue
      const after = changes.connection?.newValue
      const target = switching.current
      if (target && isConnection(after) && target.instance === after.instance && target.workspace === after.workspace) return
      if (isConnection(before) && isConnection(after) && before.instance === after.instance && before.workspace === after.workspace) return
      selectionGeneration.current++
      if (!target || !isConnection(after) || target.instance !== after.instance) setConnection(isConnection(after) ? after : null)
      setSelection(null)
      setSelectedDemo(null)
      setSnapshot(null)
      setMonitoring(null)
      setPinBusy(false)
      setPinError("")
      setPanelError("")
      setPins([])
      setPinnedRows([])
      if (!isConnection(before) || !isConnection(after) || before.instance !== after.instance) setWorkspaces([])
      workspaceGeneration.current++
      setWorkspacesLoading(false)
      setWorkspaceError("")
      void discoverConnection()
    }
    chrome.storage?.onChanged?.addListener(changed)
    return () => chrome.storage?.onChanged?.removeListener(changed)
  }, [mode])

  useEffect(() => {
    if (browse !== "flows" || mode !== "live" || !connection) return
    const current = ++browseGeneration.current, scope = connection
    setFlows([]); setCatalogError(""); setCatalogState("Loading scripts and flows...")
    const timer = setTimeout(() => void (async () => {
      const found: Flow[] = [], seen = new Set<string>()
      for (let page = 1; page <= 20; page++) {
        const response = await connectionRequest({ type: "connection:flows", page })
        if (current !== browseGeneration.current) return
        if (!isNativeResponse(response) || !response.ok || !("flows" in response) || response.page !== page ||
          response.instance !== scope.instance || response.workspace !== scope.workspace) {
          setCatalogError(failureText(response)); setCatalogState("Lookup incomplete"); return
        }
        if (response.flows.some(flow => flow.kind === "flow" && seen.has(`${flow.kind}:${flow.path}`))) {
          setCatalogError("Catalog changed during lookup. Search again."); setCatalogState("Lookup incomplete"); return
        }
        for (const flow of response.flows) { const key = `${flow.kind}:${flow.path}`; if (!seen.has(key)) { seen.add(key); found.push(flow) } }
        setFlows([...found])
        setCatalogState(response.hasMore ? `Searching catalog: ${found.length} scripts and flows loaded` : `Catalog complete: ${found.length} scripts and flows`)
        if (!response.hasMore) return
      }
      setCatalogState("Lookup limited to 2,000 script rows and 2,000 flow rows. More matches can exist.")
    })(), 150)
    return () => { clearTimeout(timer); browseGeneration.current++ }
  }, [browse, mode, connection?.instance, connection?.workspace, search, catalogRetry])

  useEffect(() => {
    if (browse !== "history" || mode !== "live" || !connection) return
    const current = ++browseGeneration.current, scope = connection
    setHistory(null); setHistoryError(""); setHistoryLoading(true)
    void connectionRequest({ type: "connection:history", page: historyPage, flowPath: selectedFlow?.path ?? null, flowKind: selectedFlow?.kind ?? null }).then(response => {
      if (current !== browseGeneration.current) return
      if (isNativeResponse(response) && response.ok && "flowPath" in response && response.page === historyPage && response.flowPath === (selectedFlow?.path ?? null) && response.flowKind === (selectedFlow?.kind ?? null) &&
        response.instance === scope.instance && response.workspace === scope.workspace) setHistory(response)
      else setHistoryError(failureText(response))
      setHistoryLoading(false)
    })
    return () => { browseGeneration.current++ }
  }, [browse, historyPage, selectedFlow, mode, connection?.instance, connection?.workspace, search, historyRetry])

  function showHistory(target: Flow | null) {
    browseGeneration.current++; setHistory(null); setHistoryError(""); setHistoryLoading(true)
    setSelectedFlow(target); setHistoryPage(1); setSearch(""); setFilter("all"); setBrowse("history"); setHistoryRetry(value => value + 1)
  }

  async function openConnection() {
    try { await chrome.runtime.openOptionsPage() }
    catch { setError("The connection page is unavailable. Reload the extension and try again."); setSnapshot(null) }
  }

  function back() {
    selectionGeneration.current++
    setSelection(null)
    setSelectedDemo(null)
    requestAnimationFrame(() => document.getElementById(`run-${rowId.current}`)?.focus())
  }
  async function select(run: Run | Selection) {
    const id = "runId" in run ? run.runId : run.id
    rowId.current = id
    if (mode !== "live") { if (!("runId" in run)) setSelectedDemo(run); return }
    if (!connection) { setError("The live connection is unavailable. Refresh and try again."); return }
    const current = ++selectionGeneration.current
    const identity = { ...connection, runId: id }
    const response = await connectionRequest({ type: "connection:select", selection: identity })
    if (current !== selectionGeneration.current) return
    if (response && typeof response === "object" && "ok" in response && response.ok) setSelection(identity)
    else setError(failureText(response))
  }
  function panel() {
    if (windowId.current === null) { setPanelError("The browser window is unavailable. Reopen the popup."); return }
    void chrome.sidePanel.open({ windowId: windowId.current }).catch(() => setPanelError("The side panel did not open. Select Continue again."))
  }
  function pinButton(identity: Selection) {
    const pinned = pins.some(pin => sameSelection(pin, identity))
    return <button className="pin" aria-label={`${pinned ? "Unpin" : "Pin"} run ${identity.runId}`} aria-pressed={pinned} disabled={pinBusy} onClick={() => void changePin(identity)}>{pinned ? "Unpin" : "Pin"}</button>
  }
  if (selection) return <main className="popup"><div className="pin-actions">{pinButton(selection)}{pinError && <p role="alert">{pinError}</p>}</div><RunInspection selection={selection} compact onBack={back} onPanel={panel} />{panelError && <p role="alert">{panelError}</p>}</main>
  if (selectedDemo) return <main className="popup"><div className="inspection" onKeyDown={event => { if (event.key === "Escape") back() }}><button autoFocus onClick={back}>Back</button><h1>{selectedDemo.name}</h1><p><span className="kind-pill">{kindLabel(selectedDemo.jobKind)}</span> {selectedDemo.path}</p><p>{selectedDemo.status} / {(selectedDemo.durationMs / 1000).toFixed(1)}s / {selectedDemo.trigger}</p><p>{runTime(selectedDemo, preference.timezone)}</p><h2>Logs</h2><pre>Demo run selected. Live inspection requires a connection.</pre></div></main>
  const displayedSnapshot = browse === "history" ? history : snapshot
  const runs = displayedSnapshot?.runs ?? []
  const visible = filter === "pinned" ? [] : filterRuns(runs, filter, search)
  const visiblePins = pinnedRows.filter(row => !search.trim() || [row.selection.runId, row.run?.name, row.run?.path].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())))
  const visibleFlows = flows.filter(flow => [flow.path, flow.summary].some(value => value.toLowerCase().includes(search.trim().toLowerCase())))
  const failed = runs.filter(run => run.status === "failed").length
  const unseenFailures = monitoring?.instance === connection?.instance && monitoring?.workspace === connection?.workspace
    ? monitoring?.records.filter(record => record.status === "failed" && !record.seen).length ?? 0 : 0
  return <main className="popup" aria-label="ChroMill popup">
    <header>
      <div className="brand"><span className="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m12 12 4-10 5 5-9 5 10 4-5 5-5-9-4 10-5-5 9-5L2 8l5-5 5 9Z" /></svg></span><div><h1>ChroMill</h1><small>Windmill, within reach</small></div></div>
      <div className="popup-actions"><button className="settings" aria-label="Open settings" onClick={() => void openConnection()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="white" /><circle cx="15" cy="17" r="3" fill="white" /></svg></button><button className="refresh" aria-label={mode === null ? "Retry connection discovery" : mode === "demo" ? "Refresh demo runs" : "Refresh live runs"} onClick={() => void refresh()}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg></button></div>
    </header>
    <div className="workspace"><span className="dot" aria-hidden="true" /><strong>{mode === null ? "Connection unavailable" : mode === "demo" ? "Demo mode" : "Live mode"}</strong>{mode === "live" && connection ? <><select aria-label="Workspace" value={connection.workspace} onChange={event => void switchWorkspace(event.target.value)}><option value={connection.workspace}>{connection.workspace}</option>{workspaces.filter(id => id !== connection.workspace).map(id => <option key={id} value={id}>{id}</option>)}</select><button disabled={workspacesLoading} onClick={() => void loadWorkspaces()}>{workspacesLoading ? "Loading..." : "Workspaces"}</button></> : <span>{mode === "demo" ? "Local fixtures" : "Windmill"}</span>}</div>
    {workspaceError && mode === "live" && <p className="pin-error" role="alert">{workspaceError}</p>}
    {mode === "live" && connection && <p className="connection-label" title={connection.instance}>{connection.instance} / {connection.workspace}</p>}
    {mode === "live" && monitorError && <p className="pin-error" role="alert">{monitorError}</p>}
    {mode === "live" && unseenFailures > 0 && <p className="monitor-status" role="status">{unseenFailures} unseen {unseenFailures === 1 ? "failure" : "failures"}</p>}
    <div className="summary"><span><strong>{runs.length}</strong> {mode === "demo" ? "sample runs" : browse === "history" ? "history runs" : "recent runs"}</span><span><strong>{failed}</strong> failed</span><span className="sample">{mode === "demo" ? "No live connection" : "Read-only"}</span></div>
    {preference.error && <p role="alert" className="pin-error">{preference.error}</p>}
    {mode === "live" && <div className="browse-controls">
      <button aria-pressed={browse === "recent"} onClick={resetBrowse}>Recent</button>
      <button aria-pressed={browse === "flows"} onClick={() => { browseGeneration.current++; setSearch(""); setFilter("all"); setBrowse("flows"); setCatalogRetry(value => value + 1) }}>Find scripts and flows</button>
      <button aria-pressed={browse === "history" && selectedFlow === null} onClick={() => showHistory(null)}>Workspace history</button>
    </div>}
    <label className="search"><svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8" cy="8" r="5" /><path d="m12 12 5 5" /></svg><input type="search" aria-label={browse === "flows" ? "Find scripts and flows by name" : "Search runs"} placeholder={mode === "live" && filter !== "pinned" && browse !== "history" ? "Find script or flow by name or path..." : "Search loaded runs..."} value={search} onChange={event => { browseGeneration.current++; setSearch(event.target.value); if (mode === "live" && filter !== "pinned" && browse === "recent" && event.target.value) { setFilter("all"); setBrowse("flows") } }} /></label>
    {browse !== "flows" && <div className="filters" role="group" aria-label="Filter runs">{(["all", "failed", "running", ...(mode === "live" ? ["pinned" as const] : [])] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => { if (value === "pinned") resetBrowse(); setFilter(value) }}>{value === "all" ? "All runs" : value === "failed" ? `Failed (${failed})` : value === "pinned" ? `Pinned (${pins.length})` : "Running"}</button>)}</div>}
    {pinError && <p className="pin-error" role="alert">{pinError}</p>}
    {browse === "history" && <div className="history-controls">
      <p title={selectedFlow?.path ?? "Workspace history"}>{selectedFlow ? `${kindLabel(selectedFlow.kind)}: ${selectedFlow.path}` : "Workspace history"}</p>
      <div><button disabled={historyPage === 1 || historyLoading} onClick={() => { browseGeneration.current++; setHistory(null); setHistoryPage(historyPage - 1) }}>Newer</button>
      <span>Page {historyPage}</span><button disabled={!history?.hasMore || historyLoading || historyPage === 10000} onClick={() => { browseGeneration.current++; setHistory(null); setHistoryPage(historyPage + 1) }}>Older</button></div>
      <small>{historyLoading ? "Loading history..." : historyError ? "History unavailable" : historyPage === 10000 && history?.hasMore ? "History page limit reached" : history?.hasMore ? "More completed runs available" : "Final page"}</small>
    </div>}
    {browse === "flows" ? <section className="run-list" aria-label="Accessible scripts and flows"><p className="catalog-status" role="status">{catalogState}</p>
      {catalogError && <p className="pin-error" role="alert">{catalogError}<button onClick={() => setCatalogRetry(value => value + 1)}>Search again</button></p>}
      <ul>{visibleFlows.map(flow =>
        <li key={`${flow.kind}:${flow.path}`}><button className="run" onClick={() => showHistory(flow)}><div className="run-main"><div className="run-title"><span className="kind-pill">{kindLabel(flow.kind)}</span>{flow.summary || flow.path.split("/").at(-1)}</div><div className="path">{flow.path}</div></div></button></li>)}</ul>
      {visibleFlows.length === 0 && <p className="empty">{catalogState.startsWith("Catalog complete") ? "No accessible scripts or flows match." : "No matches in loaded scripts and flows yet."}</p>}
    </section> : <section className="run-list" aria-label={filter === "pinned" ? "Pinned runs" : browse === "history" ? "Run history" : mode === "demo" ? "Recent demo runs" : "Recent live runs"} tabIndex={0} aria-busy={filter === "pinned" ? pinsLoading : browse === "history" ? historyLoading : loading}>
      {filter === "pinned" ? pinsLoading ? <p className="empty" role="status">Loading pinned runs...</p> : visiblePins.length === 0 ? <p className="empty" role="status">No pinned runs match. Pin a recent run to keep its identity.</p> : <ul>{visiblePins.map(row => <li className="run-row" key={row.selection.runId}><button className="run" id={`run-${row.selection.runId}`} onClick={() => void select(row.selection)}><div className="run-main"><div className="run-title"><span className="kind-pill">{kindLabel(row.run?.jobKind)}</span>{row.run?.name ?? row.selection.runId}</div><div className="path">{row.run?.path ?? row.selection.runId}</div>{row.error && <p role="status">{row.error}</p>}</div></button>{pinButton(row.selection)}</li>)}</ul> : (browse === "history" ? historyLoading : loading) ? <p className="empty" role="status">Loading runs...</p> : (browse === "history" ? historyError : error) ? <div className="empty"><p role="alert">{browse === "history" ? historyError : error}</p><button onClick={() => browse === "history" ? setHistoryRetry(value => value + 1) : void refresh()}>Try again</button></div> : visible.length === 0 ? <p className="empty" role="status">{browse === "history" ? runs.length ? "No matching runs on this page. Try another filter or search." : "No runs on this history page." : runs.length === 0 && mode === "live" ? "No recent top-level runs. Refresh after a job starts." : "No matching runs. Try another filter or search."}</p> : <ul>{visible.map(run => <li className="run-row" key={run.id}><button className="run" id={`run-${run.id}`} onClick={() => void select(run)}>
        <span className={`icon ${run.status}`} aria-hidden="true">{run.status === "failed" ? "!" : run.status === "success" ? "✓" : "·"}</span>
        <div className="run-main"><div className="run-title"><span className="name" title={run.name}>{run.name}</span><time dateTime={run.startedAt} title={run.startedAt}>{runTime(run, preference.timezone)}</time></div><div className="meta"><span className="kind-pill">{kindLabel(run.jobKind)}</span><span className={run.status}>{run.status === "success" ? "Success" : run.status.charAt(0).toUpperCase() + run.status.slice(1)}</span><span>·</span><span>{(run.durationMs / 1000).toFixed(1)}s{run.status === "running" ? " elapsed" : ""}</span><span>·</span><span>{run.trigger}</span></div><div className="path" title={run.path}>{run.path} · {run.id}</div></div>
      </button>{mode === "live" && connection && pinButton({ ...connection, runId: run.id })}</li>)}</ul>}
    </section>}
    <footer><span>{displayedSnapshot ? `Snapshot: ${formatTimestamp(displayedSnapshot.snapshotAt, preference.timezone)}` : mode === "demo" ? "Demo snapshot" : "Live snapshot"}</span><span>{(browse === "history" ? historyLoading : loading) ? "Loading" : (browse === "history" ? historyError : error) ? "Unavailable" : `${browse === "flows" ? visibleFlows.length : filter === "pinned" ? visiblePins.length : visible.length} shown`}</span></footer>
  </main>
}
