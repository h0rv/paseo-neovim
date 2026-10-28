import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../shared/session";
import { preferences } from "../shared/settings";
import { themeHighlights, themeRpc } from "../shared/theme";

export function useNeovimTheme(theme: PluginTheme, snapshot: Snapshot | null) {
  const settings = useSettings(preferences);
  const apply = useRpc(themeRpc);
  const [error, setError] = useState<string | null>(null);
  const enabled = settings.status === "ready" ? settings.values.followPaseoTheme : undefined;
  const sessionId = snapshot?.session.sessionId;
  const terminalId = snapshot?.session.terminalId;
  const status = snapshot?.status;
  const palette = useMemo(() => {
    try {
      return { highlights: enabled ? themeHighlights(theme) : null, error: null };
    } catch (cause) {
      return { highlights: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [enabled, theme]);

  // This effect never navigates a buffer or creates/connects a process. Every ready
  // transition (including reconnect) reapplies the current setting to the same editor.
  useEffect(() => {
    if (!sessionId || status !== "ready" || enabled === undefined || palette.error) return;
    let cancelled = false;
    setError(null);
    const currentSessionId = sessionId;
    async function updateTheme() {
      try {
        await apply({ sessionId: currentSessionId, highlights: palette.highlights });
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    void updateTheme();
    return () => {
      cancelled = true;
    };
  }, [sessionId, terminalId, status, enabled, palette, apply]);

  return { followsPaseoAppearance: enabled === true, error: palette.error ?? error };
}
