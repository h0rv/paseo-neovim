import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Sessions } from "./server/sessions";
import {
  allocateRpc,
  conflictsRpc,
  openDiffRpc,
  openRpc,
  stopRpc,
  watchRpc,
} from "./shared/session";
import { preferences } from "./shared/settings";
import { themeRpc } from "./shared/theme";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const sessions = new Sessions(async () => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Neovim settings are invalid: ${state.error}`);
    return state.values;
  });
  server.handle(allocateRpc, () => sessions.allocate());
  server.handle(openRpc, (input, { paseo }) => sessions.open(input, paseo));
  server.handle(openDiffRpc, (input, { paseo }) => sessions.openDiff(input, paseo));
  server.handle(conflictsRpc, ({ workspaceId }, { paseo }) =>
    sessions.conflicts(workspaceId, paseo),
  );
  server.handle(watchRpc, ({ sessionId, revision }) => sessions.watch(sessionId, revision));
  server.handle(stopRpc, ({ sessionId }) => sessions.stop(sessionId));
  server.handle(themeRpc, ({ sessionId, highlights }) => sessions.theme(sessionId, highlights));
  return () => sessions.dispose();
}
