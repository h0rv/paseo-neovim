import { type PluginFilePanelProps, useRpc } from "@getpaseo/plugin/client";
import { Loading, TerminalView } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import {
  allocateRpc,
  openDiffRpc,
  openRpc,
  sessionSchema,
  watchRpc,
  type DiffRequest,
  type Session,
  type Snapshot,
} from "../shared/session";
import { useNeovimTheme } from "./use-neovim-theme";

interface NeovimTerminalProps extends Pick<
  PluginFilePanelProps,
  "workspaceId" | "revision" | "tab" | "theme"
> {
  request: { kind: "file"; path: string; line?: number } | { kind: "diff"; value: DiffRequest };
}

interface ThemedStyles {
  panel: ViewStyle;
  bar: ViewStyle;
  label: TextStyle;
  action: TextStyle;
  notice: TextStyle;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
  },
});

function useThemedStyles(theme: NeovimTerminalProps["theme"]): ThemedStyles {
  return useMemo(
    () => ({
      panel: { ...styles.fill, backgroundColor: theme.colors.surface0 },
      bar: { ...styles.bar, borderBottomColor: theme.colors.border },
      label: { flex: 1, color: theme.colors.foregroundMuted },
      action: { color: theme.colors.accent },
      notice: { color: theme.colors.foregroundMuted, padding: 12 },
    }),
    [theme],
  );
}

export function NeovimPanel({ workspaceId, params, revision, tab, theme }: PluginFilePanelProps) {
  const request = useMemo(
    () => ({ kind: "file" as const, path: params.path, line: params.lineStart }),
    [params.path, params.lineStart],
  );
  return (
    <NeovimTerminal
      workspaceId={workspaceId}
      request={request}
      revision={revision}
      tab={tab}
      theme={theme}
    />
  );
}

function isStaleSnapshot(previous: Snapshot | null, next: Snapshot) {
  return (
    previous?.session.sessionId === next.session.sessionId && previous.revision > next.revision
  );
}

