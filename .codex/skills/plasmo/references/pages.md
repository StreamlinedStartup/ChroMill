# Pages

## Extension pages

Each React entry exports a default component. Use the source root selected by the project, either the project root or `src/`.

| Page | Entry | Purpose |
| --- | --- | --- |
| Popup | `popup.tsx` or `popup/index.tsx` | Toolbar dialog |
| Options | `options.tsx` or `options/index.tsx` | Extension configuration |
| New tab | `newtab.tsx` or `newtab/index.tsx` | Replace the browser's new tab |
| Side panel | `sidepanel.tsx` or `sidepanel/index.tsx` | Persistent browser panel |
| Devtools | `devtools.tsx` or `devtools/index.tsx` | Developer tools page |

Make sure that the target browser supports the selected page type. Reload the extension manually if a newly added page does not appear.

## Extra tabs

Create `tabs/<name>.tsx` for an extra extension page. Open its generated path with the extension URL API:

```ts
const url = chrome.runtime.getURL("tabs/welcome.html")
await chrome.tabs.create({ url })
```

Put the default React component in `tabs/welcome.tsx`. These pages suit onboarding, authentication, and larger interfaces.

## HTML templates

To replace an entry's HTML template, create a matching `.html` file. For `popup/index.tsx`, use `popup/index.html`. Plasmo inserts the root and script elements. Preserve document metadata that the feature needs.

## Sandbox pages

A sandbox is an isolated page with separate content security rules. Create `sandbox.ts` or `sandboxes/<name>.ts` for scripts. UI entries use the supported component file type. The generated pages are `sandbox.html` and `sandboxes/<name>.html`.

Embed the sandbox in an iframe and communicate through `postMessage`. Sandboxed pages lack direct extension API access. Make sure that message sources and payloads match the expected operation. Sandboxed origins can be opaque, so do not depend only on an origin string.

The documentation demonstrates arbitrary `eval` of incoming messages. Do not copy that pattern into a feature that accepts untrusted input. Keep the operation specific and the response schema explicit.

## Official sources

- [Extension pages](https://docs.plasmo.com/framework/ext-pages)
- [Tab pages](https://docs.plasmo.com/framework/tab-pages)
- [Sandbox pages](https://docs.plasmo.com/framework/sandbox-pages)
- [HTML templates](https://docs.plasmo.com/framework/customization/html)
