import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffRequest } from "../shared/session";

const execute = promisify(execFile);
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

interface DiffBuffer {
  label: string;
  filename: string | null;
  lines: string[];
  endofline: boolean;
}
interface DiffLayout {
  key: string;
  path: string;
  filename: string;
  buffers: DiffBuffer[];
}
interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

type Git = (cwd: string, args: string[]) => Promise<Buffer>;

function createGit(executable: string): Git {
  return async (cwd, args) => {
    const { stdout } = await execute(executable, args, {
      cwd,
      shell: false,
      encoding: "buffer",
      maxBuffer: MAX_SNAPSHOT_BYTES + 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return stdout;
  };
}

function relativeFile(filename: string): string {
  if (path.isAbsolute(filename) || filename.includes("\0"))
    throw new Error("Unsupported absolute or NUL-containing Git path.");
  const normalized = path.posix.normalize(filename);
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".")
    throw new Error("Git path escapes the repository.");
  return filename;
}

function textBuffer(bytes: Buffer, label: string): DiffBuffer {
  if (bytes.length > MAX_SNAPSHOT_BYTES)
    throw new Error(`${label}: snapshot exceeds the 8 MiB Neovim diff limit.`);
  if (bytes.includes(0))
    throw new Error(`${label}: binary snapshots are not supported by the Neovim diff integration.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${label}: only UTF-8 text snapshots are supported by the Neovim diff integration.`,
    );
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const endofline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (endofline) lines.pop();
  return { label, filename: null, lines, endofline };
}

function emptyBuffer(label: string): DiffBuffer {
  return textBuffer(Buffer.alloc(0), label);
}

async function commit(git: Git, cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]))
    .toString("utf8")
    .trim();
}

async function headCommit(git: Git, cwd: string): Promise<string | null> {
  try {
    return (
      await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"])
    )
      .toString("utf8")
      .trim();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === 1) return null;
    throw cause;
  }
}

async function blobBuffer(git: Git, cwd: string, oid: string, label: string): Promise<DiffBuffer> {
  const size = Number((await git(cwd, ["cat-file", "-s", oid])).toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size < 0)
    throw new Error(`${label}: Git returned an invalid snapshot size.`);
  if (size > MAX_SNAPSHOT_BYTES)
    throw new Error(`${label}: snapshot exceeds the 8 MiB Neovim diff limit.`);
  return textBuffer(await git(cwd, ["cat-file", "blob", oid]), label);
}

async function treeBuffer(
  git: Git,
  cwd: string,
  ref: string | null,
  filename: string,
  label: string,
): Promise<DiffBuffer> {
  if (ref === null) return emptyBuffer(`${label} (absent)`);
  const output = (
    await git(cwd, ["--literal-pathspecs", "ls-tree", "-z", ref, "--", filename])
  ).toString("utf8");
  const record = output
    .split("\0")
    .find((candidate) => candidate.slice(candidate.indexOf("\t") + 1) === filename);
  if (!record) return emptyBuffer(`${label} (absent)`);
  const match = /^(\d+) (\w+) ([a-f0-9]+)\t/.exec(record);
  if (!match || match[2] !== "blob" || !/^100(644|755)$/.test(match[1]!))
    throw new Error(
      `${filename}: symlinks, submodules, and non-regular Git snapshots are not supported.`,
    );
  return blobBuffer(git, cwd, match[3]!, label);
}

async function indexEntries(git: Git, cwd: string, filename: string | null): Promise<IndexEntry[]> {
  const args = ["ls-files", "--stage", "-z"];
  if (filename === null) args.push("--unmerged");
  else args.push("--", `:(literal)${filename}`);
  const output = (await git(cwd, args)).toString("utf8");
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("Git returned an unsupported index entry.");
      return { mode: match[1]!, oid: match[2]!, stage: Number(match[3]), path: match[4]! };
    });
}

export async function conflictPaths(cwd: string, gitExecutable: string): Promise<string[]> {
  const git = createGit(gitExecutable);
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
  const entries = await indexEntries(git, root, null);
  return [...new Set(entries.map((entry) => entry.path))];
}

async function indexBuffer(
  git: Git,
  cwd: string,
  entries: IndexEntry[],
  stage: number,
  label: string,
): Promise<DiffBuffer> {
  const entry = entries.find((candidate) => candidate.stage === stage);
  if (!entry) return emptyBuffer(`${label} (absent)`);
  if (!/^100(644|755)$/.test(entry.mode))
    throw new Error(`${entry.path}: symlinks and submodules are not supported in Neovim diffs.`);
  return blobBuffer(git, cwd, entry.oid, label);
}

