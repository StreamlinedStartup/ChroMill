import React, { useEffect, useRef, useState } from "react"
import { connectionRequest, failureText } from "./connection"
import { isSelection } from "./inspection"
import type { Selection } from "./inspection"
import RunInspection from "./run-inspection"
import "./popup.css"
import "./sidepanel.css"

export default function SidePanel() {
  const [selection, setSelection] = useState<Selection | null>(null)
  const [error, setError] = useState("")
  const generation = useRef(0)
  useEffect(() => {
    async function load() {
      const current = ++generation.current
      setSelection(null)
      const response = await connectionRequest({ type: "connection:selection" })
      if (current !== generation.current) return
      if (response && typeof response === "object" && "ok" in response && response.ok && "selection" in response && (response.selection === null || isSelection(response.selection))) {
        setError("")
        setSelection(response.selection)
      } else setError(failureText(response))
    }
    const change = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes.selection || changes.connection)) void load()
    }
    chrome.storage.onChanged.addListener(change)
    void load()
    return () => { generation.current++; chrome.storage.onChanged.removeListener(change) }
  }, [])
  return <main className="panel" aria-label="ChroMill side panel">{error ? <p role="alert">{error}</p> : selection ? <RunInspection selection={selection} follow /> : <p role="status">Select a live run in the popup to inspect it here.</p>}</main>
}
