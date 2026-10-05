import type { DemoResponse, Run } from "./runs"

const snapshotAt = "2026-10-03T18:30:00.000Z"
const fixtures: Run[] = [
  { id: "019a-8f2c", name: "Sync customer records", jobKind: "script", path: "f/integrations/sync_customers", status: "failed", durationMs: 12400, trigger: "Schedule", startedAt: "2026-10-03T18:28:00.000Z" },
  { id: "019a-8f31", name: "Enrich new leads", jobKind: "script", path: "f/sales/enrich_leads", status: "running", durationMs: 8200, trigger: "Webhook", startedAt: "2026-10-03T18:29:51.800Z" },
  { id: "019a-8ee2", name: "Daily revenue report", jobKind: "script", path: "f/finance/daily_revenue", status: "success", durationMs: 3800, trigger: "Schedule", startedAt: "2026-10-03T18:25:00.000Z" },
  { id: "019a-8ec4", name: "Process invoice queue", jobKind: "script", path: "f/finance/process_invoices", status: "failed", durationMs: 1200, trigger: "Webhook", startedAt: "2026-10-03T18:22:00.000Z" },
  { id: "019a-8e91", name: "Refresh product catalog", jobKind: "script", path: "f/commerce/refresh_catalog", status: "success", durationMs: 6100, trigger: "Manual", startedAt: "2026-10-03T18:18:00.000Z" },
  { id: "019a-8e7b", name: "Generate weekly digest", jobKind: "script", path: "f/notifications/weekly_digest", status: "running", durationMs: 840000, trigger: "Manual", startedAt: "2026-10-03T18:16:00.000Z" },
  { id: "019a-8e61", name: "Archive completed exports", jobKind: "flow", path: "f/exports/archive", status: "success", durationMs: 2400, trigger: "Schedule", startedAt: "2026-10-03T18:12:00.000Z" },
  { id: "019a-8e50", name: "Update warehouse inventory", jobKind: "flow", path: "f/commerce/update_inventory", status: "success", durationMs: 15200, trigger: "Webhook", startedAt: "2026-10-03T18:10:00.000Z" },
  { id: "019a-8e40", name: "Reconcile payment records", jobKind: "flow", path: "f/finance/reconcile_payments", status: "success", durationMs: 9600, trigger: "Schedule", startedAt: "2026-10-03T18:08:00.000Z" },
  { id: "019a-8e30", name: "Export support metrics", jobKind: "flow", path: "f/support/export_metrics", status: "failed", durationMs: 1800, trigger: "Manual", startedAt: "2026-10-03T18:06:00.000Z" },
  { id: "019a-8e20", name: "Clean temporary files", jobKind: "flow", path: "f/maintenance/clean_temp", status: "success", durationMs: 4600, trigger: "Schedule", startedAt: "2026-10-03T18:04:00.000Z" },
  { id: "019a-8e10", name: "Prepare monthly analytics export for the operations team", jobKind: "flow", path: "f/analytics/monthly_operations_export", status: "success", durationMs: 21200, trigger: "Manual", startedAt: "2026-10-03T18:02:00.000Z" }
].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)) as Run[]

export function handleDemoRequest(message: unknown, sender: chrome.runtime.MessageSender, extensionId: string): DemoResponse {
  if (sender.id !== extensionId || sender.url !== `chrome-extension://${extensionId}/popup.html`) {
    return { ok: false, error: "This request is not from the ChroMill popup." }
  }
  if (!message || typeof message !== "object" || Array.isArray(message) ||
    Object.keys(message).length !== 1 || (message as Record<string, unknown>).type !== "demo:list") {
    return { ok: false, error: "Unsupported demo request." }
  }
  return { ok: true, mode: "demo", snapshotAt, runs: fixtures.map(run => ({ ...run })) }
}
