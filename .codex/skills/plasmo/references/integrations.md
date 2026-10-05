# Integrations and migration

Read the named quickstart for the requested integration. Use its linked example repository for structure. Match APIs to installed versions rather than copying historical dependencies.

## Migration

Move residual manifest fields into `package.json.manifest`. Map popup, options, content scripts, worker, sandbox, and icons to Plasmo conventions. Keep behavior and permissions intact while replacing the prior build setup. Compare generated output with the original manifest.

Plasmo mounts default component exports automatically. Remove obsolete manual mount code only after confirming that the new entry owns that page. Use `tabs/` for extra pages and explicit content script matching.

## Next.js

Keep separate entry points for the extension and the web app. Share components that work in both runtimes. Extension public variables use `PLASMO_PUBLIC_`, while Next.js uses `NEXT_PUBLIC_`. Read the current Next.js build rules before sharing plugins or server-dependent components.

The quickstart contains a bundler comparison that does not establish current Next.js internals. Do not repeat it as a runtime guarantee.

## Stripe

The guide uses hosted payment links and backend subscription validation. Keep Stripe private keys on the backend. The extension can contain a public payment URL.

The guide combines Chrome identity, an OAuth client, and a stable extension ID. OAuth is a protocol that grants access with tokens. Read current Chrome identity and Google requirements before selecting scopes. Validate the access token and subscription on the backend.

An extension ID can depend on its public manifest key. Keep development and production IDs aligned with registered redirect and OAuth configuration. Do not put a generated private signing key in the extension bundle.

## Redux

The guide combines Redux Toolkit, `@plasmohq/redux-persist`, and `redux-persist-webextension-storage`. It watches storage changes and calls `persistor.resync()` to synchronize open extension pages. React uses `Provider` and `PersistGate` while state loads.

Keep persisted state serializable and consistent across storage areas. Test service worker restart and cross-page updates. Read installed library support before adopting the fork.

## Tailwind CSS

The documented manual setup targets Tailwind 3. Do not apply it to Tailwind 4 without current version-specific guidance. `pnpm create plasmo --with-tailwindcss` selects the example template.

The guide uses PostCSS and Autoprefixer with `postcss.config.js`. It warns that `.cjs` can fail in that setup. Extension pages import their CSS normally. Content script UI imports compiled text and injects it through `getStyle`.

Move CSS variables from page-level `:root` to the shadow host when the component needs isolated defaults. Read [Content scripts](content-scripts.md) for font and host-style caveats.

## Supabase

The guide creates a client with a public project URL and key. Use the client key intended for public use, never a service-role secret. Enforce database access with server-side policies.

The example uses local extension storage for authentication and session persistence. Register the correct development and production redirect URLs. Review its broad host permissions and web-accessible options page before adopting them.

## Firebase Auth

The guide initializes one Firebase app across reloads and sends authentication state to background handlers. Its prose describes cookies, but its examples use Plasmo Storage. Treat the code and current Firebase documentation as the basis for the chosen persistence design.

Do not copy the example's default sync storage for tokens. Choose storage exposure deliberately, remove all session credentials on logout, and handle expiration and refresh failures. Use current extension-specific Firebase guidance for the target browser.

## Google Analytics

The guide imports gtag through Plasmo's build-time HTTPS bundling and uses `PLASMO_PUBLIC_GTAG_ID`. Initialize analytics in the appropriate UI lifecycle. Do not load executable code from a remote URL at runtime.

Read current analytics integration and store requirements before shipping. Do not copy broad tracking or debug behavior without the requested product behavior.

## Chrome Storage quickstart

Use this guide for a popup and options page that share values through `useStorage`. Read [Storage](storage.md) first for persisted initializers, storage areas, and worker behavior.

## Official sources

- [Quickstarts overview](https://docs.plasmo.com/quickstarts)
- [Migrate to Plasmo](https://docs.plasmo.com/quickstarts/migrate-to-plasmo)
- [Next.js](https://docs.plasmo.com/quickstarts/with-nextjs)
- [Stripe](https://docs.plasmo.com/quickstarts/with-stripe)
- [Redux](https://docs.plasmo.com/quickstarts/with-redux)
- [Tailwind CSS](https://docs.plasmo.com/quickstarts/with-tailwindcss)
- [Supabase](https://docs.plasmo.com/quickstarts/with-supabase)
- [Firebase Auth](https://docs.plasmo.com/quickstarts/with-firebase-authentication)
- [Google Analytics](https://docs.plasmo.com/quickstarts/with-google-analytics)
- [Chrome Storage](https://docs.plasmo.com/quickstarts/with-chrome-storage)
- [Plasmo examples](https://github.com/PlasmoHQ/examples)
