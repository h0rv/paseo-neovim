import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createEditorDemoProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createEditorDemoProvider());
  return () => {};
}
