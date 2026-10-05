# Storage

## Areas and instances

`@plasmohq/storage` enables the storage permission in a Plasmo project. It serializes supported values and provides change watchers. It uses `sync` by default. Use `local` for larger lists or data that does not need browser account synchronization.

```ts
import { Storage } from "@plasmohq/storage"

export const localStorage = new Storage({ area: "local" })
```

Put this shared instance in a source module, such as `core/storage.ts`. Use the same area for every reader and writer of a key. Read current browser quota documentation before choosing limits or storing large values.

The library can fall back to web `localStorage` outside extension contexts. Do not assume that this fallback shares extension storage. MAIN-world scripts lack direct extension storage access.

## React hooks

Put this popup in `popup.tsx`. A function initializer persists the default value for other contexts:

```tsx
import { useStorage } from "@plasmohq/storage/hook"

export default function IndexPopup() {
  const [enabled, setEnabled] = useStorage<boolean>(
    "isEnabled",
    (stored) => stored ?? true
  )

  return (
    <button onClick={() => setEnabled(!enabled)}>
      {enabled ? "Enabled" : "Disabled"}
    </button>
  )
}
```

A static initializer such as `useStorage("isEnabled", true)` supplies a local render default without persisting it. A content script can still read `undefined` until a write occurs. Match default behavior across contexts.

For a local-area key, use the shared instance:

```ts
const [items, setItems] = useStorage<string[]>({
  key: "savedItems",
  instance: localStorage
}, [])
```

Import `useStorage` and the shared `localStorage` in the component that contains this call. For form drafts, the hook also exposes `setRenderValue`, `setStoreValue`, and `remove`.

## Watchers and secrets

Use `storage.watch({ key: callback })` to react to changes. Read the installed API for unsubscribe behavior and clean up subscriptions when their owner unmounts. Watchers synchronize state but do not make read-modify-write operations atomic.

`SecureStorage` comes from `@plasmohq/storage/secure`. Call `setPassword` before encrypted operations. Its Web Crypto dependency requires a secure context. Protect the password separately from encrypted data.

Extension storage is not a secret vault. Do not bundle privileged API credentials or store them beside a bundled encryption password. Treat `copiedKeyList`, which mirrors values into web localStorage, as an additional exposure boundary.

## Firefox

Firefox development requires an explicit add-on ID for extension storage. Add it under `package.json` at `manifest.browser_specific_settings.gecko.id`. Read current Mozilla requirements for the chosen manifest version and ID format. Do not assume that a production ID equals a temporary development ID.

## Official sources

- [Storage API](https://docs.plasmo.com/framework/storage)
- [Chrome storage quickstart](https://docs.plasmo.com/quickstarts/with-chrome-storage)
- [Chrome storage limits](https://developer.chrome.com/docs/extensions/reference/api/storage)
