import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { NeovimClient } from "neovim/lib/api/client";
import { createLogger, transports } from "winston";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { DiffRequest, Session, Snapshot } from "../shared/session";
import type { NeovimSettings } from "../shared/settings";
import type { Highlights } from "../shared/theme";
import { executablePath, launchConfig } from "./config";
import { conflictPaths, DIFF_LUA, fileDiffRequest, loadDiff } from "./diffs";
import { THEME_LUA } from "./theme";
import { UNDO_LUA } from "./undo";

type Paseo = PluginHandlerContext["paseo"];
interface RecordState {
  attempted: boolean;
  terminalId: string | null;
  workspaceId: string | null;
  cwd: string | null;
}
interface Entry {
  snapshot: Snapshot;
  record: RecordState;
  client: NeovimClient | null;
  socket: Socket | null;
  waiters: Set<() => void>;
  pending: Promise<unknown>;
}

// macOS's per-user TMPDIR is too long for sockaddr_un. The parent is private to the daemon user.
const root = path.join(
  process.platform === "darwin" ? "/tmp" : tmpdir(),
  `paseo-nvim-${process.getuid?.() ?? "user"}`,
);
const TIMEOUT_MS = 8000;
// Supplying a logger avoids node-client's default logger replacing global console methods.
const logger = createLogger({ level: "warn", transports: [new transports.Console()] });
const OBSERVE_LUA = `
local channel = ...
if not _G.paseo_neovim_attached then
  _G.paseo_neovim_attached = true
  local buf = vim.api.nvim_get_current_buf()
  if #vim.api.nvim_list_tabpages() == 1 and #vim.api.nvim_tabpage_list_wins(0) == 1
    and vim.api.nvim_buf_get_name(buf) == '' and vim.bo[buf].buftype == '' and not vim.bo[buf].modified
    and vim.api.nvim_buf_line_count(buf) == 1 and vim.api.nvim_buf_get_lines(buf, 0, -1, false)[1] == '' then
    _G.paseo_neovim_initial_tab = {tab = vim.api.nvim_get_current_tabpage(), win = vim.api.nvim_get_current_win(), buf = buf, changedtick = vim.api.nvim_buf_get_changedtick(buf)}
  end
end
local function native_diff(mode, merge)
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].modified then
    vim.api.nvim_err_writeln('Paseo: save this buffer before opening a Git comparison.')
    return
  end
  local filename = vim.b[buf].paseo_git_path or vim.api.nvim_buf_get_name(buf)
  if filename == '' or (vim.bo[buf].buftype ~= '' and not vim.b[buf].paseo_git_path) then
    vim.api.nvim_err_writeln('Paseo: open a repository file before requesting a Git comparison.')
    return
  end
  vim.rpcnotify(channel, 'paseo_neovim_diff', filename, mode, merge, vim.b[buf].paseo_base_ref or vim.g.paseo_base_ref or '')
end
local commands = vim.api.nvim_get_commands({})
if not commands.PaseoDiff or _G.paseo_neovim_commands then
  vim.api.nvim_create_user_command('PaseoDiff', function(opts)
    local mode = opts.args == '' and 'uncommitted' or opts.args
    if not vim.tbl_contains({'uncommitted', 'index', 'all', 'base'}, mode) then
      vim.api.nvim_err_writeln('Usage: PaseoDiff [uncommitted|index|all|base]')
      return
    end
    native_diff(mode, false)
  end, {nargs = '?', complete = function() return {'uncommitted', 'index', 'all', 'base'} end, desc = 'Open a native Paseo Git comparison'})
  _G.paseo_neovim_commands = true
end
if not commands.PaseoMerge or _G.paseo_neovim_merge_command then
  vim.api.nvim_create_user_command('PaseoMerge', function() native_diff('uncommitted', true) end,
    {desc = 'Open native Paseo conflict resolution'})
  _G.paseo_neovim_merge_command = true
end
local function modified()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].modified then return true end
  end
  return false
end
local group = vim.api.nvim_create_augroup('PaseoNeovimStatus', { clear = true })
vim.api.nvim_create_autocmd({'TextChanged', 'TextChangedI', 'TextChangedP', 'BufWritePost', 'BufEnter', 'BufDelete', 'BufWipeout'}, {
  group = group,
  callback = function()
    vim.schedule(function() pcall(vim.rpcnotify, channel, 'paseo_neovim_status', modified()) end)
  end,
})
vim.api.nvim_create_autocmd('VimLeavePre', {
  group = group,
  callback = function() pcall(vim.rpcnotify, channel, 'paseo_neovim_exit', modified()) end,
})
return modified()
`;
const OPEN_LUA = `
local filename, line = ...
local tab = vim.api.nvim_get_current_tabpage()
for _, item in pairs(_G.paseo_neovim_diff_tabs or {}) do
  if item.tab == tab then
    local win = _G.paseo_neovim_file_window
    if win and vim.api.nvim_win_is_valid(win) and vim.api.nvim_win_get_tabpage(win) ~= tab then
      vim.api.nvim_set_current_win(win)
    else
      vim.api.nvim_cmd({cmd = 'tabnew'}, {})
    end
    break
  end
end
_G.paseo_neovim_file_window = vim.api.nvim_get_current_win()
local buf = vim.fn.bufadd(filename)
vim.fn.bufload(buf)
vim.bo[buf].buflisted = true
-- :hide preserves the previous buffer even when the user's 'hidden' option is off.
-- The only Ex argument is a numeric buffer handle, never a filename or injected command.
if vim.api.nvim_get_current_buf() ~= buf then
  vim.api.nvim_cmd({cmd = 'buffer', args = {tostring(buf)}, mods = {hide = true}}, {})
end
if line > 0 then
  local count = vim.api.nvim_buf_line_count(buf)
  vim.api.nvim_win_set_cursor(0, {math.min(line, math.max(1, count)), 0})
end
return true
`;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  // The plugin loader targets Node 20, which does not provide Promise.withResolvers.
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
    promise.then(
      (result) => {
        clearTimeout(timer);
        return resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class Sessions {
  private entries = new Map<string, Entry>();
  private loading = new Map<string, Promise<Entry>>();
  private disposed = false;

  constructor(private readonly readSettings: () => Promise<NeovimSettings>) {}

  private socketPath(id: string): string {
    return process.platform === "win32"
      ? `\\\\.\\pipe\\paseo-neovim-${id}`
      : path.join(root, id, "rpc");
  }
  private async save(id: string, record: RecordState): Promise<void> {
    const filename = path.join(root, id, "session.json");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, filename);
  }
  async allocate(): Promise<Session> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(root, 0o700);
    const sessionId = randomUUID();
    await mkdir(path.join(root, sessionId), { mode: 0o700 });
    await this.save(sessionId, {
      attempted: false,
      terminalId: null,
      workspaceId: null,
      cwd: null,
    });
    return { sessionId, socketPath: this.socketPath(sessionId), terminalId: null };
  }
  private async entry(session: Session): Promise<Entry> {
    if (session.socketPath !== this.socketPath(session.sessionId))
      throw new Error("Invalid Neovim session socket. Restore this tab's original state.");
    const existing = this.entries.get(session.sessionId);
    if (existing) return existing;
    const loading = this.loading.get(session.sessionId);
    if (loading) return loading;
    const pending = (async () => {
      const raw: unknown = JSON.parse(
        await readFile(path.join(root, session.sessionId, "session.json"), "utf8"),
      );
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("attempted" in raw) ||
        typeof raw.attempted !== "boolean" ||
        !("terminalId" in raw) ||
        !(raw.terminalId === null || typeof raw.terminalId === "string") ||
        !("workspaceId" in raw) ||
        !(raw.workspaceId === null || typeof raw.workspaceId === "string") ||
        !("cwd" in raw) ||
        !(raw.cwd === null || typeof raw.cwd === "string")
      )
        throw new Error("Invalid Neovim session record.");
      const record: RecordState = {
        attempted: raw.attempted,
        terminalId: raw.terminalId,
        workspaceId: raw.workspaceId,
        cwd: raw.cwd,
      };
      const entry: Entry = {
        record,
        snapshot: {
          session: { ...session, terminalId: record.terminalId },
          cwd: record.cwd ?? "",
          revision: Date.now(),
          status: "disconnected",
          modified: null,
          error: null,
        },
        client: null,
        socket: null,
        waiters: new Set(),
        pending: Promise.resolve(),
      };
      this.entries.set(session.sessionId, entry);
      return entry;
    })();
    this.loading.set(session.sessionId, pending);
    try {
      return await pending;
    } finally {
      this.loading.delete(session.sessionId);
    }
  }
  private update(entry: Entry, changes: Partial<Snapshot>): void {
    entry.snapshot = {
      ...entry.snapshot,
      ...changes,
      revision: Math.max(Date.now(), entry.snapshot.revision + 1),
    };
    for (const notify of entry.waiters) notify();
    entry.waiters.clear();
  }
  private async connect(entry: Entry, paseo: Paseo): Promise<NeovimClient> {
    if (entry.client && entry.socket && !entry.socket.destroyed) return entry.client;
    const deadline = Date.now() + TIMEOUT_MS;
    let lastError = "Neovim did not open its RPC socket.";
    while (!this.disposed && Date.now() < deadline) {
      const socket = createConnection(entry.snapshot.session.socketPath);
      try {
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          }),
          "Timed out connecting to Neovim.",
        );
        if (this.disposed) {
          socket.destroy();
          throw new Error("The plugin was stopped.");
        }
        entry.socket = socket;
        const client = new NeovimClient({ logger });
        // End the decoder cleanly even when the socket closes without a FIN. The node client
        // does not catch async-iterator errors from a prematurely destroyed socket.
        const reader = new PassThrough();
        socket.pipe(reader);
        socket.once("close", () => reader.end());
        client.attach({ reader, writer: socket });
        entry.client = client;
        socket.on("close", () => {
          if (entry.socket !== socket || this.disposed) return;
          entry.socket = null;
          entry.client = null;
          this.update(entry, {
            status: "disconnected",
            error:
              "Neovim RPC disconnected. Retry to reconnect; the terminal and buffers have not been killed.",
          });
          void paseo.terminals
            .list({ workspaceId: entry.record.workspaceId ?? undefined })
            .then(({ entries }) => {
              if (
                !entry.socket &&
                !entries.some((terminal) => terminal.id === entry.snapshot.session.terminalId)
              ) {
                this.update(entry, {
                  status: "exited",
                  error:
                    "Neovim has exited. Restart to open a new process. Unsaved buffers from the exited process can only be recovered through Neovim's swap recovery.",
                });
              }
              return null;
            })
            .catch(() => {});
        });
        client.on("notification", (method: string, args: unknown[]) => {
          if (method === "paseo_neovim_status" && typeof args[0] === "boolean")
            this.update(entry, { modified: args[0] });
          if (method === "paseo_neovim_exit")
            this.update(entry, {
              status: "exited",
              modified: typeof args[0] === "boolean" ? args[0] : entry.snapshot.modified,
              error: "Neovim has exited. Restart to open a new process.",
            });
          if (method === "paseo_neovim_diff") {
            void this.nativeDiff(entry, paseo, args).catch(async (error) => {
              const message = `Paseo: ${error instanceof Error ? error.message : String(error)}`;
              await withTimeout(
                client.request("nvim_err_writeln", [message]),
                "Neovim could not display the comparison error.",
              ).catch(() => {});
            });
          }
        });
        const channel = await withTimeout(
          client.channelId,
          "Neovim RPC did not become ready. Check its terminal for a startup prompt.",
        );
        await withTimeout(
          client.request("nvim_exec_lua", [UNDO_LUA, [entry.snapshot.session.sessionId]]),
          "Neovim is busy. Retry to initialize persistent undo storage.",
        );
        const modified = await withTimeout(
          client.request("nvim_exec_lua", [OBSERVE_LUA, [channel]]),
          "Neovim is busy. Check its terminal, then retry.",
        );
        if (process.platform !== "win32") await chmod(entry.snapshot.session.socketPath, 0o600);
        this.update(entry, { status: "ready", modified: modified === true, error: null });
        return client;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (entry.socket === socket) {
          entry.socket = null;
          entry.client = null;
        }
        socket.destroy();
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(
      `${lastError} Check the configured Neovim executable on the daemon host and inspect the terminal for configuration/startup errors.`,
    );
  }
  async theme(sessionId: string, highlights: Highlights | null): Promise<{ applied: boolean }> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("Reconnect to Neovim before changing its theme.");
    const pending = entry.pending
      .catch(() => {})
      .then(async () => {
        if (this.disposed || entry.snapshot.status !== "ready" || !entry.client)
          throw new Error("Reconnect to Neovim before changing its theme.");
        const applied = await withTimeout(
          entry.client.request("nvim_exec_lua", [THEME_LUA, [highlights]]),
          "Neovim is busy. Change Follow Paseo theme in plugin settings to retry.",
        );
        return { applied: applied === true };
      });
    entry.pending = pending;
    return pending;
  }
  async conflicts(workspaceId: string, paseo: Paseo): Promise<string[]> {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh();
    if (!workspace?.workspaceDirectory) throw new Error("The workspace directory is unavailable.");
    const settings = await this.readSettings();
    return conflictPaths(
      workspace.workspaceDirectory,
      executablePath(settings.gitExecutable, "git", workspace.workspaceDirectory),
    );
  }
  private async nativeDiff(entry: Entry, paseo: Paseo, args: unknown[]): Promise<void> {
    const [filename, mode, merge, baseRef] = args;
    if (
      typeof filename !== "string" ||
      !path.isAbsolute(filename) ||
      !["uncommitted", "index", "all", "base"].includes(String(mode)) ||
      typeof merge !== "boolean" ||
      typeof baseRef !== "string"
    )
      throw new Error("Invalid native Git comparison request.");
    if (!entry.record.workspaceId || !entry.record.cwd)
      throw new Error("This Neovim session has no workspace.");
    const settings = await this.readSettings();
    const request = await fileDiffRequest(
      entry.record.cwd,
      filename,
      mode as "uncommitted" | "index" | "all" | "base",
      merge,
      executablePath(settings.gitExecutable, "git", entry.record.cwd),
      baseRef || undefined,
    );
    const snapshot = await this.openDiff(
      { ...request, session: entry.snapshot.session, workspaceId: entry.record.workspaceId },
      paseo,
    );
    if (snapshot.error) throw new Error(snapshot.error);
  }
  async openDiff(
    input: DiffRequest & { session: Session; workspaceId: string; restart?: boolean },
    paseo: Paseo,
  ): Promise<Snapshot> {
    return this.open(
      {
        session: input.session,
        workspaceId: input.workspaceId,
        path: input.file.path,
        restart: input.restart,
      },
      paseo,
      input,
    );
  }
  async open(
    input: {
      session: Session;
      workspaceId: string;
      path: string;
      line?: number;
      restart?: boolean;
    },
    paseo: Paseo,
    diff?: DiffRequest,
  ): Promise<Snapshot> {
    const entry = await this.entry(input.session);
    const pending = entry.pending
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error("The plugin was stopped.");
        if (entry.record.workspaceId && entry.record.workspaceId !== input.workspaceId)
          throw new Error("This Neovim session belongs to another workspace.");
        const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
        const cwd = workspace?.workspaceDirectory;
        if (!cwd) throw new Error("The workspace directory is unavailable.");
        const filename = path.resolve(cwd, input.path);
        // Validate and load Git snapshots before starting a process; unsupported files fail explicitly.
        const settings = diff ? await this.readSettings() : null;
        const layout =
          diff && settings
            ? await loadDiff(cwd, diff, executablePath(settings.gitExecutable, "git", cwd))
            : null;
        const marker = `[paseo-nvim:${input.session.sessionId}]`;
        const { entries } = await paseo.terminals.list({ workspaceId: input.workspaceId });
        let terminal = entries.find(
          (candidate) =>
            candidate.id === entry.record.terminalId || candidate.name.endsWith(marker),
        );
        if (input.restart) {
          // Never kill a live process to repair RPC: it might own unsaved buffers.
          if (terminal || (entry.socket && !entry.socket.destroyed))
            throw new Error(
              "This Neovim session is still running. Reconnect, or use :qa in Neovim before restarting. Restart never kills a live editor.",
            );
          entry.record.attempted = false;
          if (process.platform !== "win32")
            await unlink(entry.snapshot.session.socketPath).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              },
            );
        }
        if (!terminal && entry.record.attempted) {
          this.update(entry, {
            status: "exited",
            error:
              "Neovim is no longer running, or its startup was interrupted. Install nvim on the daemon host if necessary, then Restart. Existing live terminals are never replaced automatically.",
          });
          return entry.snapshot;
        }
        if (!terminal) {
          const config = launchConfig(await this.readSettings(), cwd, input.session.socketPath);
          entry.record = { attempted: true, terminalId: null, workspaceId: input.workspaceId, cwd };
          await this.save(input.session.sessionId, entry.record);
          const handle = await paseo.terminals.create({
            workspaceId: input.workspaceId,
            cwd,
            ...config,
            presentation: "embedded",
            name: `Neovim · ${path.basename(filename)} ${marker}`,
          });
          terminal = handle.current() ?? {
            id: handle.id,
            workspaceId: input.workspaceId,
            cwd,
            name: marker,
          };
        }
        entry.record = {
          attempted: true,
          terminalId: terminal.id,
          workspaceId: input.workspaceId,
          cwd,
        };
        await this.save(input.session.sessionId, entry.record);
        this.update(entry, { session: { ...input.session, terminalId: terminal.id }, cwd });
        const client = await this.connect(entry, paseo);
        if (layout) {
          await withTimeout(
            client.request("nvim_exec_lua", [DIFF_LUA, [layout]]),
            "Neovim is busy. Check its terminal, then retry opening the diff.",
          );
        } else {
          await withTimeout(
            client.request("nvim_exec_lua", [OPEN_LUA, [filename, input.line ?? 0]]),
            "Neovim is busy. Check its terminal, then retry opening the file.",
          );
        }
        this.update(entry, { error: null });
        return entry.snapshot;
      })
      .catch((error) => {
        this.update(entry, { error: error instanceof Error ? error.message : String(error) });
        return entry.snapshot;
      });
    entry.pending = pending;
    return pending;
  }
  async watch(sessionId: string, revision: number): Promise<Snapshot> {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("Neovim session is not connected. Retry to reconnect.");
    if (entry.snapshot.revision !== revision || this.disposed) return entry.snapshot;
    let notify!: () => void;
    let timer: NodeJS.Timeout | undefined;
    try {
      await new Promise<void>((resolve) => {
        notify = resolve;
        entry.waiters.add(notify);
        timer = setTimeout(notify, 15000);
      });
    } finally {
      clearTimeout(timer);
      entry.waiters.delete(notify);
    }
    return entry.snapshot;
  }
  async stop(sessionId: string): Promise<{ stopped: boolean }> {
    const entry = this.entries.get(sessionId);
    if (!entry?.client)
      throw new Error("Reconnect to Neovim before stopping it, or use :qa in the terminal.");
    const stopped = await withTimeout(
      entry.client.request("nvim_exec_lua", [
        `
for _, buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].modified then return false end
end
vim.schedule(function() vim.cmd('qa') end)
return true
`,
        [],
      ]),
      "Neovim is busy. Use :qa in its terminal.",
    );
    if (stopped !== true)
      throw new Error(
        "Neovim has unsaved buffers. Save them or explicitly discard them inside Neovim before stopping.",
      );
    return { stopped: true };
  }
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      for (const notify of entry.waiters) notify();
      entry.waiters.clear();
      // Destroy only our RPC connection. The daemon owns the PTY and persistent Neovim process.
      entry.socket?.destroy();
      entry.socket = null;
      entry.client = null;
    }
  }
}
