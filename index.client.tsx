import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NeovimPanel } from "./client/neovim-panel";
import { NeovimDiffPanel } from "./client/neovim-diff-panel";
import { NeovimSettings } from "./client/neovim-settings";

export default function contribute(client: PluginClientContext) {
  client.addFilePanel({
    id: "neovim",
    title: "Neovim",
    icon: "Terminal",
    files: { kind: "text" },
    supportsLineNavigation: true,
    Component: NeovimPanel,
  });
  client.addDiffPanel({
    id: "neovim-diff",
    title: "Neovim",
    Component: NeovimDiffPanel,
  });
  client.addSettingsScreen({
    id: "tools",
    title: "Neovim",
    icon: "Terminal",
    Component: NeovimSettings,
  });
  return () => {};
}
