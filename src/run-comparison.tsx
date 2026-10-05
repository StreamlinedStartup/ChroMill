import { runTime } from "./timezones"
import { useTimezone } from "./use-timezone"
import React, { useEffect, useState } from "react"
import { comparisonStates, difference, isComparisonResponse } from "./comparison"
import type { ComparisonResponse } from "./comparison"
import { failureText, recovery } from "./connection"
import type { Field, Selection } from "./inspection"
import { sameSelection } from "./inspection"
import { Content } from "./run-inspection"

export default function RunComparison({ selection }: { selection: Selection }) {
  const preference = useTimezone()
  const [response, setResponse] = useState<ComparisonResponse | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let settled = false
    let port: chrome.runtime.Port | undefined
    setResponse(null)
    setError("")
    try {
      port = chrome.runtime.connect({ name: "run-radar-compare" })
      port.onMessage.addListener((value: unknown) => {
        if (!active) return
        settled = true
        if (isComparisonResponse(value) && sameSelection(value, selection)) setResponse(value)
        else setError(failureText(value))
      })
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError
        if (active && !settled) setError(recovery.helper_missing)
      })
      port.postMessage({ selection })
    } catch { setError(recovery.helper_missing) }
    return () => { active = false; port?.disconnect() }
  }, [selection.instance, selection.workspace, selection.runId, attempt])
  function fields(label: string, before: Field, after: Field, json = false) {
    return <section className="comparison-field" key={label}><h3>{label}</h3><pre className="difference">{difference(before, after, json)}</pre>
      <details><summary>Earlier success</summary><Content label={label} field={before} /></details>
      <details><summary>Selected run</summary><Content label={label} field={after} /></details></section>
  }
  return <section aria-label="Run comparison" className="comparison"><h2>Compare with earlier success</h2>
    <p>Read-only comparison within this instance, workspace, path, and job kind. No external AI service is used.</p>
    {error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry comparison</button></> :
      !response ? <p role="status">Searching accessible retained history...</p> : response.state !== "available" ?
        <p role="status">{comparisonStates[response.state]} Searched rows: {response.searched}.</p> : <>
          <p>Earlier success: {response.baseline!.detail.run.id}<br />Started: {runTime(response.baseline!.detail.run, preference.timezone)}</p>
          <p>Selected run: {response.selected!.detail.run.id}<br />Started: {runTime(response.selected!.detail.run, preference.timezone)}</p>
          <p>Searched rows: {response.searched}. Earlier means strictly earlier start time. Equal baseline times use descending run ID.</p>
          <p>Duration: {response.baseline!.detail.run.durationMs} ms to {response.selected!.detail.run.durationMs} ms.
            Difference: {response.selected!.detail.run.durationMs - response.baseline!.detail.run.durationMs} ms.</p>
          {fields(response.kind === "flow" ? "Flow version identifier (reported script_hash)" : "Script version (script_hash)", response.baseline!.version, response.selected!.version)}
          {fields("Inputs", response.baseline!.detail.inputs, response.selected!.detail.inputs, true)}
          {fields("Result", response.baseline!.detail.result, response.selected!.detail.result, true)}
          {fields("Logs", response.baseline!.detail.logs, response.selected!.detail.logs)}
        </>}
    <p>Limits: five pages of 100 rows. Retention and permissions limit visible history. Concurrent history changes can affect pagination.</p>
  </section>
}
