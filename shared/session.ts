import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const sessionSchema = z.object({
  sessionId: z.uuid(),
  socketPath: z.string().min(1),
  terminalId: z.string().nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const snapshotSchema = z.object({
  session: sessionSchema,
  cwd: z.string(),
  revision: z.number().int(),
  status: z.enum(["ready", "disconnected", "exited"]),
  modified: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const allocateRpc = defineRpc({
  name: "allocate",
  input: z.object({}),
  output: sessionSchema,
});
export const openRpc = defineRpc({
  name: "open",
  input: z.object({
    session: sessionSchema,
    workspaceId: z.string(),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    restart: z.boolean().optional(),
  }),
  output: snapshotSchema,
});
export const watchRpc = defineRpc({
  name: "watch",
  input: z.object({ sessionId: z.uuid(), revision: z.number().int() }),
  output: snapshotSchema,
});
export const stopRpc = defineRpc({
  name: "stop",
  input: z.object({ sessionId: z.uuid() }),
  output: z.object({ stopped: z.boolean() }),
});

export const diffRequestSchema = z.object({
  comparison: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("working"),
      mode: z.enum(["uncommitted", "base", "all", "index"]),
      baseRef: z.string().min(1).optional(),
    }),
    z.object({ kind: z.literal("commit"), sha: z.string().min(1) }),
  ]),
  file: z.object({
    path: z.string().min(1),
    oldPath: z.string().optional(),
    isNew: z.boolean(),
    isDeleted: z.boolean(),
    status: z.enum(["ok", "too_large", "binary"]).optional(),
  }),
  merge: z.boolean(),
});
export type DiffRequest = z.infer<typeof diffRequestSchema>;

export const openDiffRpc = defineRpc({
  name: "open-diff",
  input: diffRequestSchema.extend({
    session: sessionSchema,
    workspaceId: z.string(),
    restart: z.boolean().optional(),
  }),
  output: snapshotSchema,
});

export const conflictsRpc = defineRpc({
  name: "conflicts",
  input: z.object({ workspaceId: z.string() }),
  output: z.array(z.string()),
});
