import type { Run } from "./runs"

export function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)) return false
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true }
  catch { return false }
}
export function browserTimezone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return validTimezone(zone) ? zone : "UTC"
}
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!parts || !Number.isFinite(Date.parse(value))) return false
  const [, year, month, day, hour, minute, second, offset] = parts
  const calendar = new Date(`${year}-${month}-${day}T00:00:00.000Z`)
  return calendar.toISOString().slice(0, 10) === `${year}-${month}-${day}` &&
    Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 &&
    (offset === "Z" || Number(offset.slice(1, 3)) < 24 && Number(offset.slice(4)) < 60)
}
export function resolvedTimezone(run: Pick<Run, "timezone">, preference: string): string {
  return validTimezone(run.timezone) ? run.timezone : validTimezone(preference) ? preference : browserTimezone()
}
export function formatTimestamp(value: string, zone: string): string {
  if (!isTimestamp(value)) return "Invalid timestamp"
  const timeZone = validTimezone(zone) ? zone : browserTimezone()
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)!.value
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName").replace(/^GMT$/, "GMT+0")} (${timeZone})`
}
export function runTime(run: Pick<Run, "startedAt" | "timezone">, preference: string): string {
  return formatTimestamp(run.startedAt, resolvedTimezone(run, preference)) + (validTimezone(run.timezone) ? " [current schedule]" : "")
}

export function isTimezoneResponse(value: unknown): value is { ok: true; timezone: string } {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return Object.keys(item).sort().join(",") === "ok,timezone" && item.ok === true && validTimezone(item.timezone)
}
