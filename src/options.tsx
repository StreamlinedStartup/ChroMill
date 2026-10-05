import React, { useEffect, useRef, useState } from "react"
import { connectionRequest, failureText, isConnection, isNativeResponse, publicOrigin, recovery } from "./connection"
import { credentialInput, isCredentialStatus } from "./credentials"
import { browserTimezone, isTimezoneResponse, validTimezone } from "./timezones"
import { useTimezone } from "./use-timezone"
import "./popup.css"

export default function Options() {
  const preference = useTimezone()
  const [timezone, setTimezone] = useState(browserTimezone)
  const [timezoneError, setTimezoneError] = useState("")
  const [timezoneMessage, setTimezoneMessage] = useState("")
  const [savingTimezone, setSavingTimezone] = useState(false)
  useEffect(() => { setTimezone(preference.timezone) }, [preference.timezone])
  async function saveTimezone() {
    setTimezoneMessage("")
    if (!validTimezone(timezone)) { setTimezoneError("Enter a valid named timezone, such as America/New_York or UTC."); return }
    setSavingTimezone(true)
    const value = await connectionRequest({ type: "connection:timezone-save", timezone })
    if (isTimezoneResponse(value) && value.timezone === timezone) {
      setTimezoneError(""); setTimezoneMessage("Timezone saved. Open views update automatically.")
    } else setTimezoneError(failureText(value))
    setSavingTimezone(false)
  }
  const [instance, setInstance] = useState("")
  const [workspace, setWorkspace] = useState("")
  const [workspaces, setWorkspaces] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("Save credentials, then load workspaces. The existing host helper is available when no credentials are saved.")
  const [error, setError] = useState("")
  const generation = useRef(0)
  const [credentialState, setCredentialState] = useState({ saved: false, locked: false })
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [editingCredentials, setEditingCredentials] = useState(false)
  const credentialForm = !credentialState.saved || editingCredentials
  function closeCredentialForm() {
    setEditingCredentials(false)
    setApiKey(""); setPassword(""); setConfirmation("")
    setBaseUrl(instance)
    setError("")
  }
  useEffect(() => {
    let active = true
    const current = generation.current
    void connectionRequest({ type: "credentials:get" }).then(value => {
      if (!active || current !== generation.current) return
      if (isCredentialStatus(value)) {
        setCredentialState(value)
        setBaseUrl(value.instance ?? "")
        setInstance(value.instance ?? "")
        if (value.saved) setMessage(value.locked ? "Enter your password to unlock the saved connection." : "Connection saved. ChroMill is unlocked.")
      } else setError(failureText(value))
    })
    return () => { active = false }
  }, [])
  async function credentialAction(action: "save" | "replace" | "unlock" | "lock" | "remove") {
    setError("")
    const origin = baseUrl.trim().replace(/\/$/, "")
    if (["save", "replace"].includes(action) && (!publicOrigin(origin) || !credentialInput(origin, apiKey, password))) {
      setError(recovery.credentials_invalid); return
    }
    if (["save", "replace"].includes(action) && password !== confirmation) { setError("Passwords do not match."); return }
    const current = ++generation.current
    setBusy(true)
    try {
      if (["save", "replace"].includes(action) && !await chrome.permissions.request({ origins: [origin + "/*"] })) {
        setError(recovery.permission_denied); return
      }
      if (current !== generation.current) return
      const response = await connectionRequest({ type: "credentials:" + action,
        ...(["save", "replace"].includes(action) ? { instance: origin, apiKey, password } : action === "unlock" ? { password } : {}) })
      if (current !== generation.current) return
      if (!isCredentialStatus(response)) { setError(failureText(response)); return }
      setCredentialState(response)
      setEditingCredentials(false)
      setInstance(response.instance ?? "")
      setBaseUrl(response.instance ?? "")
      setWorkspaces([]); setWorkspace("")
      setMessage(response.saved ? response.locked ? "Locked. Monitoring is paused until you unlock." : action === "unlock" ? "Unlocked. Monitoring resumes for your connected workspace. If you disconnected, load workspaces and connect again." : "Connection saved. Load workspaces, choose a workspace, and connect." : "Saved connection removed. You can enter a new connection or use the host helper.")
    } catch { if (current === generation.current) setError(recovery.permission_denied) }
    finally {
      setApiKey(""); setPassword(""); setConfirmation("")
      if (current === generation.current) setBusy(false)
    }
  }

  async function request(type: string) {
    const current = ++generation.current
    setBusy(true)
    setError("")
    let operation = type
    if (type === "connection:connect") {
      const saved = await connectionRequest({ type: "connection:get" })
      if (current !== generation.current) return
      if (!saved || typeof saved !== "object" || !("ok" in saved) || !saved.ok || !("connection" in saved) ||
        saved.connection !== null && !isConnection(saved.connection)) {
        setError(failureText(saved)); setBusy(false); return
      }
      if (isConnection(saved.connection)) operation = "connection:switch"
    }
    const response = await connectionRequest(type === "connection:connect" ? { type: operation, workspace } : { type })
    if (current !== generation.current) return
    if (type === "connection:disconnect" && response && typeof response === "object" && "ok" in response && response.ok === true) {
      closeCredentialForm()
      setInstance("")
      setWorkspaces([])
      setWorkspace("")
      setMessage("Disconnected. Private caches are cleared. The 1Password mount stays in place.")
      setCredentialState(previous => ({ ...previous, locked: previous.saved }))
    } else if (!isNativeResponse(response) || !response.ok) {
      setError(failureText(response))
      setMessage("Connection unavailable.")
    } else {
      setInstance(response.instance)
      if ("helper" in response) setMessage(credentialState.saved ? "Connection available. Select Load workspaces to test access." : "Helper installed. Select Load workspaces to test access.")
      if ("workspaces" in response) {
        setWorkspaces(response.workspaces)
        setWorkspace(response.workspaces[0] ?? "")
        setMessage(response.workspaces.length ? "Select a workspace and connect." : "No accessible workspaces. Update the key permissions, then load workspaces again.")
      }
      if ("mode" in response) setMessage(`Connected to ${response.workspace}. Open the toolbar popup to see ${response.runs.length} recent runs.`)
    }
    setBusy(false)
  }

  return <main className="connection-page">
    <h1>ChroMill configuration</h1>
    <div className="settings-grid">
    <section className="settings-section" aria-labelledby="connection-heading">
    <h2 id="connection-heading">Connect Windmill</h2>
    <p>Your password protects the API key saved on this device. This is a password you choose for ChroMill, not your Windmill password.</p>
    <p>The saved API key stays encrypted even while unlocked. Unlock lets ChroMill use it to load runs and monitor your workspace.</p>
    <label htmlFor="base-url">Windmill base URL</label>
    <input id="base-url" type="url" autoComplete="off" value={baseUrl} disabled={busy || !credentialForm} onChange={event => setBaseUrl(event.target.value)} />
    <label htmlFor="api-key">API key</label>
    <input id="api-key" type="password" autoComplete="off" value={apiKey} placeholder={credentialState.saved && !editingCredentials ? "*******" : ""} readOnly={!credentialForm} disabled={busy} onChange={event => setApiKey(event.target.value)} />
    <label htmlFor="password">{credentialState.locked ? "Enter password to unlock" : "Encryption password"}</label>
    <input id="password" type="password" autoComplete="off" aria-describedby="password-help" value={password} placeholder={credentialState.saved && !credentialState.locked && !editingCredentials ? "*******" : ""} readOnly={!credentialForm && !credentialState.locked} disabled={busy} onChange={event => setPassword(event.target.value)} />
    <p id="password-help">{credentialState.locked ? "Enter your ChroMill password once to unlock. You do not need to enter your API key again. Unlock before changing the saved connection." : !credentialForm ? "Password set. ChroMill is unlocked. You do not need to enter your password again." : "Use at least 12 characters. Enter the same password below to confirm it when you save or replace your connection."}</p>
    {credentialForm && <>
      <label htmlFor="confirmation">Confirm encryption password</label>
      <input id="confirmation" type="password" autoComplete="off" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
    </>}
    <p>If you forget your password, remove the saved connection and enter your API key with a new password.</p>
    <p>Saved credentials: {credentialState.saved ? credentialState.locked ? "Locked" : "Unlocked" : "None"}</p>
    <div className="connection-actions">
      {credentialForm && <button disabled={busy} onClick={() => void credentialAction(editingCredentials ? "replace" : "save")}>{editingCredentials ? "Save replacement" : "Save credentials"}</button>}
      {credentialState.saved && !editingCredentials && <button disabled={busy || credentialState.locked} onClick={() => { setEditingCredentials(true); setError("") }}>Replace credentials</button>}
      {editingCredentials && <button disabled={busy} onClick={closeCredentialForm}>Cancel</button>}
      <button disabled={busy || !credentialState.saved || !credentialState.locked} onClick={() => void credentialAction("unlock")}>Unlock</button>
      <button disabled={busy || !credentialState.saved || credentialState.locked} onClick={() => void credentialAction("lock")}>Lock</button>
      <button disabled={busy} onClick={() => void credentialAction("remove")}>Remove credentials</button>
    </div>
    {!credentialState.saved && <p>The optional host helper reads the existing 1Password mount. Register it with extension ID <code>{chrome.runtime.id}</code>. Use the Backlog runbook.</p>}
    <p role="status" aria-live="polite">{busy ? "Contacting Windmill..." : message}</p>
    {error && <p role="alert">{error}</p>}
    </section>
    <div className="settings-column">
    <section className="settings-section" aria-labelledby="workspace-heading">
    <h2 id="workspace-heading">Workspace and monitoring</h2>
    <p>Keep ChroMill unlocked after connecting if you want it to monitor runs. Lock stops requests and pauses monitoring until you unlock again.</p>
    <p>There is no automatic time limit. ChroMill locks when Chrome closes, the extension reloads or updates, or you select Lock or Disconnect. Closing this page or the popup does not lock it.</p>
    <p>Configured instance: <span>{instance || "Unavailable until the helper responds"}</span></p>
    <div className="connection-actions">
      <button disabled={busy} onClick={() => void request("connection:status")}>{credentialState.saved ? "Test connection" : "Test helper"}</button>
      <button disabled={busy} onClick={() => void request("connection:workspaces")}>Load workspaces</button>
    </div>
    <label htmlFor="workspace">Accessible workspace</label>
    <select id="workspace" disabled={busy || !workspaces.length} value={workspace} onChange={event => setWorkspace(event.target.value)}>
      {!workspaces.length && <option value="">Load workspaces first</option>}
      {workspaces.map(id => <option key={id} value={id}>{id}</option>)}
    </select>
    <div className="connection-actions">
      <button disabled={busy || !workspace} onClick={() => void request("connection:connect")}>Connect</button>
      <button onClick={() => void request("connection:disconnect")}>Disconnect</button>
    </div>
    {error && <p>Use {credentialState.saved ? "Test connection" : "Test helper"} or Load workspaces again after the recovery action.</p>}
    </section>
    <section className="settings-section" aria-labelledby="timezone-heading">
    <h2 id="timezone-heading">Time display</h2>
    <label htmlFor="timezone">Fallback timezone</label>
    <input id="timezone" aria-describedby="timezone-help" value={timezone} disabled={savingTimezone} onChange={event => setTimezone(event.target.value)} />
    <p id="timezone-help">The initial default uses your browser timezone. A valid current schedule timezone takes precedence. It cannot prove a historical schedule timezone.</p>
    <div className="connection-actions"><button disabled={savingTimezone} onClick={() => void saveTimezone()}>Save timezone</button></div>
    {(timezoneError || preference.error) && <p role="alert">{timezoneError || preference.error}</p>}
    {timezoneMessage && <p role="status">{timezoneMessage}</p>}
    </section>
    </div>
    </div>
  </main>
}