async function workingBuffer(
  cwd: string,
  filename: string,
  missing: "readonly" | "editable" = "readonly",
): Promise<DiffBuffer> {
  const absolute = path.resolve(cwd, filename);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new Error("Working-tree path escapes the repository.");
  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      const buffer = emptyBuffer("WORKTREE (deleted)");
      if (missing === "readonly") return buffer;
      const parent = await realpath(path.dirname(absolute));
      const parentRelative = path.relative(cwd, parent);
      if (
        parentRelative === ".." ||
        parentRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(parentRelative)
      )
        throw new Error(`${filename}: merged path escapes the repository.`, { cause });
      return { ...buffer, label: "MERGED (new, editable)", filename: absolute };
    }
    throw cause;
  }
  if (!metadata.isFile())
    throw new Error(`${filename}: only regular working-tree files are supported in Neovim diffs.`);
  const resolved = await realpath(absolute);
  const resolvedRelative = path.relative(cwd, resolved);
  if (resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative))
    throw new Error(`${filename}: symlinked paths outside the repository are not supported.`);
  if (metadata.size > MAX_SNAPSHOT_BYTES)
    throw new Error(`${filename}: working-tree file exceeds the 8 MiB Neovim diff limit.`);
  const buffer = textBuffer(await readFile(absolute), "WORKTREE / MERGED (editable)");
  // Content is checked for support here, but only Neovim reads/writes the actual file.
  return { ...buffer, filename: absolute, lines: [] };
}

