import { execFileSync } from "node:child_process"
import { expect, it } from "vitest"
import { isInspectionResponse } from "../../src/inspection"
import type { InspectionResponse } from "../../src/inspection"

it("accepts actual Python host responses at Unicode code-point limits without splitting characters", () => {
  const responses: InspectionResponse[] = JSON.parse(execFileSync("python3", ["tests/run-radar/native/unicode_fixture.py"], { maxBuffer: 8000000 }).toString())
  for (const [index, response] of responses.entries()) {
    expect(isInspectionResponse(response)).toBe(true)
    expect(Array.from(response.detail.logs.text!)).toHaveLength(index === 0 ? 40000 : 64000)
    expect(response.detail.logs.truncated).toBe(index === 2)
    for (const key of ["inputs", "result", "steps"] as const) {
      const field = response.detail[key]
      expect(Array.from(field.text!)).toHaveLength(32000)
      expect(field.text).toContain(key === "result" ? "\u{1f680}" : "\u{1f600}")
      expect(field.truncated).toBe(true)
    }
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(1048576)
    const oversized = { ...response, detail: { ...response.detail, logs: { ...response.detail.logs, text: "\u{1f600}".repeat(64001) } } }
    expect(isInspectionResponse(oversized)).toBe(false)
  }
})
