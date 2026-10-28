// Kept in the native process so reconnecting or reloading the plugin does not lose
// the user's original links, highlight attributes, or true-color option.
export const THEME_LUA = `
local highlights = ...
local state = _G.paseo_neovim_theme
if not highlights or highlights == vim.NIL then
  if state then
    vim.api.nvim_del_augroup_by_id(state.group)
    state.restore()
    _G.paseo_neovim_theme = nil
    vim.cmd('redraw')
  end
  return false
end
if not state then
  state = {highlights = highlights}
  _G.paseo_neovim_theme = state
  function state.restore()
    if not state.original then return end
    for name, value in pairs(state.original) do vim.api.nvim_set_hl(0, name, value) end
    vim.o.termguicolors = state.termguicolors
    state.original = nil
  end
  function state.apply()
    if not state.original then
      state.original = {}
      state.termguicolors = vim.o.termguicolors
    end
    for name, value in pairs(state.highlights) do
      if state.original[name] == nil then
        state.original[name] = vim.api.nvim_get_hl(0, {name = name, link = true})
      end
      vim.api.nvim_set_hl(0, name, value)
    end
    vim.o.termguicolors = true
  end
  state.group = vim.api.nvim_create_augroup('PaseoNeovimTheme', {clear = true})
  -- Remove our overlay before the user's next colorscheme loads. Snapshot that
  -- scheme afterwards, so disabling follows the user's latest choice, not the old one.
  vim.api.nvim_create_autocmd('ColorSchemePre', {group = state.group, callback = state.restore})
  vim.api.nvim_create_autocmd('ColorScheme', {group = state.group, callback = state.apply})
else
  state.restore()
  state.highlights = highlights
end
state.apply()
vim.cmd('redraw')
return true
`;
