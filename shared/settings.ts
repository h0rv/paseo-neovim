import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "tools",
  scope: "host",
  version: 1,
  schema: z.object({
    useForDiffs: z.boolean().default(false),
    useForMergeConflicts: z.boolean().default(false),
    followPaseoTheme: z.boolean().default(false),
    neovimExecutable: z.string().default("nvim"),
    initFile: z.string().default(""),
    extraArguments: z.string().default(""),
    gitExecutable: z.string().default("git"),
  }),
});

export type NeovimSettings = z.infer<typeof preferences.schema>;
