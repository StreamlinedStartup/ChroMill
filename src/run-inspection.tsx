import { kindLabel } from "./runs"
import { runTime } from "./timezones"
import { useTimezone } from "./use-timezone"
import React, { useEffect, useRef, useState } from "react"
import { connectionRequest, failureText, recovery } from "./connection"
import { isFollowResponse, isInspectionResponse, sameSelection } from "./inspection"
import type { Detail, Field, Selection } from "./inspection"
import RunComparison from "./run-comparison"

export function Content({ label, field }: { label: string; field: Field }) {
  return <section className="detail-field" data-field={label}><h2>{label}</h2>{field.state === "available" ? <>
    {field.truncated && <p role="status">{label === "Logs" ? "Only the last 64,000 characters are shown." : "Only the first 32,000 characters are shown."} Open Windmill for the complete content.</p>}
    <pre>{field.text || "No content."}</pre>
  </> : <p role="status">{field.state === "unavailable" ? "Unavailable for this run." : recovery[field.state]}</p>}</section>
}
export default function RunInspection({ selection, compact = false, follow = false, onBack, onPanel }: {
  selection: Selection; compact?: boolean; follow?: boolean; onBack?: () => void; onPanel?: () => void
}) {
  const preference = useTimezone()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const generation = useRef(0)
  const cursor = useRef({ selection, offset: 0 })
  const [following, setFollowing] = useState("")
  const [comparing, setComparing] = useState(false)
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => { back.current?.focus() }, [])
  useEffect(() => {
    const current = ++generation.current
    setDetail(null)
    setError("")
    setComparing(false)
    if (!sameSelection(cursor.current.selection, selection)) cursor.current = { selection, offset: 0 }
    if (!follow) {
      void connectionRequest({ type: "connection:inspect", selection }).then(response => {
        if (current !== generation.current) return
        if (isInspectionResponse(response) && sameSelection(response, selection)) setDetail(response.detail)
        else setError(failureText(response))
      })
      return () => { generation.current++ }
    }
    setFollowing("Compatible polling every 2 seconds. Streaming is not used.")
    let port: chrome.runtime.Port
    let settled = false
    try {
      port = chrome.runtime.connect({ name: "run-radar-follow" })
      port.onMessage.addListener((response: unknown) => {
        if (current !== generation.current) return
        if ((isFollowResponse(response) || isInspectionResponse(response)) && sameSelection(response, selection)) {
          setDetail(response.detail)
          if (isFollowResponse(response)) {
            cursor.current.offset = response.offsets.end
            if (response.detail.logs.state !== "available" || response.detail.logs.truncated) {
              settled = true
              setFollowing("Following stopped at the log limit or log error. Open Windmill for complete logs, or try again.")
              setError(response.detail.logs.state === "available" ? "The log exceeds the 64,000-character view limit." : recovery[response.detail.logs.state] || "Logs are unavailable.")
            }
          } else {
            settled = true
            setFollowing("Run completed. Following stopped after the final details fetch.")
          }
        } else {
          settled = true
          setFollowing("Following stopped. Restore access, then try again.")
          setError(failureText(response))
        }
      })
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError
        if (current === generation.current && !settled) {
          setFollowing("Following disconnected. Try again to recover from the saved offset.")
          setError(recovery.helper_missing)
        }
      })
      port.postMessage({ selection, offset: cursor.current.offset })
    } catch {
      setError(recovery.helper_missing)
      setFollowing("Following stopped. Try again after restoring the helper.")
    }
    return () => { generation.current++; port?.disconnect() }
  }, [selection.instance, selection.workspace, selection.runId, attempt, follow])
  async function open() {
    const response = await connectionRequest({ type: "connection:open", selection })
    if (!response || typeof response !== "object" || !("ok" in response) || !response.ok) setError(failureText(response))
  }
  return <div className="inspection" onKeyDown={event => { if (event.key === "Escape" && onBack) { event.preventDefault(); onBack() } }}>
    <div className="inspection-actions">{onBack && <button ref={back} onClick={onBack}>Back</button>}<button onClick={() => void open()}>Open in Windmill</button>{onPanel && <button onClick={onPanel}>Continue in side panel</button>}</div>
    <p className="identity">{selection.instance}<br />{selection.workspace} / {selection.runId}</p>
    {preference.error && <p role="alert">{preference.error}</p>}
    {follow && <p role="status" className="follow-state">{following}</p>}
    {error && <div><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Try again</button></div>}
    {!detail ? !error && <p role="status">Loading run details...</p> : <>
      <h1>{detail.run.name}</h1><p><span className="kind-pill">{kindLabel(detail.run.jobKind)}</span> {detail.run.path}</p>
      <dl><dt>Status</dt><dd>{detail.run.status}</dd><dt>Started</dt><dd>{runTime(detail.run, preference.timezone)}</dd><dt>Duration</dt><dd>{(detail.run.durationMs / 1000).toFixed(1)}s</dd><dt>Trigger</dt><dd>{detail.run.trigger}</dd></dl>
      <Content label="Result" field={detail.result} />
      <Content label="Logs" field={compact && detail.logs.state === "available" ? { ...detail.logs, text: detail.logs.text?.split("\n").slice(-8).join("\n") } : detail.logs} />
      {!compact && <><Content label="Inputs" field={detail.inputs} /><Content label="Flow steps" field={detail.steps} /></>}
      {!compact && <><button onClick={() => setComparing(value => !value)}>{comparing ? "Close comparison" : "Compare"}</button>
        {comparing && <RunComparison selection={selection} />}</>}
    </>}
  </div>
}
