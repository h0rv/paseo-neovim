# Neovim for Paseo

Neovim for [Paseo](https://github.com/getpaseo/paseo) opens workspace files in Neovim inside Paseo's terminal. Your normal Neovim configuration and plugins are available.

## Install

Neovim and Git are required on the daemon host, not on the browser's machine. The required Paseo app and daemon setup is in the [compatibility guide](compatibility/README.md).

```sh
paseo plugin install github:h0rv/paseo-neovim
```

Choose Neovim in Settings > Files > All text files.

## Configuration

Settings are under Settings > Plugins, in the actions menu for `neovim`.

| Setting                        | Default                             |
| ------------------------------ | ----------------------------------- |
| Neovim executable              | `nvim`                              |
| Init file                      | Your normal configuration           |
| Extra arguments                | None; one literal argument per line |
| Git executable                 | `git`                               |
| Follow Paseo theme             | Off                                 |
| Use Neovim for diffs           | Off                                 |
| Use Neovim for merge conflicts | Off                                 |

Follow Paseo theme applies Paseo's code font and colors. It requires Neovim 0.9 or later.

## Git and sessions

`:PaseoDiff` compares HEAD with the working file. `:PaseoDiff index` shows unstaged changes. `:PaseoMerge` opens conflict resolution. Git snapshots are read-only. Staging and commits remain manual.

Neovim keeps running when a panel closes. Save and use `:qa` to exit. Persistent undo follows your `undofile` setting and is separate for each session. The plugin does not edit your init files.

Neovim runs with the daemon user's permissions.

## Development

The [development guide](compatibility/README.md#develop-the-standalone-plugin) covers setup and checks with mise. The [demo provider](examples/editor-demo/README.md) creates and edits files without a model or API key.

## License

The software is licensed under the [Apache License, Version 2.0](LICENSE).