async function comparisonBase(git: Git, cwd: string, baseRef: string | undefined): Promise<string> {
  if (!baseRef)
    throw new Error(
      "Paseo has no base branch for this comparison. Select a base branch before opening Neovim.",
    );
  let candidate = baseRef;
  if (!baseRef.startsWith("refs/heads/") && !baseRef.startsWith("refs/remotes/")) {
    const localName = baseRef.replace(/^origin\//, "");
    const refs = (
      await git(cwd, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${localName}`,
        `refs/remotes/origin/${localName}`,
      ])
    )
      .toString("utf8")
      .split("\n");
    if (refs.includes(`refs/remotes/origin/${localName}`))
      candidate = `refs/remotes/origin/${localName}`;
    else if (refs.includes(`refs/heads/${localName}`)) candidate = `refs/heads/${localName}`;
    else throw new Error(`Base branch not found locally or on origin: ${baseRef}`);
  }
  const resolved = await commit(git, cwd, candidate);
  try {
    return (await git(cwd, ["merge-base", resolved, "HEAD"])).toString("utf8").trim();
  } catch (cause) {
    // Like Paseo's built-in diff, unrelated histories compare against the base ref itself.
    if (cause instanceof Error && "code" in cause && cause.code === 1) return resolved;
    throw cause;
  }
}

export async function fileDiffRequest(
  cwd: string,
  filename: string,
  mode: "uncommitted" | "index" | "all" | "base",
  merge: boolean,
  gitExecutable: string,
  baseRef?: string,
): Promise<DiffRequest> {
  const git = createGit(gitExecutable);
  const root = await realpath(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim(),
  );
  const relative = path.relative(root, filename).split(path.sep).join("/");
  relativeFile(relative);
  if ((mode === "all" || mode === "base") && !baseRef) {
    try {
      baseRef = (await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]))
        .toString("utf8")
        .trim();
    } catch {
      throw new Error(
        "No comparison base is configured. Set :let b:paseo_base_ref = 'your-branch', or configure origin/HEAD with Git.",
      );
    }
  }
  return {
    comparison: { kind: "working", mode, baseRef },
    file: { path: relative, isNew: false, isDeleted: false },
    merge,
  };
}

export async function loadDiff(
  cwd: string,
  request: DiffRequest,
  gitExecutable: string,
): Promise<DiffLayout> {
  const git = createGit(gitExecutable);
  const root = await realpath(
    (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim(),
  );
  const filename = relativeFile(request.file.path);
  const oldPath = relativeFile(request.file.oldPath ?? filename);
  if (request.file.status === "binary")
    throw new Error(`${filename}: binary files cannot be opened by the Neovim diff integration.`);
  const comparison = request.comparison;
  const entries = comparison.kind === "working" ? await indexEntries(git, root, filename) : [];
  const unmerged = entries.some((entry) => entry.stage !== 0);
  let buffers: DiffBuffer[];
  let mode: string;
  if (request.merge) {
    if (comparison.kind !== "working" || !unmerged)
      throw new Error(
        `${filename}: this file no longer has unresolved index stages. Refresh the changes view.`,
      );
    buffers = await Promise.all([
      indexBuffer(git, root, entries, 1, "BASE (stage 1)"),
      indexBuffer(git, root, entries, 2, "LOCAL (stage 2)"),
      indexBuffer(git, root, entries, 3, "REMOTE (stage 3)"),
      workingBuffer(root, filename, "editable"),
    ]);
    mode = "merge";
  } else if (comparison.kind === "commit") {
    const sha = await commit(git, root, comparison.sha);
    const ancestry = (await git(root, ["rev-list", "--parents", "-n", "1", sha]))
      .toString("utf8")
      .trim()
      .split(/\s+/);
    buffers = await Promise.all([
      treeBuffer(git, root, ancestry[1] ?? null, oldPath, "PARENT"),
      treeBuffer(git, root, sha, filename, sha.slice(0, 12)),
    ]);
    mode = `commit:${sha}`;
  } else if (comparison.mode === "index") {
    if (unmerged)
      throw new Error(
        `${filename}: the index has unresolved stages. Enable Neovim merge conflicts and choose Resolve conflict.`,
      );
    buffers = await Promise.all([
      indexBuffer(git, root, entries, 0, "INDEX"),
      workingBuffer(root, filename),
    ]);
    mode = "index";
  } else {
    const head = await headCommit(git, root);
    if (head === null && comparison.mode !== "uncommitted")
      throw new Error("This comparison requires a HEAD commit. Commit the initial tree first.");
    const base =
      comparison.mode === "uncommitted"
        ? head
        : await comparisonBase(git, root, comparison.baseRef);
    const right =
      comparison.mode === "base"
        ? treeBuffer(git, root, head, filename, "HEAD")
        : workingBuffer(root, filename);
    buffers = await Promise.all([
      treeBuffer(
        git,
        root,
        base,
        oldPath,
        comparison.mode === "uncommitted" ? "HEAD" : "MERGE BASE",
      ),
      right,
    ]);
    mode = comparison.mode;
  }
  return {
    key: JSON.stringify([
      mode,
      comparison.kind === "working" ? comparison.baseRef : null,
      filename,
    ]),
    path: filename,
    filename: path.resolve(root, filename),
    buffers,
  };
}

export const DIFF_LUA = `
local layout = ...
_G.paseo_neovim_diff_tabs = _G.paseo_neovim_diff_tabs or {}
local tabs = _G.paseo_neovim_diff_tabs
local function owned_tab(item)
  if not item or not item.windows or not item.buffers or not vim.api.nvim_tabpage_is_valid(item.tab) then return false end
  if #vim.api.nvim_tabpage_list_wins(item.tab) ~= #item.windows then return false end
  for i, win in ipairs(item.windows) do
    if not vim.api.nvim_win_is_valid(win) or vim.api.nvim_win_get_tabpage(win) ~= item.tab
      or vim.api.nvim_win_get_buf(win) ~= item.buffers[i] or not vim.wo[win].diff then return false end
  end
  return true
end
local function balance(item)
  if not owned_tab(item) then return end
  vim.api.nvim_win_call(item.windows[1], function()
    local fixed = {}
    for _, win in ipairs(item.windows) do
      fixed[win] = vim.wo[win].winfixwidth
      vim.wo[win].winfixwidth = false
    end
    vim.api.nvim_cmd({cmd = 'wincmd', args = {'='}}, {})
    for win, value in pairs(fixed) do
      if vim.api.nvim_win_is_valid(win) then vim.wo[win].winfixwidth = value end
    end
  end)
end
local group = vim.api.nvim_create_augroup('PaseoNeovimDiffLayout', {clear = true})
vim.api.nvim_create_autocmd('VimResized', {
  group = group,
  callback = function()
    vim.schedule(function()
      for _, item in pairs(tabs) do pcall(balance, item) end
    end)
  end,
})
local function pristine(buf)
  return vim.api.nvim_buf_is_valid(buf) and vim.api.nvim_buf_get_name(buf) == ''
    and vim.bo[buf].buftype == '' and not vim.bo[buf].modified
    and vim.api.nvim_buf_line_count(buf) == 1 and vim.api.nvim_buf_get_lines(buf, 0, -1, false)[1] == ''
end
local function cleanup()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(buf) and vim.b[buf].paseo_git_snapshot
      and not vim.bo[buf].modified and #vim.fn.win_findbuf(buf) == 0 then
      pcall(vim.api.nvim_buf_delete, buf, {force = false})
    end
  end
end
local function update_snapshot(buf, source)
  -- A user may deliberately unlock a scratch buffer. Never replace their edits.
  if vim.bo[buf].modified then return end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, source.lines)
  vim.bo[buf].endofline = source.endofline
  vim.bo[buf].modified = false
  vim.bo[buf].readonly = true
  vim.bo[buf].modifiable = false
end
local function same_sources(item)
  if not item.sources or #item.windows ~= #layout.buffers then return false end
  for i, source in ipairs(layout.buffers) do
    if item.sources[i] ~= source.filename then return false end
  end
  return true
end
local existing
for key, item in pairs(tabs) do
  if not vim.api.nvim_tabpage_is_valid(item.tab) then tabs[key] = nil
  else
    if not item.path then
      local ok, decoded = pcall(vim.json.decode, key)
      if ok and type(decoded) == 'table' then item.path = decoded[#decoded] end
    end
    if item.path == layout.path and owned_tab(item) then
      local same = item.key == layout.key and same_sources(item)
      local modified = false
      for _, buf in ipairs(item.buffers) do if vim.bo[buf].modified then modified = true end end
      if same or not modified then
        existing = item
        if same then break end
      end
    end
  end
end
if existing and existing.key == layout.key and same_sources(existing) then
  vim.api.nvim_set_current_tabpage(existing.tab)
  for i, source in ipairs(layout.buffers) do
    local buf = existing.buffers[i]
    if source.filename == vim.NIL then update_snapshot(buf, source)
    elseif not vim.bo[buf].modified then
      vim.api.nvim_buf_call(buf, function() vim.api.nvim_cmd({cmd = 'checktime'}, {}) end)
    end
  end
  vim.api.nvim_set_current_win(existing.windows[#existing.windows])
  vim.api.nvim_cmd({cmd = 'diffupdate'}, {})
  balance(existing)
  cleanup()
  return true
end
local temporary
if existing then
  vim.api.nvim_set_current_tabpage(existing.tab)
  vim.api.nvim_set_current_win(existing.windows[1])
  for i = #existing.windows, 2, -1 do vim.api.nvim_win_close(existing.windows[i], false) end
  vim.api.nvim_cmd({cmd = 'diffoff'}, {})
else
  local initial = _G.paseo_neovim_initial_tab
  if initial and vim.api.nvim_tabpage_is_valid(initial.tab) and vim.api.nvim_win_is_valid(initial.win)
    and #vim.api.nvim_tabpage_list_wins(initial.tab) == 1
    and vim.api.nvim_win_get_buf(initial.win) == initial.buf and pristine(initial.buf)
    and vim.api.nvim_buf_get_changedtick(initial.buf) == initial.changedtick then
    vim.api.nvim_set_current_tabpage(initial.tab)
    temporary = initial.buf
  else
    vim.api.nvim_cmd({cmd = 'tabnew'}, {})
    temporary = vim.api.nvim_get_current_buf()
  end
  _G.paseo_neovim_initial_tab = nil
end
local item = {tab = vim.api.nvim_get_current_tabpage(), path = layout.path, key = layout.key, windows = {}, buffers = {}, sources = {}}
for i, source in ipairs(layout.buffers) do
  if i > 1 then vim.api.nvim_cmd({cmd = 'vsplit', mods = {split = 'botright'}}, {}) end
  local buf
  if source.filename ~= vim.NIL then
    buf = vim.fn.bufadd(source.filename)
    vim.fn.bufload(buf)
    vim.bo[buf].buflisted = true
  else
    buf = vim.api.nvim_create_buf(false, true)
    vim.bo[buf].buftype = 'nofile'
    vim.bo[buf].bufhidden = 'hide'
    vim.bo[buf].swapfile = false
    vim.api.nvim_buf_set_name(buf, 'paseo-git://' .. tostring(buf) .. '/' .. layout.path)
    vim.b[buf].paseo_git_snapshot = true
    vim.b[buf].paseo_git_path = layout.filename
    vim.b[buf].paseo_git_source = source.label
    update_snapshot(buf, source)
    local filetype = vim.filetype.match({filename = layout.path, buf = buf})
    if filetype then vim.bo[buf].filetype = filetype end
  end
  vim.api.nvim_win_set_buf(0, buf)
  vim.wo.winbar = source.label:gsub('%%', '%%%%')
  vim.api.nvim_cmd({cmd = 'diffthis'}, {})
  item.windows[i] = vim.api.nvim_get_current_win()
  item.buffers[i] = buf
  item.sources[i] = source.filename
end
if existing then
  for key, value in pairs(tabs) do if value == existing then tabs[key] = nil end end
end
tabs[tostring(item.tab)] = item
balance(item)
cleanup()
if temporary and pristine(temporary) and #vim.fn.win_findbuf(temporary) == 0 then
  pcall(vim.api.nvim_buf_delete, temporary, {force = false})
end
return true
`;
