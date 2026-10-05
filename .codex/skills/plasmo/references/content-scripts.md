# Content scripts and UI

## Script or UI

Use `content.ts` for one script or `contents/<name>.ts` for several scripts. Plain `.ts` entries do not include a UI runtime. If an entry contains no imports or exports, add `export {}`.

Use `content.tsx` or `contents/<name>.tsx` with a default React component for content script UI (CSUI). Plasmo mounts it in a Shadow DOM, which isolates most component styles from the page.

Export explicit matching rules from each entry:

```ts
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://github.com/*"],
  run_at: "document_idle"
}
```

Keep matches narrow. Without a configuration export, Plasmo can use broad default matches.

## Execution worlds

The default isolated world shares the page DOM but isolates JavaScript globals. Use `world: "MAIN"` only when the feature needs page globals. MAIN code lacks direct extension API access. Route privileged operations through an isolated script and authorized messaging.

For programmatic injection, use `chrome.scripting.executeScript` with the required permission. An injected function cannot use the caller's imported values or closed-over variables. Pass JSON-serializable values in `args`.

Content script fetches follow page CORS restrictions. For authorized cross-origin access, use a background handler and the required host permissions. CORS means cross-origin resource sharing, which controls cross-site requests.

## Anchors and lifecycle

An anchor is the page element next to the UI. The default anchor is `document.body` with overlay rendering.

| Export | Purpose |
| --- | --- |
| `getOverlayAnchor` | One overlay target |
| `getOverlayAnchorList` | Several overlay targets |
| `getInlineAnchor` | One inline target |
| `getInlineAnchorList` | Several inline targets |
| `watchOverlayAnchor` | Custom positioning updates with cleanup |
| `mountShadowHost` | Custom host placement |
| `createShadowRoot` | Custom shadow root creation |
| `getShadowHostId` | Stable identity for removal detection |
| `getRootContainer` | Replace the default root |
| `render` | Replace the renderer |

Anchor getters can be asynchronous. Inline getters can return an element or an object with `element` and `insertPosition`. Use the installed Plasmo types for exact signatures.

The lifecycle guide warns that overlay anchor lists do not detect newly added anchors. Test pages that update their DOM after initial load. Return cleanup functions from positioning watchers and remove custom observers during teardown.

If you export `getRootContainer`, Plasmo ignores built-in Shadow DOM helpers such as `getStyle` and `getShadowHostId`. Apply equivalent behavior inside the custom root implementation when needed.

## Shadow DOM styles

For `contents/repo-overlay.tsx`, put its stylesheet at `contents/repo-overlay.css`. Import it relative to the entry to avoid source-root ambiguity:

```tsx
import cssText from "data-text:./repo-overlay.css"
import type { PlasmoCSConfig, PlasmoGetStyle } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["https://github.com/*"]
}

export const getStyle: PlasmoGetStyle = () => {
  const style = document.createElement("style")
  style.textContent = cssText
  return style
}

export default function RepoOverlay() {
  return <button className="repo-btn">Open repo notes</button>
}
```

The `config.css` array styles the host page. Use `getStyle` for component CSS inside the shadow root. Fonts can need a global `@font-face` declaration through `config.css`.

For CSS Modules, import the CSS as text for injection and as a module for class names. For CSS-in-JS, mount the style cache inside the shadow root. Put component variables under `:host` or use unique names. Host styles can still affect the shadow host and inherited properties.

For Tailwind setup, read [Integrations](integrations.md). For asset schemes and tilde paths, read [Configuration](configuration.md).

## Official sources

- [Content scripts](https://docs.plasmo.com/framework/content-scripts)
- [Content scripts UI](https://docs.plasmo.com/framework/content-scripts-ui)
- [Lifecycle and exports](https://docs.plasmo.com/framework/content-scripts-ui/life-cycle)
- [Styling and caveats](https://docs.plasmo.com/framework/content-scripts-ui/styling)
