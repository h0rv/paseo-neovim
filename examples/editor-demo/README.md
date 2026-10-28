# Editor demo

Use this local Paseo provider to try file links and editor updates without a model or API key. The provider writes fixed example files in your workspace. It does not interpret coding requests. Prompt text is never evaluated or used as a command. It is not used as a path or generated source either.

Use a compatible Paseo app and daemon. For the Neovim editor, follow the standalone plugin's [requirements and compatibility guide](../../README.md#requirements).

## Install and use

Use the compatible CLI described in the [root installation guide](../../README.md#install). From the root of the `paseo-neovim` repository, run:

```sh
paseo plugin install ./examples/editor-demo
```

Use the CLI connection settings for your intended daemon. The provider has no fixed daemon address or workspace. You do not need to build it or install dependencies separately for normal installation. Paseo loads the TypeScript server entry with its SDK.

1. In New Agent, choose Editor demo as the provider and File editing demo as the model. Choose a writable workspace.
2. Send `create`. The provider writes `paseo-editor-demo/greeting.ts` and `paseo-editor-demo/main.ts` under that workspace. Completed create tool rows appear only after the writes succeed.
3. Open a file link in the reply. Paseo opens the file at the linked line with your configured file editor. If you selected Neovim as your text editor, the file opens there.
4. Send `edit`. The provider updates both files to the next example revision. Another edit alternates the code shape and increases the visible revision.
5. To continue in a new agent, select the same workspace and send `edit`. The provider checks the files on disk rather than relying on the previous agent's state.

The `create` message leaves recognized files unchanged and creates missing demo files. The `edit` message creates the files if none exist. Otherwise it writes the next revision. Other text acts like `create` when no demo exists and like `edit` when one does. These are plain message keywords, not slash commands. Case and surrounding whitespace do not matter.

## File safety

The provider writes only its two fixed filenames in the `paseo-editor-demo` directory. It owns the full contents of both files. Before changing either file, it checks both against exact versions it generated. A manual change causes a visible failed turn rather than an overwrite. Even a whitespace change causes this check to fail.

The provider refuses unknown file contents or directories in place of files. It also refuses symlinks in the workspace path or demo paths, and files with extra hard links. Other workspace files are untouched, including other files in the demo directory.

To start again after manual edits, move the demo directory aside yourself to preserve your work. Then send `create`.

The provider never deletes user content or runs generated code. It does not stage files or commit changes. It does not call MCP tools or send prompts to an external service.

Only plain text messages are supported. System prompts and attachments are not supported. Steering and model configuration are not supported either. The provider cannot carry out arbitrary coding requests.

## Saved sessions

Paseo saves the conversation with a versioned handle for the workspace. The provider updates the handle after each turn, including failed or canceled turns. When you restore an agent, the provider checks the handle's version and workspace. It replays saved messages and file tool results without repeating file operations.

You can reload the plugin or refresh a saved agent and then send `edit` to continue. Each new edit checks the current files against the same safety rules. A new agent in the same workspace has a separate conversation but can continue the existing demo files. Sessions opened with persistence disabled do not publish a saved handle.

Interrupting or closing cancels work before the next file operation. The provider acknowledges cancellation after the turn settles. Each checked write is a small synchronous operation. Another plugin request cannot interrupt it halfway through.

Completed operations remain on disk if a later operation fails or is canceled. The error reports this, and the tool rows reflect the operations that occurred. Filesystem errors appear as errors rather than simulated success. Do not use concurrent external changes to collaborate on these demo files.

## Development

Run these commands from the root of the `paseo-neovim` repository. First build the patched Paseo checkout as described in the [compatibility guide](../../compatibility/README.md).

```sh
npm ci
npm install --no-save --package-lock=false /path/to/patched-paseo/packages/plugin
npm test -- examples/editor-demo/server/files.test.ts examples/editor-demo/server/provider.test.ts
npm run typecheck:demo
```

Repeat the local SDK install after every `npm ci`. Use Node.js 24, as selected by the repository's `mise.toml`.
