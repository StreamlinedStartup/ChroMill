# Complete documentation index

Crawled on 2026-10-03 from [docs.plasmo.com](https://docs.plasmo.com/). All 47 canonical pages returned successfully. The 47 sitemap URLs and 47 public MDX routes in the official repository match this inventory. The repository also contains `_app.mdx`, which is an application wrapper, not a documentation route.

Read one topic reference, then open the specific source page when needed. Do not load this full index for routine work. This crawl covers public documentation, not every external website linked from it.

## Coverage

| Area | Pages | Result |
| --- | ---: | --- |
| Welcome | 1 | PASS |
| Framework | 28 | PASS |
| Itero | 8 | PASS |
| Quickstarts | 10 | PASS |

## Documentation pages

### Welcome

| Page | Read for | Local reference |
| --- | --- | --- |
| [Introduction to Plasmo](https://docs.plasmo.com/) | Framework, TestBed, and publisher product overview. | [workflows](workflows.md) |

### Framework

| Page | Read for | Local reference |
| --- | --- | --- |
| [Plasmo Framework](https://docs.plasmo.com/framework) | Setup, file conventions, generated manifest, and browser loading. | [workflows](workflows.md) |
| [Assets](https://docs.plasmo.com/framework/assets) | Inline images, web-accessible resources, WASM, and package assets. | [configuration](configuration.md) |
| [Background Service Worker](https://docs.plasmo.com/framework/background-service-worker) | Worker entry points and persistent state. | [messaging](messaging.md) |
| [Content Scripts](https://docs.plasmo.com/framework/content-scripts) | Script files, matching, MAIN world, CORS, and asset imports. | [content-scripts](content-scripts.md) |
| [Content Scripts UI](https://docs.plasmo.com/framework/content-scripts-ui) | Component mounting and Shadow DOM isolation. | [content-scripts](content-scripts.md) |
| [Life Cycle of Plasmo CSUI](https://docs.plasmo.com/framework/content-scripts-ui/life-cycle) | Anchors, positioning, shadow hosts, root replacement, and custom rendering. | [content-scripts](content-scripts.md) |
| [Styling Plasmo CSUI](https://docs.plasmo.com/framework/content-scripts-ui/styling) | Injected CSS, CSS Modules, fonts, CSS-in-JS, and host-style caveats. | [content-scripts](content-scripts.md) |
| [Customization](https://docs.plasmo.com/framework/customization) | Principles behind Plasmo customization. | [configuration](configuration.md) |
| [Alias Source Code Import](https://docs.plasmo.com/framework/customization/alias) | TypeScript paths, external imports, and compatible package aliases. | [configuration](configuration.md) |
| [Replacing the HTML Templates](https://docs.plasmo.com/framework/customization/html) | Matching HTML templates and generated script mounting. | [pages](pages.md) |
| [Customizing Internal Paths](https://docs.plasmo.com/framework/customization/internal-path) | Build and source path flags and environment equivalents. | [configuration](configuration.md) |
| [Overriding the Manifest](https://docs.plasmo.com/framework/customization/manifest) | Manifest overrides, package metadata, variables, and locale substitution. | [configuration](configuration.md) |
| [Using the src directory for source code](https://docs.plasmo.com/framework/customization/src) | Source layout, entry placement, assets, and TypeScript paths. | [configuration](configuration.md) |
| [Environment Variables](https://docs.plasmo.com/framework/env) | Built-in values, public variables, file priority, and substitution. | [configuration](configuration.md) |
| [Browser Extension Pages](https://docs.plasmo.com/framework/ext-pages) | Popup, options, new tab, side panel, and devtools entries. | [pages](pages.md) |
| [Extension Icon](https://docs.plasmo.com/framework/icon) | PNG source icons, generated sizes, and development or tag variants. | [configuration](configuration.md) |
| [Import Resolution](https://docs.plasmo.com/framework/import) | Import paths, asset schemes, transformed files, and source-root behavior. | [configuration](configuration.md) |
| [Localization and Internationalization](https://docs.plasmo.com/framework/locales) | Locale locations, default locale, message references, and hot reload. | [configuration](configuration.md) |
| [Messaging API](https://docs.plasmo.com/framework/messaging) | Request handlers, generated names, page relay, and ports. | [messaging](messaging.md) |
| [Importing Remote Code](https://docs.plasmo.com/framework/remote-code) | Build-time HTTPS imports and public variable substitution. | [configuration](configuration.md) |
| [Sandbox Pages](https://docs.plasmo.com/framework/sandbox-pages) | Sandbox entries, iframe communication, and separate security rules. | [pages](pages.md) |
| [Storage API](https://docs.plasmo.com/framework/storage) | Storage areas, watchers, SecureStorage, hooks, and Firefox IDs. | [storage](storage.md) |
| [Tab Pages](https://docs.plasmo.com/framework/tab-pages) | Extra extension pages under tabs and their generated URLs. | [pages](pages.md) |
| [Create a Production Build](https://docs.plasmo.com/framework/workflows/build) | Archives, targets, tags, source maps, analysis, and optimization flags. | [workflows](workflows.md) |
| [Start the Development Server](https://docs.plasmo.com/framework/workflows/dev) | Loading extensions, target selection, server ports, and source maps. | [workflows](workflows.md) |
| [Workflows Frequently Asked Questions](https://docs.plasmo.com/framework/workflows/faq) | Upgrades, experimental releases, verbose output, and supported targets. | [workflows](workflows.md) |
| [Create a New Extension](https://docs.plasmo.com/framework/workflows/new) | Interactive scaffolding, custom entries, and example templates. | [workflows](workflows.md) |
| [Submit Your Extension](https://docs.plasmo.com/framework/workflows/submit) | BPP submission, store credential schema, and GitHub secrets. | [workflows](workflows.md) |

### Itero

| Page | Read for | Local reference |
| --- | --- | --- |
| [Welcome to Itero: The Browser Extension Cloud](https://docs.plasmo.com/itero) | Hosted testing, builds, publishing, and conversion overview. | [itero](itero.md) |
| [Manual Upload API](https://docs.plasmo.com/itero/api) | Signed uploads, archive transfer, signing, and BPP integration. | [itero](itero.md) |
| [GitHub Extension Builder](https://docs.plasmo.com/itero/builder) | GitHub app installation, repository linking, builds, and logs. | [itero](itero.md) |
| [Itero GitHub Integration](https://docs.plasmo.com/itero/github) | Repository binding, tracked branches, team transitions, and attribution. | [itero](itero.md) |
| [Manifest Version 2 to 3 Converter](https://docs.plasmo.com/itero/mv2-to-mv3) | Manifest conversion and code scanning for migration. | [itero](itero.md) |
| [Publisher](https://docs.plasmo.com/itero/publisher) | Store submission and provider credential setup. | [itero](itero.md) |
| [Team](https://docs.plasmo.com/itero/team) | Teams, invitations, joining, and member roles. | [itero](itero.md) |
| [Itero TestBed: Your Browser Extension Testing Solution](https://docs.plasmo.com/itero/test-bed) | Staging archives, install links, access controls, and tester updates. | [itero](itero.md) |

### Quickstarts

| Page | Read for | Local reference |
| --- | --- | --- |
| [Table of Contents](https://docs.plasmo.com/quickstarts) | Integration and migration guide directory. | [integrations](integrations.md) |
| [Migrate to Plasmo Framework](https://docs.plasmo.com/quickstarts/migrate-to-plasmo) | Map existing manifests, pages, scripts, and builds to Plasmo. | [integrations](integrations.md) |
| [Quickstart with Chrome Storage](https://docs.plasmo.com/quickstarts/with-chrome-storage) | Shared popup and options state through storage hooks. | [integrations](integrations.md) |
| [Quickstart with Firebase Auth](https://docs.plasmo.com/quickstarts/with-firebase-authentication) | Firebase initialization, authentication handlers, tokens, and refresh. | [integrations](integrations.md) |
| [Quickstart with Google Analytics](https://docs.plasmo.com/quickstarts/with-google-analytics) | Measurement IDs, bundled gtag, and React initialization. | [integrations](integrations.md) |
| [Quickstart with Next.js](https://docs.plasmo.com/quickstarts/with-nextjs) | Separate web and extension entries with shared components. | [integrations](integrations.md) |
| [Quickstart with Redux](https://docs.plasmo.com/quickstarts/with-redux) | Persisted Redux state and cross-page synchronization. | [integrations](integrations.md) |
| [Quickstart with Stripe](https://docs.plasmo.com/quickstarts/with-stripe) | Hosted payment links, Chrome identity, and backend subscriptions. | [integrations](integrations.md) |
| [Quickstart with Supabase](https://docs.plasmo.com/quickstarts/with-supabase) | Public client setup, sessions, extension IDs, and redirects. | [integrations](integrations.md) |
| [Quickstart with TailwindCSS](https://docs.plasmo.com/quickstarts/with-tailwindcss) | Tailwind 3, PostCSS, page styles, and shadow-root injection. | [integrations](integrations.md) |

## Other discovered links

| URL | Crawl result | Treatment |
| --- | --- | --- |
| https://docs.plasmo.com/csui | Redirects to the content script UI guide | Alias, not another page |
| https://docs.plasmo.com/bug | Redirects to GitHub sign-in | Feedback link, not documentation |
| https://docs.plasmo.com/signup | HTTP 404 | Broken account link |
| https://docs.plasmo.com/password_reset | HTTP 404 | Broken account link |

## Refresh and provenance

Start at the docs homepage and follow same-host page links. Compare discovered canonical routes with the [sitemap](https://docs.plasmo.com/sitemap-0.xml) and [official page sources](https://github.com/PlasmoHQ/docs/tree/main/src/pages). Exclude application wrappers, feedback destinations, and account links from the page count. Record failures rather than silently omitting them.

Update topic summaries only after reading changed pages. Use current package declarations for implementation details. Preserve the compact entry point and read references only when their task applies.

The [machine-readable inventory](crawl-inventory.json) records each URL, final destination, result, and local topic reference. It stores no full page text.
