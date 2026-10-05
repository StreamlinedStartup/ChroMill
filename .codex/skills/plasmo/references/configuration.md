# Configuration and assets

## Manifest and layout

Put overrides under `manifest` in `package.json`:

```json
{
  "manifest": {
    "host_permissions": ["https://github.com/*"],
    "permissions": ["contextMenus"]
  }
}
```

Plasmo derives common fields from source entries and package metadata. `displayName` maps to the extension name. `version`, `description`, `author`, and `homepage` also contribute manifest values. Inspect the generated manifest rather than editing build output.

For a `src/` layout, move all source entries there and keep `assets/` at the project root. Map `~*` to `./src/*` in `tsconfig.json`. Include `.plasmo/index.d.ts` so generated declarations remain visible.

Use `--build-path` and `--src-path` for custom output and source paths. These flags apply to dev, build, and package. Environment equivalents are `PLASMO_BUILD_PATH` and `PLASMO_SRC_PATH`.

To customize imports, use TypeScript `paths` for source aliases. Use `package.json.alias` for package replacement or external file aliases. Add declarations when external JavaScript imports lack types. The customization principles page explains when Plasmo exposes overrides.

## Environment variables

Before creating or populating project environment variables, ask the user to choose 1Password Environments or a plain `.env` file. Reuse an existing project choice.

Built-in client values include `NODE_ENV`, `PLASMO_TARGET`, `PLASMO_BROWSER`, `PLASMO_MANIFEST_VERSION`, and `PLASMO_TAG`. Use direct access such as `process.env.PLASMO_BROWSER` in code.

Custom client values require the `PLASMO_PUBLIC_` prefix. This prefix exposes the value in the extension bundle. Values without the prefix can still enter manifest overrides through `$VARIABLE` substitution. Missing variables can cause manifest fields to disappear.

The docs describe browser files, tag files, Node environment files, and `.local` variants. Browser selection takes priority over tag selection. Local files take priority over non-local files. `--env=<path>` selects a file with the highest priority. Read the source and installed version for exact cascading behavior when files overlap.

### 1Password route

Use the `onepassword-mcp` server through the running, unlocked 1Password desktop app. Authenticate to obtain the account ID. Select or create an Environment for the project and stage. Pass variable values through `append_variables`, never shell commands.

Materialize the Environment with `create_local_env_file`. The mounted path is a FIFO, a named pipe that serves values on each open. It contains zero bytes at rest. Gitignore the mount path and never read or print secret values. Inspect keys only.

Consume the pipe on the host. Do not bind-mount it into Docker or DDEV because the host writer does not cross the virtual machine boundary. For Compose, read values on the host through interpolation or host-evaluated `env_file` behavior.

Do not use a production Environment in standing development containers. Desktop MCP approval is interactive and does not support unattended CI. A separate CLI service-account route can retrieve its token from macOS Keychain. The `op environment` command requires the CLI beta described in the user's environment rules.

## Import paths and schemes

For plain source imports, `~` follows the source root. With asset schemes, `~` follows the project root even when source files live in `src/`. Absolute `/` imports follow the project root. Relative paths follow the importing file.

| Scheme | Result |
| --- | --- |
| `raw:` | Copy the original asset and return its URL |
| `raw-env:` | Copy an asset after environment substitution |
| `url:` | Transform an asset, copy dependencies, and return its URL |
| `data-text:` | Transform and inline text as a string |
| `data-text-env:` | Substitute public variables and inline text |
| `data-base64:` | Inline an encoded data URL |
| `data-env:` | Substitute variables and return the asset value |
| `react:` for SVG | Transform an SVG into a React component |

Content script `url:` imports can add web-accessible resources automatically. Declare additional resources under `manifest.web_accessible_resources`, with narrow matches. Plasmo resolves project assets and package assets from `node_modules`.

Read Import Resolution for CSS, Sass, Less, images, JSON, JSON5, and GraphQL handling. Use relative imports for a stylesheet next to its content script.

## Icons and locales

Put a PNG icon at `assets/icon.png`. Plasmo generates smaller icons. Use `icon.development.png` to replace the grayscale development icon. Tag-specific and size-specific variants follow the naming rules in the icon guide.

Use one supported locale location consistently: `locales/<lang>/messages.json`, `assets/_locales/<lang>/messages.json`, or `assets/locales/<lang>/messages.json`. Set `manifest.default_locale` explicitly. The default otherwise follows alphabetic locale order.

Read messages in code with `chrome.i18n.getMessage`. Reference manifest messages with `__MSG_<key>__`. Locale files also support public environment substitution. Restart development when adding locale files that did not exist at server startup.

## Remote imports

Plasmo bundles HTTPS JavaScript imports at build time. This differs from runtime remote code execution. Public environment variables can appear in import URLs through `$PLASMO_PUBLIC_*` substitution.

Inspect the bundled code and current browser store policy before adopting remote dependencies. Successful bundling does not prove policy compliance or runtime compatibility.

## Official sources

- [Customization principles](https://docs.plasmo.com/framework/customization)
- [Manifest overrides](https://docs.plasmo.com/framework/customization/manifest)
- [Source directory](https://docs.plasmo.com/framework/customization/src)
- [Import aliases](https://docs.plasmo.com/framework/customization/alias)
- [Internal paths](https://docs.plasmo.com/framework/customization/internal-path)
- [Environment variables](https://docs.plasmo.com/framework/env)
- [Import resolution](https://docs.plasmo.com/framework/import)
- [Assets](https://docs.plasmo.com/framework/assets)
- [Icons](https://docs.plasmo.com/framework/icon)
- [Locales](https://docs.plasmo.com/framework/locales)
- [Remote code](https://docs.plasmo.com/framework/remote-code)
