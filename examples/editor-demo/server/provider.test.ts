import {
  ProviderEventSchema,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
} from "@getpaseo/plugin/server/provider";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditorDemoProvider } from "./provider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(persist = false) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "paseo-editor-provider-test-")));
  const connection = await createEditorDemoProvider().connect({
    versions: [1],
    capabilities: ["prompt.message", "prompt.steer", "session.persistence"],
  });
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => {
    ProviderEventSchema.parse(event);
    events.push(event);
  });
  cleanups.push(async () => {
    await connection.close();
    rmSync(cwd, { recursive: true, force: true });
  });
  await sendUntil(
    connection,
    {
      type: "session.open",
      requestId: "open",
      sessionId: "demo",
      config: { cwd, env: {}, mcpServers: {}, settings: {}, persist },
      history: "skip",
    },
    (event) => event.type === "session.ready",
  );
  return { cwd, connection, events };
}

async function sendUntil(
  connection: ProviderConnection,
  input: ProviderInput,
  match: (event: ProviderEvent) => boolean,
): Promise<ProviderEvent> {
  const { promise: received, resolve } = Promise.withResolvers<ProviderEvent>();
  const unsubscribe = connection.onEvent((event) => {
    if (match(event)) {
      unsubscribe();
      resolve(event);
    }
  });
  try {
    await connection.send(input);
    return await received;
  } finally {
    unsubscribe();
  }
}

function message(
  text: string,
  clientMessageId = text,
): Extract<ProviderInput, { type: "session.prompt" }> {
  return {
    type: "session.prompt",
    sessionId: "demo",
    prompt: {
      clientMessageId,
      delivery: "auto",
      input: { type: "message", content: [{ type: "text", text }] },
    },
  };
}

function terminal(event: ProviderEvent) {
  return event.type === "session.turn" && event.state !== "started";
}

