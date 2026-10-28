# Paseo source compatibility

This plugin needs Paseo changes that are not in the inspected published SDK. Use the source setup below for both the Paseo app and its daemon. Installing the plugin into an unpatched release is not supported.

The patch is temporary until Paseo releases the required APIs. It does not add a Wasm runtime. This plugin starts native Neovim on the daemon host.

## Pinned source

The upstream repository is [getpaseo/paseo](https://github.com/getpaseo/paseo). The exact base commit is `33faacc0556e71dd0604413953385d497698cc4d`. These values are also in [base.json](base.json).

[paseo.patch](paseo.patch) contains generic host changes under the upstream `packages/` directory. It includes the new core source files and their tests. It excludes the original plugin examples and local runtime state. It also excludes `packages/server/src/server/agent/plugin-provider.test.ts`, whose added test depends on the original demo fixture.

The patch provides these APIs and fixes:

- Plugins can render `TerminalView` with the host's terminal renderer.
- Plugins can claim every text file with `files: { kind: "text" }` and receive file line targets with `supportsLineNavigation`.
- Plugins can contribute diff panels with `addDiffPanel`.
- Plugins can create terminals with `presentation: "embedded"` without opening separate terminal tabs.
- Plugins can use the host's `Select` component.
- Plugins can read theme syntax colors and use the editor appearance for embedded terminals.
- Server plugin dependencies retain lazy export getters during compilation.

Use the exact base rather than the latest upstream branch. A later commit may include only some of these changes or conflict with this patch.

## Apply and build

Use Node.js 24 through mise. Install native Neovim on the machine that will run the daemon. Native dependency installation may also need your platform's build tools.

Replace both paths before running these commands. `PLUGIN_DIR` is this plugin's existing checkout. `PASEO_DIR` is a new directory for the Paseo source checkout.

```sh
PLUGIN_DIR=/absolute/path/to/paseo-neovim
PASEO_DIR=/absolute/path/to/patched-paseo

git clone https://github.com/getpaseo/paseo.git "$PASEO_DIR"
cd "$PASEO_DIR"
git checkout --detach 33faacc0556e71dd0604413953385d497698cc4d
git apply --check "$PLUGIN_DIR/compatibility/paseo.patch"
git apply "$PLUGIN_DIR/compatibility/paseo.patch"
mise exec node@24 -- npm ci
mise exec node@24 -- npm run build:server
mise exec node@24 -- npm run build:app-deps
```

`npm run build:server` builds the daemon and CLI after building their workspace dependencies. It also builds `@getpaseo/plugin`. `npm run build:app-deps` builds the dependencies needed to run the app from source. Changing only the SDK does not update the host app or daemon.

These commands come from the pinned checkout's [root package scripts](https://github.com/getpaseo/paseo/blob/33faacc0556e71dd0604413953385d497698cc4d/package.json). The upstream [development guide](https://github.com/getpaseo/paseo/blob/33faacc0556e71dd0604413953385d497698cc4d/docs/development.md) explains the source runtime and its separate development state.

## Run the patched app and daemon

Run this command from the patched Paseo checkout in one terminal:

```sh
cd /absolute/path/to/patched-paseo
mise exec node@24 -- npm run dev:server
```

Run the app from the same checkout in another terminal:

```sh
cd /absolute/path/to/patched-paseo
mise exec node@24 -- npm run dev:app
```

Press `w` in Expo to open the browser app at `http://localhost:8081`. The source launchers connect it to the development daemon at `127.0.0.1:6768`. They use the checkout's `.dev/paseo-home` by default, not the packaged app's `~/.paseo` state.

Both processes must use the patched source. The app needs the new renderer and panel APIs. The daemon needs the terminal metadata changes and compiler fix. A patched daemon with a published app is not a supported setup.

Install the plugin into that development daemon from the patched checkout:

```sh
cd /absolute/path/to/patched-paseo
mise exec node@24 -- npm run cli -- plugin install /absolute/path/to/paseo-neovim
```

For the optional demo provider, run:

```sh
mise exec node@24 -- npm run cli -- plugin install /absolute/path/to/paseo-neovim/examples/editor-demo
```

These commands run the source equivalent of `paseo plugin install /path/to/plugin`. Use `npm run cli -- ...` here so the CLI uses the same development home and endpoint as the source daemon. A globally installed `paseo` command may target a different daemon.

## Develop the standalone plugin

Build the patched Paseo checkout first. Then install this plugin's dependencies and link its SDK dependency to the built source package:

```sh
cd /absolute/path/to/paseo-neovim
mise trust
mise install
mise exec -- npm ci
mise exec -- npm install --no-save --package-lock=false /absolute/path/to/patched-paseo/packages/plugin
mise exec -- npm run check
```

The SDK package exports built files from `packages/plugin/dist/`. Linking an unbuilt checkout does not supply those files. The source SDK also refers to the client and protocol packages built in the same Paseo checkout.

Repeat the local SDK install after every `npm ci`. That command restores the registry dependencies from the lockfile. The local install does not change the committed dependency declaration or lockfile.

Native tests need `nvim` on `PATH`. Set `NEOVIM_TEST_EXECUTABLE` to use another executable path. Tests that need native Neovim skip when it is unavailable.

## Published SDK evidence

The published `@getpaseo/plugin@0.14.0-beta.1` declarations were inspected during extraction:

- The published [UI declarations](https://unpkg.com/@getpaseo/plugin@0.14.0-beta.1/dist/client/ui.d.ts) do not declare `TerminalView` or `Select`.
- The published [client contracts](https://unpkg.com/@getpaseo/plugin@0.14.0-beta.1/dist/client/contracts.d.ts) do not declare `addDiffPanel`. They do not support the text file selector or `supportsLineNavigation`.
- The published [theme contract](https://unpkg.com/@getpaseo/plugin@0.14.0-beta.1/dist/contracts.d.ts) does not expose syntax colors.

The plugin manifest's `>=0.14.0` requirement is not proof that a release has these APIs. The source checkout and published SDK can share a version without exposing the same APIs. Use the pinned patch until the required APIs are confirmed in a published app and daemon.
