// Independent editor processes must not race Neovim's unlink + exclusive-create
// persistent undo writes. The stable Paseo session ID also survives an editor restart.
export const UNDO_LUA = `
local session_id = ...
local state = _G.paseo_neovim_undo
if state then
  if state.session_id ~= session_id then error('This Neovim process belongs to another Paseo session.') end
  return state.directory
end
local directory = vim.fn.stdpath('state') .. '/paseo/undo/' .. session_id
vim.fn.mkdir(directory, 'p', 448)
if vim.fn.isdirectory(directory) ~= 1 or vim.fn.filewritable(directory) ~= 2 then
  error('Persistent undo directory is not writable: ' .. directory)
end
local original = vim.o.undodir
vim.opt.undodir = {directory}
-- Preserve the undo trees of files already restored by the user's startup config.
-- No file buffers are written, reloaded, or marked unmodified here.
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == ''
    and vim.bo[buf].undofile and vim.api.nvim_buf_get_name(buf) ~= '' then
    vim.api.nvim_buf_call(buf, function()
      vim.api.nvim_cmd({
        cmd = 'wundo', bang = true, magic = {file = false},
        args = {vim.fn.undofile(vim.api.nvim_buf_get_name(buf))},
      }, {})
    end)
  end
end
_G.paseo_neovim_undo = {session_id = session_id, directory = directory, original = original}
return directory
`;
