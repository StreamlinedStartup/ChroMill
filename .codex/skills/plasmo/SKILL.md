---
name: plasmo
description: >-
  Build, debug, and package browser extensions with Plasmo, React, and TypeScript.
  Use for Plasmo projects, content script UI, storage, messaging, browser targets,
  store packaging, and Plasmo Itero workflows. Also use when a user requests a
  React browser extension without choosing another framework.
license: Apache-2.0
metadata:
  author: terminal-skills
  version: "2.0.0"
  category: development
  tags: [chrome-extension, browser, react, typescript, manifest-v3]
  repository: https://github.com/PlasmoHQ/plasmo
  docs: https://docs.plasmo.com/
  docs_crawled: "2026-10-03"
  compatibility: "Node.js and pnpm. Match runtime requirements to the installed Plasmo version. Chrome/Chromium, Firefox, and Edge targets."
---

# Plasmo

Plasmo builds browser extensions from source files and generates the manifest. File names select popups, content scripts, background workers, and other pages. React and TypeScript are the default choices. Preserve an existing framework choice.

## Read only what the task needs

Read the relevant local reference before implementation. Open its official source links when details depend on package versions or browser behavior. Do not load every reference.

| Task | Reference |
| --- | --- |
| Create, develop, build, package, select targets, or diagnose build failures | [Workflows](references/workflows.md) |
| Popup, options, new tab, side panel, devtools, extra tabs, or sandbox | [Pages](references/pages.md) |
| Content scripts, page execution, anchors, lifecycle, or Shadow DOM styles | [Content scripts and UI](references/content-scripts.md) |
| Background events, request handlers, relay, or ports | [Background and messaging](references/messaging.md) |
| Shared state, hooks, local/sync areas, encryption, or Firefox storage | [Storage](references/storage.md) |
| Manifest, environment variables, imports, assets, icons, locales, or directory layout | [Configuration and assets](references/configuration.md) |
| Migration, Next.js, Stripe, Redux, Tailwind, Supabase, Firebase, or Analytics | [Integrations](references/integrations.md) |
| Itero TestBed, teams, Builder, Publisher, GitHub, or upload API | [Itero](references/itero.md) |
| Find any documentation page, including less common topics | [Complete docs index](references/docs-index.md) |

The index covers all 47 canonical pages discovered through same-site links on the crawl date. It includes page titles, source URLs, topic routing, aliases, and failed links. It is a map, not a copied manual.

## Working rules

1. Inspect the package manifest, lockfile, source layout, and installed Plasmo types before editing.
2. Follow the project's runtime and task conventions. Use pnpm for the commands in these references.
3. Export a default component from UI entry files. Export `config: PlasmoCSConfig` from content scripts that need explicit matching.
4. Put manifest overrides in `package.json` under `manifest`. Inspect the generated manifest after the build.
5. Test every browser target that the user will ship. Test production worker behavior because development keeps workers active.

Use `background/index.ts` when adding `@plasmohq/messaging`. Keep durable worker state in storage. Register extension event listeners at module scope.

Use narrow permissions and host patterns that meet the feature requirements. Validate messages at each trust boundary. A page relay gives website code access to a handler, so authorize the requested operation.

Treat bundled values and `PLASMO_PUBLIC_*` variables as public. Manifest substitution can expose variables without that prefix. SecureStorage does not protect secrets that the bundle also contains.

Before creating or populating project environment variables, ask for 1Password Environments or a plain `.env` file. Reuse an existing project choice. Read the environment section in [Configuration](references/configuration.md) for the 1Password FIFO constraints.

Do not hard-code latest release numbers or current store rules from this snapshot. Read current official documentation when those facts matter. The crawl describes what the docs publish, not proof that every hosted service or historical example still works.

## Feature recipes

For a popup toggle that highlights TODO text, read Storage and Content scripts. Persist the initial toggle value so the content script receives it. Walk text nodes and exclude scripts, styles, editable fields, and existing highlight wrappers. Subscribe to storage changes and clean up observers and wrappers when disabled.

For saving selected text from a context menu, read Messaging and Storage. Create the menu during `onInstalled` and register `onClicked` at module scope. Use one background owner for updates and handle concurrent writes explicitly. Store the list in `local`, update the badge after a successful write, and use the same area in the popup.

## Sources and refresh

Start with the [official docs](https://docs.plasmo.com/) and the [complete index](references/docs-index.md). Use installed declarations to resolve API differences. The [crawl inventory](references/crawl-inventory.json) records canonical URLs, final URLs, and failures without storing full documentation text.
