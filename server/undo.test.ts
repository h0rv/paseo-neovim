import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { UNDO_LUA } from "./undo";

const executable = process.env.NEOVIM_TEST_EXECUTABLE || "nvim";
const available = spawnSync(executable, ["--version"], { encoding: "utf8" }).status === 0;

interface UndoResult {
  directory: string;
  undoFile: string;
}

function native(root: string, sessionId: string, actions: string): UndoResult {
  const script = `
local apply = assert(loadstring(${JSON.stringify(UNDO_LUA)}))
local filename = ${JSON.stringify(path.join(root, "same-file.txt"))}
vim.o.undofile = true
vim.opt.undodir = {${JSON.stringify(path.join(root, "shared"))}}
local session_id = ${JSON.stringify(sessionId)}
${actions}
io.stdout:write(vim.json.encode({directory = vim.o.undodir, undoFile = vim.fn.undofile(filename)}))
`;
  const command = `lua local ok, err = pcall(assert(loadstring(${JSON.stringify(script)}))); if not ok then vim.api.nvim_err_writeln(tostring(err)); vim.cmd('cquit 1') else vim.cmd('qa!') end`;
  return JSON.parse(
    execFileSync(executable, ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-c", command], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, XDG_STATE_HOME: path.join(root, "state") },
    }),
  );
}

describe.skipIf(!available)("native persistent undo isolation", () => {
  it("retains independent histories across editor restarts without discarding loaded edits", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-native-undo-"));
    const filename = path.join(root, "same-file.txt");
    try {
      writeFileSync(filename, "original\n");
      const first = native(
        root,
        "editor-a",
        `
vim.cmd.edit(filename)
vim.api.nvim_buf_set_lines(0, 0, -1, false, {'first editor'})
local buf = vim.api.nvim_get_current_buf()
local directory = apply(session_id)
assert(vim.bo.modified and vim.api.nvim_get_current_buf() == buf)
assert(vim.fn.readfile(filename)[1] == 'original')
assert(vim.fn.filereadable(vim.fn.undofile(filename)) == 1)
assert(apply(session_id) == directory)
assert(vim.bo.undofile)
vim.cmd.write()
`,
      );
      const second = native(
        root,
        "editor-b",
        `
apply(session_id)
vim.cmd.edit(filename)
vim.api.nvim_buf_set_lines(0, 0, -1, false, {'second editor'})
vim.cmd.write()
`,
      );
      expect(first.undoFile).not.toBe(second.undoFile);
      native(
        root,
        "editor-b",
        `
apply(session_id)
vim.cmd.edit(filename)
vim.cmd.undo()
assert(vim.api.nvim_get_current_line() == 'first editor')
`,
      );
      writeFileSync(filename, "first editor\n");
      native(
        root,
        "editor-a",
        `
apply(session_id)
vim.cmd.edit(filename)
vim.cmd.undo()
assert(vim.api.nvim_get_current_line() == 'original')
`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
