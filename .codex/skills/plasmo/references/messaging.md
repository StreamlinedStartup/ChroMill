# Background and messaging

## Worker structure

Use `background.ts` for a standalone worker. When using `@plasmohq/messaging`, move that entry to `background/index.ts`. Put request handlers in `background/messages/<name>.ts` and port handlers in `background/ports/<name>.ts`.

Register event listeners at module scope so the browser can dispatch wake-up events. Create context menus in `chrome.runtime.onInstalled`. Use alarms for scheduled work with the `alarms` permission. Persist durable state with [Storage](storage.md).

Plasmo keeps development workers active. Test the production bundle after worker suspension and restart. Do not rely on module variables as persistent data or on development behavior as a lifetime guarantee.

## Request handlers

Install the companion library from the project directory:

```bash
pnpm add @plasmohq/messaging
```

Put this handler in `background/messages/ping.ts`. Keep `background/index.ts` present, even if it contains only `export {}`.

```ts
import type { PlasmoMessaging } from "@plasmohq/messaging"

const handler: PlasmoMessaging.MessageHandler = async (_req, res) => {
  res.send({ ok: true })
}

export default handler
```

Call it from an extension page or isolated content script:

```ts
import { sendToBackground } from "@plasmohq/messaging"

const response = await sendToBackground({ name: "ping" })
```

Build or start development to generate message-name types. If `name` resolves to `never`, regenerate types and restart the editor's TypeScript server.

Treat request bodies as untrusted input even when TypeScript describes them. TypeScript types do not enforce runtime validation. Return an explicit error response when an operation fails. Await storage writes and privileged operations before returning success.

The documented request flow goes from extension pages or content scripts to the background. For background-to-content requests, use `chrome.tabs.sendMessage` and a receiver in the isolated content script. Do not assume a `sendToContentScript` export exists.

## Ports

Use `background/ports/<name>.ts` for long-lived connections. Read the official ports section and installed declarations for `getPort`, `usePort`, and handler signatures. Handle disconnection and worker restart. A port does not make persistent state unnecessary.

## Page relay

Register `relayMessage` in an isolated content script. Use `sendToBackgroundViaRelay` from the page. Narrow the script's matches and expose only the intended handler.

The docs mark relay as alpha. Authorize sensitive operations in the handler and validate payloads. A same-origin message does not prove that trusted page code sent it. Do not allow a relay to fetch arbitrary URLs or write arbitrary keys.

For MAIN-world messaging, read the current guide and installed implementation before choosing external messaging or a relay. The guide shows an `extensionId` argument, but browser permissions and connection rules still apply.

## Concurrent state updates

A storage read followed by a write is not atomic. Two requests that append to one array can overwrite each other's changes. Centralize writes and serialize overlapping updates, or use a storage design with independent records. For transactional requirements, choose a store that supports transactions.

Do not copy the draft's uncoordinated read, push, and set sequence into a handler that receives concurrent requests.

## Official sources

- [Background service worker](https://docs.plasmo.com/framework/background-service-worker)
- [Messaging, relay, and ports](https://docs.plasmo.com/framework/messaging)
- [Companion libraries](https://github.com/PlasmoHQ/plasmo/tree/main/api)
