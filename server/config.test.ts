import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NeovimSettings } from "../shared/settings";
import { launchConfig } from "./config";

const settings: NeovimSettings = {
  neovimExecutable: "tools/nvim custom",
  initFile: "config/my init.lua",
  extraArguments: "--cmd\nlet g:sample = 'a b'\r\n\n-n",
  gitExecutable: "git",
  useForDiffs: false,
  useForMergeConflicts: false,
  followPaseoTheme: false,
};

describe("Neovim launch configuration", () => {
  it("preserves spaces and each literal argument while resolving workspace paths", () => {
    const cwd = path.resolve("test-workspace");
    const launch = launchConfig(settings, cwd, "private-rpc-socket");
    expect(launch.command).toBe(path.join(cwd, "tools/nvim custom"));
    expect(launch.args).toEqual([
      "--listen",
      "private-rpc-socket",
      "-u",
      path.join(cwd, "config/my init.lua"),
      "--cmd",
      "let g:sample = 'a b'",
      "-n",
    ]);
  });

  it("refuses an argument that redirects the RPC listener", () => {
    expect(() =>
      launchConfig(
        { ...settings, extraArguments: "--listen=other-socket" },
        path.resolve("test-workspace"),
        "private-rpc-socket",
      ),
    ).toThrow(/Paseo manages --listen/);
  });
});
