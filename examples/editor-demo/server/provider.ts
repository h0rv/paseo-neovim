import {
  ProviderEventSchema,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEMO_DIRECTORY, updateDemoFiles, type DemoChange } from "./files.js";

const CAPABILITIES = ["prompt.message", "session.persistence"] as const;
const MODELS = [{ id: "files", label: "File editing demo" }];

interface Turn {
  id: string;
  canceled: boolean;
  done: Promise<void>;
}

type HistoryItem = Pick<Extract<ProviderEvent, { type: "timeline.item" }>, "item" | "timestamp">;

interface DemoSession {
  id: string;
  cwd: string;
  closing: boolean;
  persist: boolean;
  history: HistoryItem[];
  active?: Turn;
}

class DemoCanceled extends Error {}

export function createEditorDemoProvider(): ProviderRegistration {
  return {
    id: "editor-demo",
    label: "Editor demo",
    description:
      "No model or credentials: create writes two safe TypeScript demo files; edit changes them. Other text creates on first use and edits thereafter, not arbitrary coding requests.",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1))
        throw new Error("Editor demo requires provider protocol version 1");
      return createConnection(negotiateProviderCapabilities(request.capabilities, CAPABILITIES));
    },
  };
}

function createConnection(capabilities: readonly string[]): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, DemoSession>();
  const pending = new Set<Promise<void>>();
  let closing = false;
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (!closed) for (const listener of listeners) listener(event);
  };
  const failRequest = (input: ProviderInput, error: unknown) => {
    const failure = { message: error instanceof Error ? error.message : String(error) };
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: failure },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: failure });
    }
  };

  function openSession(input: Extract<ProviderInput, { type: "session.open" }>): void {
    if (sessions.has(input.sessionId))
      throw new Error(`Editor demo session already exists: ${input.sessionId}`);
    if (input.config.model && input.config.model !== "files")
      throw new Error(`Unknown Editor demo model: ${input.config.model}`);
    if (
      input.config.mode ||
      input.config.thinkingOption ||
      Object.keys(input.config.settings).length
    ) {
      throw new Error("Editor demo has no modes, thinking options, or session settings");
    }
    const cwd = resolve(input.config.cwd);
    const session: DemoSession = {
      ...(input.persistence
        ? restoreSession(input.persistence, cwd, input.sessionId)
        : { id: randomUUID(), history: [] }),
      cwd,
      closing: false,
      persist: input.config.persist && capabilities.includes("session.persistence"),
    };
    sessions.set(input.sessionId, session);
    emit({
      type: "session.opened",
      requestId: input.requestId,
      sessionId: input.sessionId,
      capabilities,
      restoration: "core",
      persistence: session.persist ? persistence(session) : undefined,
      cwd: session.cwd,
      title: input.config.title,
    });
    emit({
      type: "session.config",
      sessionId: input.sessionId,
      config: { model: "files", models: MODELS, modes: [], thinkingOptions: [], settings: [] },
    });
    if (input.history === "replay") {
      for (const item of session.history)
        emit({ type: "timeline.item", sessionId: input.sessionId, ...item });
    }
    emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
  }

  function startTurn(
    input: Extract<ProviderInput, { type: "session.prompt" }>,
    session: DemoSession,
  ): void {
    if (session.active)
      throw new Error("Editor demo is already editing; wait for the turn or interrupt it");
    if (
      input.prompt.input.type !== "message" ||
      input.prompt.input.content.some((part) => part.type !== "text")
    ) {
      throw new Error(
        "Editor demo accepts text messages only; use create or edit, without attachments",
      );
    }
    const text = input.prompt.input.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    const action = text.trim().toLowerCase();
    const turn: Turn = { id: randomUUID(), canceled: false, done: Promise.resolve() };
    session.active = turn;
    turn.done = Promise.resolve().then(() =>
      runTurn(
        input,
        session,
        turn,
        text,
        action === "create" || action === "edit" ? action : "auto",
      ),
    );
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    try {
      if (closing) throw new Error("Editor demo connection is closing");
      requireProviderCapabilities(capabilities, input);
      if (input.type === "catalog") {
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: { models: MODELS, defaultModel: "files", modes: [], thinkingOptions: [] },
        });
        return;
      }
      if (input.type === "session.open") {
        openSession(input);
        return;
      }
      if (!("sessionId" in input))
        throw new Error(`Unsupported Editor demo request: ${input.type}`);
      const session = sessions.get(input.sessionId);
      if (!session) throw new Error(`Unknown Editor demo session: ${input.sessionId}`);
      if (session.closing) throw new Error(`Editor demo session is closing: ${input.sessionId}`);
      if (input.type === "session.prompt") {
        startTurn(input, session);
        return;
      }
      if (input.type === "session.interrupt" || input.type === "session.close") {
        if (input.type === "session.close") session.closing = true;
        if (session.active) {
          session.active.canceled = true;
          await session.active.done;
        }
        if (input.type === "session.close") {
          sessions.delete(input.sessionId);
          emit({ type: "session.closed", sessionId: input.sessionId });
        }
        emit({ type: "request.completed", requestId: input.requestId });
        return;
      }
      throw new Error(`Unsupported Editor demo request: ${input.type}`);
    } catch (error) {
      failRequest(input, error);
    }
  }

  async function runTurn(
    input: Extract<ProviderInput, { type: "session.prompt" }>,
    session: DemoSession,
    turn: Turn,
    text: string,
    action: "create" | "edit" | "auto",
  ): Promise<void> {
    const sessionId = input.sessionId;
    const timeline = (item: ProviderTimelineItem) => {
      const previous = session.history.find((entry) => entry.item.id === item.id);
      const entry = { item, timestamp: previous?.timestamp ?? new Date().toISOString() };
      if (previous) previous.item = item;
      else session.history.push(entry);
      emit({ type: "timeline.item", sessionId, ...entry });
    };
    const finish = (state: "completed" | "failed" | "canceled", error?: { message: string }) => {
      if (session.persist)
        emit({ type: "session.persistence", sessionId, persistence: persistence(session) });
      emit({
        type: "session.turn",
        sessionId,
        turnId: turn.id,
        state,
        ...(error ? { error } : {}),
      });
    };
    const assertActive = () => {
      if (turn.canceled || closing || session.closing)
        throw new DemoCanceled("Editor demo was interrupted");
    };
    const tools = new Map<DemoChange, Extract<ProviderTimelineItem, { type: "tool_call" }>>();
    timeline({
      type: "user_message",
      id: `user:${turn.id}`,
      text,
      clientMessageId: input.prompt.clientMessageId,
    });
    emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    emit({ type: "session.turn", sessionId, turnId: turn.id, state: "started" });
    try {
      assertActive();
      // Real asynchronous filesystem work also leaves admission/interrupt events a delivery boundary.
      await realpath(session.cwd);
      assertActive();
      const result = updateDemoFiles(session.cwd, action, {
        assertActive,
        started(change) {
          const id = `file:${randomUUID()}`;
          const item: Extract<ProviderTimelineItem, { type: "tool_call" }> = {
            type: "tool_call",
            id,
            callId: id,
            name: change.before === null ? "Create demo file" : "Edit demo file",
            detail:
              change.before === null
                ? { type: "write", filePath: change.filePath, content: change.after }
                : {
                    type: "edit",
                    filePath: change.filePath,
                    oldString: change.before,
                    newString: change.after,
                  },
            status: "running",
            error: null,
          };
          tools.set(change, item);
          timeline(item);
        },
        completed(change) {
          const item = tools.get(change)!;
          timeline({ ...item, status: "completed", error: null });
        },
        failed(change, error) {
          const item = tools.get(change)!;
          timeline(
            error instanceof DemoCanceled
              ? { ...item, status: "canceled", error: null }
              : {
                  ...item,
                  status: "failed",
                  error: { message: error instanceof Error ? error.message : String(error) },
                },
          );
        },
      });
      const links = result.files
        .map((file) => `- [${DEMO_DIRECTORY}/${basename(file)}:2](${pathToFileURL(file).href}#L2)`)
        .join("\n");
      timeline({
        type: "assistant_message",
        id: `assistant:${turn.id}`,
        text: `${result.changes ? `Wrote ${result.changes} demo files (revision ${result.revision}).` : "The recognized demo files already exist; create left them unchanged."}\n\n${links}\n\nOpen a link to inspect the real file. Send **edit** for the next deterministic version, or **create** to ensure the files exist without resetting them. This demo does not interpret arbitrary coding requests.`,
      });
      finish("completed");
    } catch (error) {
      if (error instanceof DemoCanceled) {
        finish("canceled");
      } else {
        const failure = {
          message: `Editor demo failed in ${session.cwd}: ${error instanceof Error ? error.message : String(error)}. Earlier completed file operations, if any, remain on disk.`,
        };
        timeline({ type: "error", id: `error:${turn.id}`, message: failure.message });
        finish("failed", failure);
      }
    } finally {
      if (session.active === turn) session.active = undefined;
    }
  }

  return {
    version: 1,
    capabilities,
    async send(input) {
      if (closing || closed) throw new Error("Editor demo connection is closed");
      const job = Promise.resolve().then(() => dispatch(input));
      pending.add(job);
      void job.finally(() => pending.delete(job));
    },
    onEvent(listener) {
      if (closing || closed) throw new Error("Editor demo connection is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closing = true;
      await Promise.all(pending);
      for (const session of sessions.values()) if (session.active) session.active.canceled = true;
      await Promise.all([...sessions.values()].map((session) => session.active?.done));
      for (const sessionId of sessions.keys()) emit({ type: "session.closed", sessionId });
      sessions.clear();
      closed = true;
      listeners.clear();
    },
  };
}

function persistence(session: DemoSession): ProviderPersistence {
  return {
    version: 1,
    data: JSON.parse(
      JSON.stringify({ id: session.id, cwd: session.cwd, history: session.history }),
    ),
  };
}

function restoreSession(
  handle: ProviderPersistence,
  cwd: string,
  sessionId: string,
): Pick<DemoSession, "id" | "history"> {
  const data = handle.data;
  if (
    handle.version !== 1 ||
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof data.id !== "string" ||
    data.id.length === 0 ||
    data.cwd !== cwd ||
    !Array.isArray(data.history)
  ) {
    throw new Error("Invalid Editor demo persistence: expected version 1 for this workspace");
  }
  const history = data.history.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error("Invalid Editor demo persisted history");
    const event = ProviderEventSchema.parse({
      type: "timeline.item",
      sessionId,
      item: entry.item,
      timestamp: entry.timestamp,
    });
    if (event.type !== "timeline.item") throw new Error("Invalid Editor demo persisted history");
    return { item: event.item, timestamp: event.timestamp };
  });
  return { id: data.id, history };
}