function useNeovimSession({ workspaceId, request, revision, tab }: NeovimTerminalProps) {
  const allocate = useRpc(allocateRpc);
  const open = useRpc(openRpc);
  const openDiff = useRpc(openDiffRpc);
  const watch = useRpc(watchRpc);
  const parsed = useMemo(() => sessionSchema.safeParse(tab.state), [tab.state]);
  const session = parsed.success ? parsed.data : null;
  const sessionId = session?.sessionId;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const restartRequested = useRef(false);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const snapshotSessionId = snapshot?.session.sessionId;
  const snapshotStatus = snapshot?.status;
  const setTabState = tab.setState;
  const setModified = tab.setModified;

  const receive = useCallback(
    (next: Snapshot) => {
      if (
        next.session.sessionId !== sessionRef.current?.sessionId ||
        isStaleSnapshot(snapshotRef.current, next)
      )
        return;
      snapshotRef.current = next;
      setSnapshot(next);
      // Only a real Neovim observation may clear the host's unsaved indicator.
      if (next.modified !== null) setModified(next.modified);
    },
    [setModified],
  );

  const navigate = useCallback(
    (current: Session, restartProcess: boolean) => {
      if (request.kind === "diff")
        return openDiff({
          ...request.value,
          session: current,
          workspaceId,
          restart: restartProcess,
        });
      return open({
        session: current,
        workspaceId,
        path: request.path,
        line: request.line,
        restart: restartProcess,
      });
    },
    [request, open, openDiff, workspaceId],
  );

  useEffect(() => {
    if (sessionId) return;
    let cancelled = false;
    setError(null);
    async function allocateSession() {
      try {
        const allocated = await allocate({});
        if (!cancelled) setTabState(allocated);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    void allocateSession();
    return () => {
      cancelled = true;
    };
  }, [allocate, sessionId, setTabState, attempt]);

  // Persist identity before process creation. RPC retries and remounts reuse it; the daemon
  // serializes creation and records the terminal ID.
  useEffect(() => {
    const current = sessionRef.current;
    if (!sessionId || !current) return;
    const navigationSession = current;
    const shouldRestart = restartRequested.current;
    restartRequested.current = false;
    let cancelled = false;
    setBusy(true);
    setError(null);
    async function navigateSession() {
      try {
        const next = await navigate(navigationSession, shouldRestart);
        // Persist terminal creation after eviction, but never overwrite a newer session/result.
        if (
          sessionRef.current?.sessionId === sessionId &&
          !isStaleSnapshot(snapshotRef.current, next)
        )
          setTabState(next.session);
        if (!cancelled) receive(next);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void navigateSession();
    return () => {
      cancelled = true;
    };
    // terminalId enrichment updates the ref without becoming a navigation dependency.
  }, [navigate, sessionId, revision, attempt, receive, setTabState]);

  useEffect(() => {
    if (!sessionId || snapshotSessionId !== sessionId || snapshotStatus !== "ready") return;
    const watchedSessionId = sessionId;
    let cancelled = false;
    async function watchSession() {
      try {
        let current = snapshotRef.current;
        while (
          current &&
          current.session.sessionId === watchedSessionId &&
          current.status === "ready"
        ) {
          // Long-poll waits for autocmd notifications or socket exit. Timeouts do not query
          // Neovim, and unmounted panels never start another watch request.
          const next = await watch({ sessionId: watchedSessionId, revision: current.revision });
          if (cancelled) return;
          receive(next);
          current = snapshotRef.current;
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    void watchSession();
    return () => {
      cancelled = true;
    };
  }, [watch, sessionId, snapshotSessionId, snapshotStatus, receive, attempt]);

  const retry = useCallback(() => {
    restartRequested.current = false;
    setAttempt((current) => current + 1);
  }, []);
  const restart = useCallback(() => {
    restartRequested.current = true;
    setAttempt((current) => current + 1);
  }, []);
  return { session, snapshot, error, busy, retry, restart };
}

function TerminalContent({
  session,
  snapshot,
  busy,
  failure,
  themedStyles,
  followsPaseoAppearance,
}: {
  session: Session | null;
  snapshot: Snapshot | null;
  busy: boolean;
  failure: string | null;
  themedStyles: ThemedStyles;
  followsPaseoAppearance: boolean;
}) {
  const terminalId = snapshot?.session.terminalId ?? session?.terminalId;
  if (terminalId && snapshot?.cwd && snapshot.status !== "exited") {
    return (
      <View style={styles.fill}>
        <TerminalView
          terminalId={terminalId}
          cwd={snapshot.cwd}
          appearance={followsPaseoAppearance ? "editor" : "terminal"}
        />
      </View>
    );
  }
  if (busy || (!session && !failure)) return <Loading />;
  return (
    <Text style={themedStyles.notice}>
      Reconnect to the existing editor. If it has exited, start a new session. Live buffers are
      never replaced automatically.
    </Text>
  );
}

export function NeovimTerminal(props: NeovimTerminalProps) {
  const { session, snapshot, error, busy, retry, restart } = useNeovimSession(props);
  const themedStyles = useThemedStyles(props.theme);
  const { followsPaseoAppearance, error: themeError } = useNeovimTheme(props.theme, snapshot);
  const failure = error ?? themeError ?? snapshot?.error ?? null;
  return (
    <View style={themedStyles.panel}>
      {failure || snapshot?.status === "exited" ? (
        <View style={themedStyles.bar}>
          <Text accessibilityRole="alert" style={themedStyles.label}>
            {failure ?? "Neovim has exited."}
          </Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={retry}>
            <Text style={themedStyles.action}>{busy ? "Connecting…" : "Reconnect"}</Text>
          </Pressable>
          {snapshot?.status === "exited" ? (
            <Pressable accessibilityRole="button" disabled={busy} onPress={restart}>
              <Text style={themedStyles.action}>Start Neovim</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <TerminalContent
        session={session}
        snapshot={snapshot}
        busy={busy}
        failure={failure}
        themedStyles={themedStyles}
        followsPaseoAppearance={followsPaseoAppearance}
      />
    </View>
  );
}
