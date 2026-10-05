# Workflows

## New projects

Use a supported Node.js version for the selected Plasmo release. The getting-started page lists an old minimum, so read package requirements before choosing a runtime. If the project uses mise, pin its runtime before writing code and define its dev, test, and build tasks.

Run these commands from the parent directory, then enter the generated project:

```bash
pnpm create plasmo my-extension
cd my-extension
```

The default template contains `popup.tsx`. Use `--entry=options,newtab,contents/inline` for specific entries. Use `--with-tailwindcss` or another documented example flag for a template. Use `--with-src` for source files under `src/`.

## Development

From the project directory, run `pnpm dev` through the project's task runner when one exists. Keep the development process in a named tmux session when local rules require it.

Open `chrome://extensions`, enable Developer Mode, and load `build/chrome-mv3-dev` with Load unpacked. Reload the extension manually after adding a new extension page if hot reload does not detect it.

Development uses source maps by default. The documented server ports are 1012 for serving, 1815 for HMR, and 1816 for reporting. HMR means hot module replacement, which updates code during development.

| Need | Plasmo command |
| --- | --- |
| Firefox development | `pnpm exec plasmo dev --target=firefox-mv2` |
| Disable source maps | `pnpm exec plasmo dev --no-source-maps` |
| Change serve address | `pnpm exec plasmo dev --serve-host=localhost --serve-port=1012` |
| Change reload address | `pnpm exec plasmo dev --hmr-host=localhost --hmr-port=1815` |

## Build and package

Build first, then package the selected production output:

```bash
pnpm build
pnpm package
```

`pnpm build --zip` combines the operations. Default production output is `build/chrome-mv3-prod`. Match the target and tag across build and package commands.

| Need | Plasmo command |
| --- | --- |
| Firefox build | `pnpm exec plasmo build --target=firefox-mv2` |
| Staging tag | `pnpm exec plasmo build --tag=staging` |
| Production maps | `pnpm exec plasmo build --source-maps` |
| Bundle analysis | `pnpm exec plasmo build --source-maps --bundle-buddy` |
| Disable minification | `pnpm exec plasmo build --no-minify` |
| Dependency hoisting | `pnpm exec plasmo build --hoist` |

Hoisting changes dependency behavior. Use it only after testing packages that load plugins or dynamic dependencies.

The docs list `chrome-mv3` and `firefox-mv2` as supported targets. They mark `firefox-mv3` as experimental. Chromium targets include `edge-mv3`, `brave-mv3`, and `opera-mv3`. Safari requires conversion steps. Read current browser requirements before promising compatibility.

Target selection also selects browser-specific entries, such as `popup.firefox.tsx`, and `.env.<browser>` files. Tags change the output suffix and environment selection.

## Diagnose and ship

Use the CLI's `--verbose` flag to diagnose build failures. Remove secrets and personal data before sharing logs. Inspect generated permissions, file paths, and entry points. Load the production bundle and test worker restart, storage persistence, and each feature.

For an authorized upgrade, use `pnpm up -L plasmo` or update the pinned dependency. Preserve the lockfile. The `lab` release channel is experimental.

The submission guide describes Browser Platform Publish (BPP), a GitHub action that submits extension archives. It uses store credentials in the `SUBMIT_KEYS` repository secret. Read the current BPP schema and token guide before configuring submission. Packaging alone does not authorize a store upload.

## Official sources

- [Getting started](https://docs.plasmo.com/framework)
- [New extension](https://docs.plasmo.com/framework/workflows/new)
- [Development server](https://docs.plasmo.com/framework/workflows/dev)
- [Production build](https://docs.plasmo.com/framework/workflows/build)
- [Submission](https://docs.plasmo.com/framework/workflows/submit)
- [FAQ and supported targets](https://docs.plasmo.com/framework/workflows/faq)
- [BPP repository](https://github.com/PlasmoHQ/bpp)
