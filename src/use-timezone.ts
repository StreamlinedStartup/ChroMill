import { useEffect, useState } from "react"
import { connectionRequest } from "./connection"
import { browserTimezone, isTimezoneResponse, validTimezone } from "./timezones"

export function useTimezone() {
  const [timezone, setTimezone] = useState(browserTimezone)
  const [error, setError] = useState("")
  useEffect(() => {
    let active = true
    let generation = 0
    async function load() {
      const current = ++generation
      if (!chrome.storage?.local) return
      try {
        const state = await chrome.storage.local.get("timezone")
        if (state.timezone === undefined) {
          const response = await connectionRequest({ type: "connection:timezone" })
          if (!isTimezoneResponse(response)) throw new Error("Timezone initialization failed")
          state.timezone = response.timezone
        }
        if (!active || current !== generation) return
        if (state.timezone !== undefined && !validTimezone(state.timezone)) {
          setError("Saved timezone is invalid. Save a valid timezone in Connection.")
          return
        }
        setTimezone(state.timezone ?? browserTimezone())
        setError("")
      } catch { if (active && current === generation) setError("Timezone preference is unavailable. Try again in Connection.") }
    }
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes.timezone) void load()
    }
    void load()
    chrome.storage?.onChanged?.addListener(changed)
    return () => { active = false; generation++; chrome.storage?.onChanged?.removeListener(changed) }
  }, [])
  return { timezone, error }
}