describe("Editor demo provider", () => {
  it("offers one credential-free model, real tools and line-anchored links", async () => {
    const { connection, cwd, events } = await harness();
    expect(connection.capabilities).toEqual(["prompt.message", "session.persistence"]);
    const catalog = await sendUntil(
      connection,
      { type: "catalog", requestId: "catalog" },
      (event) => event.type === "catalog",
    );
    expect(catalog).toMatchObject({
      catalog: {
        models: [{ id: "files", label: "File editing demo" }],
        modes: [],
        thinkingOptions: [],
      },
    });
    await sendUntil(connection, message("anything can begin the demo", "first"), terminal);
    const tools = events.flatMap((event) =>
      event.type === "timeline.item" &&
      event.item.type === "tool_call" &&
      event.item.status === "completed"
        ? [event.item]
        : [],
    );
    expect(tools).toHaveLength(2);
    for (const item of tools) {
      expect(item.detail.type).toBe("write");
      if (item.detail.type !== "write") throw new Error("Expected a write detail");
      expect(readFileSync(item.detail.filePath, "utf8")).toBe(item.detail.content);
    }
    const assistant = events.find(
      (event) => event.type === "timeline.item" && event.item.type === "assistant_message",
    );
    expect(assistant).toMatchObject({ item: { text: expect.stringContaining("greeting.ts#L2") } });
    expect(
      events.filter(
        (event) => event.type === "session.prompt_result" && event.clientMessageId === "first",
      ),
    ).toHaveLength(1);
    await sendUntil(connection, message("edit"), terminal);
    expect(readFileSync(join(cwd, "paseo-editor-demo", "greeting.ts"), "utf8")).toContain(
      "revision 2",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          status: "completed",
          detail: expect.objectContaining({
            type: "edit",
            oldString: expect.stringContaining("revision 1"),
            newString: expect.stringContaining("revision 2"),
          }),
        }),
      }),
    );
  });

  it("replays real completed history on a new connection and continues the files", async () => {
    const { connection, cwd, events } = await harness(true);
    await sendUntil(connection, message("create", "original-create"), terminal);
    const saved = events.findLast(
      (event): event is Extract<ProviderEvent, { type: "session.persistence" }> =>
        event.type === "session.persistence",
    )?.persistence;
    expect(saved).toBeDefined();
    if (!saved) throw new Error("Editor demo did not publish persistence");
    await connection.close();

    const restored = await createEditorDemoProvider().connect({
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    cleanups.unshift(() => restored.close());
    const replay: ProviderEvent[] = [];
    restored.onEvent((event) => {
      ProviderEventSchema.parse(event);
      replay.push(event);
    });
    await sendUntil(
      restored,
      {
        type: "session.open",
        requestId: "restore",
        sessionId: "demo",
        config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
        persistence: JSON.parse(JSON.stringify(saved)),
        history: "replay",
      },
      (event) => event.type === "session.ready",
    );
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        restoration: "core",
        persistence: saved,
      }),
    );
    expect(
      replay.flatMap((event) => (event.type === "timeline.item" ? [event.item] : [])),
    ).toMatchObject([
      { type: "user_message", text: "create", clientMessageId: "original-create" },
      { type: "tool_call", status: "completed", detail: { type: "write" } },
      { type: "tool_call", status: "completed", detail: { type: "write" } },
      { type: "assistant_message", text: expect.stringContaining("revision 1") },
    ]);
    expect(readFileSync(join(cwd, "paseo-editor-demo", "greeting.ts"), "utf8")).toContain(
      "revision 1",
    );
    await sendUntil(restored, message("edit", "restored-edit"), terminal);
    expect(readFileSync(join(cwd, "paseo-editor-demo", "greeting.ts"), "utf8")).toContain(
      "revision 2",
    );
    expect(replay).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "tool_call",
          status: "completed",
          detail: expect.objectContaining({
            type: "edit",
            oldString: expect.stringContaining("revision 1"),
            newString: expect.stringContaining("revision 2"),
          }),
        }),
      }),
    );
  });

  it.each(["version", "workspace", "data", "history"] as const)(
    "rejects invalid restoration %s instead of opening a fresh session",
    async (invalid) => {
      const { connection, cwd, events } = await harness();
      const data = { id: "saved-session", cwd, history: [] };
      const saved: ProviderPersistence = { version: 1, data };
      if (invalid === "version") saved.version = 2;
      if (invalid === "workspace") data.cwd = `${cwd}-another-workspace`;
      if (invalid === "data") saved.data = null;
      if (invalid === "history") saved.data = { ...data, history: "not a timeline" };
      const result = await sendUntil(
        connection,
        {
          type: "session.open",
          requestId: "invalid-restore",
          sessionId: "invalid",
          config: { cwd, env: {}, mcpServers: {}, settings: {}, persist: true },
          persistence: saved,
          history: "replay",
        },
        (event) => event.type === "request.failed",
      );
      expect(result).toMatchObject({
        requestId: "invalid-restore",
        error: { message: expect.stringContaining("Invalid Editor demo persistence") },
      });
      expect(
        events.some((event) => event.type === "session.opened" && event.sessionId === "invalid"),
      ).toBe(false);
    },
  );

  it("honors persistence opt-out", async () => {
    const { connection, events } = await harness();
    await sendUntil(connection, message("create"), terminal);
    expect(
      events.some(
        (event) =>
          event.type === "session.persistence" ||
          (event.type === "session.opened" && event.persistence !== undefined),
      ),
    ).toBe(false);
  });

  it("surfaces refusal without successful write tools", async () => {
    const { connection, cwd, events } = await harness();
    await sendUntil(connection, message("create"), terminal);
    const path = join(cwd, "paseo-editor-demo", "main.ts");
    writeFileSync(path, "my work\n");
    events.length = 0;
    const result = await sendUntil(connection, message("edit"), terminal);
    expect(result).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("manual edits") },
    });
    expect(readFileSync(path, "utf8")).toBe("my work\n");
    expect(
      events.some(
        (event) =>
          event.type === "timeline.item" &&
          event.item.type === "tool_call" &&
          event.item.status === "completed",
      ),
    ).toBe(false);
    expect(
      events.some((event) => event.type === "timeline.item" && event.item.type === "error"),
    ).toBe(true);
  });

  it("cancels an admitted turn and acknowledges interrupt and session close", async () => {
    const { connection, events } = await harness();
    await connection.send(message("create"));
    await sendUntil(
      connection,
      { type: "session.interrupt", requestId: "stop", sessionId: "demo" },
      (event) => event.type === "request.completed" && event.requestId === "stop",
    );
    expect(events.filter((event) => event.type === "session.turn")).toEqual([
      expect.objectContaining({ state: "started" }),
      expect.objectContaining({ state: "canceled" }),
    ]);
    expect(
      events.some((event) => event.type === "timeline.item" && event.item.type === "tool_call"),
    ).toBe(false);
    await sendUntil(
      connection,
      { type: "session.close", requestId: "close", sessionId: "demo" },
      (event) => event.type === "request.completed" && event.requestId === "close",
    );
    expect(events).toContainEqual({ type: "session.closed", sessionId: "demo" });
  });

  it("closes an active connection without leaving work running and rejects later sends", async () => {
    const { connection, events } = await harness();
    await connection.send(message("create"));
    await connection.close();
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.turn", state: "canceled" }),
    );
    expect(events).toContainEqual({ type: "session.closed", sessionId: "demo" });
    await expect(connection.send({ type: "catalog", requestId: "closed" })).rejects.toThrow(
      "connection is closed",
    );
  });

  it("acknowledges unsupported prompt capabilities with a failed prompt result", async () => {
    const { connection } = await harness();
    const input = message("edit", "steer");
    input.prompt.delivery = "steer";
    const result = await sendUntil(
      connection,
      input,
      (event) => event.type === "session.prompt_result",
    );
    expect(result).toMatchObject({ clientMessageId: "steer", result: { type: "failed" } });
  });
});
