import type { CDPSession } from "@playwright/test"
import { writeFile } from "node:fs/promises"

export async function attach(session: CDPSession, targetId: string) {
  const { sessionId } = await session.send("Target.attachToTarget", { targetId, flatten: false })
  let sequence = 0
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>()
  session.on("Target.receivedMessageFromTarget", event => {
    if (event.sessionId !== sessionId) return
    const response = JSON.parse(event.message)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    if (response.error) request.reject(new Error("Extension target protocol failed"))
    else request.resolve(response.result)
  })
  async function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++sequence
    const result = new Promise<Record<string, unknown>>((resolve, reject) => pending.set(id, { resolve, reject }))
    await session.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) })
    return result
  }
  return {
    send,
    async evaluate(expression: string) {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
      if (response.exceptionDetails) throw new Error("Extension evaluation failed")
      return (response.result as { value: unknown }).value
    },
    async screenshot(file: string) {
      const response = await send("Page.captureScreenshot", { format: "png" })
      await writeFile(file, Buffer.from(response.data as string, "base64"))
    },
    async key(key: string, code: string, virtualKey: number) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, text: key === "Enter" ? "\r" : undefined })
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey })
    }
  }
}
