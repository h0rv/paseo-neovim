# Neovim for Paseo

Use Neovim as your file editor in [Paseo](https://github.com/getpaseo/paseo). Neovim runs on the daemon host and appears in Paseo's existing terminal. You can use your own Neovim configuration and plugins. There is no custom editor frontend.

## Requirements

You need a compatible Paseo app and daemon. This plugin depends on Paseo changes that are not yet released. The manifest's `>=0.14.0` requirement is not enough on its own. Do not install it into an unmodified release and expect these features to work. Follow the [compatibility guide](compatibility/README.md) to build both the app and daemon from the pinned Paseo source with the supplied patch.

Install Neovim and Git on the machine that runs the daemon. Both commands must be available to that daemon, or you must set their executable paths in the plugin settings. Neovim 0.9 or later is required if you enable Follow Paseo theme.

We tested the daemon integration on macOS. We have not tested it on other host operating systems.

A browser client does not need Neovim installed locally. It connects to Neovim on the daemon host. The same applies when your Paseo app connects to a remote daemon. There is no Wasm version of Neovim in this plugin.

## Install

Use the Paseo CLI from the same patched checkout, connected to your intended daemon. The compatibility guide explains how to run it from source. The commands below assume that this compatible CLI is available as `paseo`. From the root of this repository, run:

```sh
paseo plugin install .
```

You can also pass the path to your checkout:

```sh
paseo plugin install /path/to/paseo-neovim
```

The GitHub repository is initially private. If you have access, clone it with your GitHub credentials and use the local command above. After the repository is public, you can install from Git:

```sh
paseo plugin install github:h0rv/paseo-neovim
```

Git installation does not remove the requirement for a patched Paseo app and daemon. This repository is not published as an npm package.

### Choose the default editor

In Settings > Files > All text files, choose Neovim. Paseo then uses Neovim for text files selected in the file tree or opened through file links. Links with a line target open at that line. Files without extensions use the text default too.

An exact filename or extension preference takes precedence over the text default. Images keep their normal viewer.

## Configuration

In Settings > Plugins, open the actions menu for `neovim` and choose Neovim.

| Setting                        | Default | Meaning                                                                     |
| ------------------------------ | ------- | --------------------------------------------------------------------------- |
| Neovim executable              | `nvim`  | Use a command from the daemon's PATH or a path to an executable.            |
| Init file                      | Empty   | Use your normal Neovim configuration. A supplied path is passed with `-u`.  |
| Extra arguments                | Empty   | Supply one literal argument per line. There is no shell parsing or quoting. |
| Git executable                 | `git`   | Choose the executable for Git snapshots and native Git commands.            |
| Follow Paseo theme             | Off     | Use Paseo's editor typography and colors in Neovim.                         |
| Use Neovim for diffs           | Off     | Open Changes comparisons in native Neovim diff windows.                     |
| Use Neovim for merge conflicts | Off     | Open conflicted files in Neovim for resolution.                             |

All paths refer to the daemon host. Executable paths that contain directory separators are relative to the workspace unless absolute. The same rule applies to init-file paths. A leading `~/` means the daemon user's home directory. Launch settings apply to new sessions, not running processes. The plugin manages Neovim's `--listen` socket and rejects arguments that replace it or disable the interactive terminal.

Your Neovim configuration is yours. The plugin does not edit your init files or change keybindings.

### Theme and fonts

With Follow Paseo theme off, your colorscheme and Neovim options remain unchanged. The editor uses ordinary terminal rendering.

Enable Follow Paseo theme to use Paseo's background and syntax colors. The editor also uses the code font family and size from Settings > Appearance. Line spacing follows the source editor. An empty code-font field uses Paseo's default source-editor monospace stack instead of the ordinary terminal's font fallback.

Changes apply to a running editor without restarting Neovim. Your syntax parsers and plugins still run. Native RGB highlights cover Vim syntax groups and Neovim Tree-sitter groups.

Turning the option off restores ordinary terminal typography and selection colors. It also restores the previous highlights and `termguicolors` setting. If you select a different colorscheme while the option is on, the Paseo colors remain visible until you turn it off. Neovim then uses the newly selected colorscheme.

The terminal is a fixed-width grid, so line spacing is rounded to cell dimensions. Web and desktop clients use the requested CSS monospace stack. Native clients use supported installed fonts. On iOS these are Menlo or Courier. Android uses monospace. Arbitrary desktop font families are not available on native clients. Native selection colors follow Paseo, but the cursor remains a translucent block.

## Diff and merge views

The optional diff and merge settings are independent. Both are off by default. Neither changes your default file editor.

### Diffs

Enable Use Neovim for diffs to open a selected Changes file in a Neovim diff tab. Paseo still controls the comparison and file list.

| Paseo comparison | Left                                                 | Right                                  |
| ---------------- | ---------------------------------------------------- | -------------------------------------- |
| Uncommitted      | HEAD                                                 | Working tree, including staged changes |
| Base             | Merge base                                           | HEAD                                   |
| All              | Merge base                                           | Working tree                           |
| Commit           | First parent, or an empty side for an initial commit | Selected commit                        |

For working changes, the plugin's comparison dropdown also offers index versus working tree. Use it to view unstaged changes without changing Paseo's file list.

Git snapshots are read-only scratch buffers. Only an existing working-tree side is editable. An absent side stays absent, e.g., for a deleted file. Select another file in Paseo or in the plugin's file dropdown to focus its Neovim tab. Comparison changes reuse the tab for that path.

Live updates refresh snapshots without replacing modified buffers. Neovim checks unchanged working buffers for disk updates. Diff windows resize with their terminal.

Diff views reject binary files and text that is not UTF-8. They also reject symlinks and submodules. Snapshots over 8 MiB produce an error.

### Merge conflicts

Enable Use Neovim for merge conflicts and select a conflicted file in Changes. If Neovim diffs are also enabled, the file opens with BASE and LOCAL windows alongside REMOTE and MERGED. If only merge conflicts are enabled, the built-in diff stays visible until you choose Resolve in Neovim. Enabling the option alone does not start Neovim.

BASE uses index stage 1. LOCAL uses stage 2, and REMOTE uses stage 3. A missing stage is an empty read-only side. Edit and save the working-tree MERGED buffer. If the result file is missing, Neovim opens a new file buffer.

Stage the resolved file and commit with Git yourself. The plugin does not stage files or finish merges.

### Git commands inside Neovim

Use `:PaseoDiff` to compare the current file's HEAD version with its working-tree file. You can pass one of these arguments:

| Argument      | Comparison                                               |
| ------------- | -------------------------------------------------------- |
| `uncommitted` | Compare HEAD with the working tree. This is the default. |
| `index`       | Compare the index with the working tree.                 |
| `all`         | Compare the merge base with the working tree.            |
| `base`        | Compare the merge base with HEAD.                        |

Use `:PaseoMerge` for the current conflicted file. Both commands use Neovim windows. Errors appear inside Neovim.

Save the current buffer before opening these tools. Return to the ordinary editor tab with `gT` or `:tabprevious`. For `all` and `base`, set `b:paseo_base_ref` or `g:paseo_base_ref` to your base revision. Otherwise the plugin uses Git's `refs/remotes/origin/HEAD`. It reports an error if that reference is unavailable rather than assuming a branch name.

Your installed Git plugins and their commands remain unchanged. The plugin does not change Git configuration or install a global difftool.

## Sessions and undo

Closing a panel does not stop Neovim. Neither does turning off a tool or reloading the plugin. A restored tab reconnects to its saved session. To end the process, save your work and use `:qa` before closing the tab. Restarting an exited editor does not kill a live one. Embedded editors do not create extra standalone terminal tabs.

Persistent undo follows your `undofile` setting. Each session uses `stdpath("state")/paseo/undo/<session-id>`. Separate editors of the same file do not share an undo file. Restarting the same saved session reuses its undo history. A new session has separate history. Reconnecting to a running editor preserves its loaded undo trees. Your normal Neovim undo files are unchanged.

## Trust and permissions

Install this plugin only if you trust its code and dependencies. Paseo plugins are not sandboxed. Server code and installation preparation commands run on the daemon host. Client code runs inside Paseo. Future plugin updates are also code you must trust.

Neovim runs with the daemon user's permissions. Your Neovim configuration and plugins can run commands with those permissions. This is not a restricted editor for untrusted workspaces. The same permissions apply to the configured Git executable.

## Optional editor demo

The bundled Editor demo provider lets you try file links and editor updates without a model or API key. From this repository's root, install it separately:

```sh
paseo plugin install ./examples/editor-demo
```

Create an agent with provider Editor demo and model File editing demo. Choose a writable workspace and send `create`. Open a file link in the reply, then send `edit` to change the demo files. See the [demo guide](examples/editor-demo/README.md) for its file safety rules.

## Development

Use Node.js 24 through mise. Build the patched Paseo checkout as described in the [compatibility guide](compatibility/README.md). From this repository's root, install dependencies and then use the SDK from that checkout:

```sh
mise trust
mise install
mise exec -- npm ci
mise exec -- npm install --no-save --package-lock=false /path/to/patched-paseo/packages/plugin
mise exec -- npm run check
```

Run the local SDK install again after every `npm ci`. That command restores registry dependencies, which do not include the required unreleased APIs.

Native tests need Neovim. Set `NEOVIM_TEST_EXECUTABLE` to choose another executable. Tests that require Neovim skip when it is unavailable.

## License and source

This plugin was extracted from `plugin-examples/neovim` in [Paseo](https://github.com/getpaseo/paseo). The optional demo was extracted from `plugin-examples/editor-demo`.

The [LICENSE](LICENSE) is copied from Paseo. It includes the Apache License, Version 2.0, and the original copyright notice for Mohamed Boudra. Third-party components remain subject to their own licenses.
