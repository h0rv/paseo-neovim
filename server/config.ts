import { homedir } from "node:os";
import path from "node:path";
import type { NeovimSettings } from "../shared/settings";

export interface LaunchConfig {
  command: string;
  args: string[];
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function executablePath(value: string, fallback: string, cwd: string): string {
  const executable = expandHome(value || fallback);
  // Bare executable names use the daemon's PATH; paths are workspace-relative.
  return executable.includes("/") || (process.platform === "win32" && executable.includes("\\"))
    ? path.resolve(cwd, executable)
    : executable;
}

export function launchConfig(
  settings: NeovimSettings,
  cwd: string,
  socketPath: string,
): LaunchConfig {
  const extra = settings.extraArguments.split(/\r?\n/).filter((argument) => argument.length > 0);
  for (const argument of extra) {
    if (/^--(?:embed|headless|listen)(?:=|$)/.test(argument)) {
      throw new Error(
        `Neovim extra argument ${JSON.stringify(argument)} is not supported: Paseo manages --listen and requires an interactive terminal (no --embed or --headless).`,
      );
    }
  }
  const args = ["--listen", socketPath];
  if (settings.initFile) args.push("-u", path.resolve(cwd, expandHome(settings.initFile)));
  args.push(...extra);
  return { command: executablePath(settings.neovimExecutable, "nvim", cwd), args };
}
