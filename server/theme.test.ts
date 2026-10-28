import { execFileSync, spawnSync } from "node:child_process";
import { describe, it } from "vitest";
import { THEME_LUA } from "./theme";

// Native behavior is exercised when Neovim is installed; mapping tests do not need it.
const executable = process.env.NEOVIM_TEST_EXECUTABLE || "nvim";
const available = spawnSync(executable, ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!available)("native Neovim theme restoration", () => {
  it("preserves highlights, links and options across updates, disable and colorscheme changes", () => {
    const script = `
local apply = assert(loadstring(${JSON.stringify(THEME_LUA)}))
local function hl(name) return vim.api.nvim_get_hl(0, {name = name, link = true}) end
local function equal(actual, expected)
  assert(vim.deep_equal(actual, expected), vim.inspect({actual = actual, expected = expected}))
end
vim.cmd('colorscheme default')
local default_normal, default_comment = hl('Normal'), hl('Comment')
vim.api.nvim_set_hl(0, 'Normal', {fg = 0x123456, bg = 0x654321, bold = true})
vim.api.nvim_set_hl(0, 'Comment', {link = 'String'})
vim.o.termguicolors = false
local original_normal, original_comment = hl('Normal'), hl('Comment')
assert(apply(vim.NIL) == false)
equal(hl('Normal'), original_normal)
assert(vim.o.termguicolors == false)
apply({Normal = {fg = 0xffffff, bg = 0x181b1a}, Comment = {fg = 0x8b949e}})
equal(hl('Normal'), {fg = 0xffffff, bg = 0x181b1a})
assert(vim.o.termguicolors == true)
apply({Normal = {fg = 0x111111, bg = 0xffffff}, Comment = {fg = 0x6e7781}})
equal(hl('Normal'), {fg = 0x111111, bg = 0xffffff})
apply(vim.NIL)
equal(hl('Normal'), original_normal)
equal(hl('Comment'), original_comment)
assert(vim.o.termguicolors == false)
apply({Normal = {fg = 0xffffff, bg = 0x181b1a}, Comment = {fg = 0x8b949e}})
vim.cmd('colorscheme default')
equal(hl('Normal'), {fg = 0xffffff, bg = 0x181b1a})
apply(vim.NIL)
equal(hl('Normal'), default_normal)
equal(hl('Comment'), default_comment)
assert(vim.o.termguicolors == false)
-- Disabling removes the callbacks; future colorscheme changes remain native.
vim.cmd('colorscheme default')
equal(hl('Normal'), default_normal)
assert(_G.paseo_neovim_theme == nil)
`;
    const command = `lua local ok, err = pcall(assert(loadstring(${JSON.stringify(script)}))); if not ok then vim.api.nvim_err_writeln(tostring(err)); vim.cmd('cquit 1') else vim.cmd('qa!') end`;
    execFileSync(executable, ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-c", command], {
      encoding: "utf8",
      timeout: 10000,
    });
  });
});
