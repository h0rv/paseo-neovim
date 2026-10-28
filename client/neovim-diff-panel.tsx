import { useRpc, useSettings, type PluginDiffPanelProps } from "@getpaseo/plugin/client";
import { Loading, Select, SettingsAction } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { conflictsRpc, type DiffRequest } from "../shared/session";
import { preferences } from "../shared/settings";
import { NeovimTerminal } from "./neovim-panel";

type ConflictState =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; paths: string[] }
  | { key: string; status: "error"; error: string };
type DiffParams = PluginDiffPanelProps["params"];
type DiffFile = DiffParams["files"][number];
type Comparison = "paseo" | "index";
interface EditorRequest {
  kind: "diff";
  value: DiffRequest;
}

interface DiffSelection {
  selectedPath: string | undefined;
  selectedFile: DiffFile | undefined;
  openedConflict: string | null;
  setOpenedConflict: (path: string | null) => void;
  selectFile: (path: string) => void;
  selectConflict: (path: string) => void;
}

interface ThemedStyles {
  panel: ViewStyle;
  toolbar: ViewStyle;
  empty: TextStyle;
  merge: TextStyle;
  action: TextStyle;
  error: TextStyle;
}

interface DiffToolsProps extends PluginDiffPanelProps {
  useForDiffs: boolean;
  useForMergeConflicts: boolean;
}

const EMPTY_PATHS: readonly string[] = [];
const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: 1,
  },
});

function useThemedStyles(theme: PluginDiffPanelProps["theme"]): ThemedStyles {
  return useMemo(
    () => ({
      panel: { ...styles.fill, backgroundColor: theme.colors.surface0 },
      toolbar: { ...styles.toolbar, borderBottomColor: theme.colors.border },
      empty: { color: theme.colors.foregroundMuted, padding: 12 },
      merge: { color: theme.colors.foregroundMuted, padding: 8 },
      action: { color: theme.colors.accent },
      error: { color: theme.colors.statusDanger, padding: 12 },
    }),
    [theme],
  );
}

function useConflicts(workspaceId: string, revision: number, enabled: boolean) {
  const loadConflicts = useRpc(conflictsRpc);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ConflictState>({ key: "", status: "loading" });
  const key = JSON.stringify([workspaceId, revision, attempt]);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ key, status: "loading" });
    async function readConflicts() {
      try {
        const nextPaths = await loadConflicts({ workspaceId });
        if (!cancelled) setState({ key, status: "ready", paths: nextPaths });
      } catch (cause) {
        if (!cancelled) {
          setState({
            key,
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
    void readConflicts();
    return () => {
      cancelled = true;
    };
  }, [enabled, key, workspaceId, loadConflicts]);

  const paths =
    enabled && state.key === key && state.status === "ready" ? state.paths : EMPTY_PATHS;
  const loading = enabled && (state.key !== key || state.status === "loading");
  const error = enabled && state.key === key && state.status === "error" ? state.error : null;
  return { paths, loading, error, retry };
}

function useDiffSelection(params: DiffParams): DiffSelection {
  const focusPath = params.kind === "working" ? params.focusPath : undefined;
  const focusRequestId = params.kind === "working" ? params.focusRequestId : undefined;
  const focusKey = JSON.stringify([params.kind, focusPath, focusRequestId]);
  const [selection, setSelection] = useState({
    key: focusKey,
    path: focusPath ?? params.files[0]?.path,
  });
  const [openedConflict, setOpenedConflict] = useState<string | null>(null);
  const selectedPath = selection.key === focusKey ? selection.path : focusPath;
  const selectedFile =
    params.files.find((candidate) => candidate.path === selectedPath) ?? params.files[0];
  const selectFile = useCallback(
    (path: string) => setSelection({ key: focusKey, path }),
    [focusKey],
  );
  const selectConflict = useCallback(
    (path: string) => {
      setSelection({ key: focusKey, path });
      setOpenedConflict(null);
    },
    [focusKey],
  );
  return {
    selectedPath,
    selectedFile,
    openedConflict,
    setOpenedConflict,
    selectFile,
    selectConflict,
  };
}

function useDiffRequest(
  params: DiffParams,
  targetFile: DiffFile | undefined,
  targetPath: string | null | undefined,
  comparison: Comparison,
  merge: boolean,
): EditorRequest | null {
  const mode = params.kind === "working" ? params.comparison : undefined;
  const baseRef = params.kind === "working" ? params.baseRef : undefined;
  const sha = params.kind === "commit" ? params.sha : undefined;
  return useMemo<EditorRequest | null>(() => {
    if (!targetPath) return null;
    let diffComparison: DiffRequest["comparison"];
    if (sha !== undefined) diffComparison = { kind: "commit", sha };
    else if (mode !== undefined)
      diffComparison = { kind: "working", mode: comparison === "index" ? "index" : mode, baseRef };
    else return null;
    return {
      kind: "diff",
      value: {
        comparison: diffComparison,
        file: {
          path: targetPath,
          oldPath: targetFile?.oldPath,
          isNew: targetFile?.isNew ?? false,
          isDeleted: targetFile?.isDeleted ?? false,
          status: targetFile?.status,
        },
        merge,
      },
    };
  }, [targetPath, targetFile, sha, mode, baseRef, comparison, merge]);
}

function useDiffEditor(
  props: DiffToolsProps,
  selection: DiffSelection,
  conflictPaths: readonly string[],
  comparison: Comparison,
) {
  const { params, useForDiffs, useForMergeConflicts } = props;
  const conflictFile = params.files.find(
    (candidate) => candidate.path === selection.openedConflict,
  );
  const targetFile = useForDiffs ? selection.selectedFile : conflictFile;
  const targetPath = useForDiffs ? selection.selectedFile?.path : selection.openedConflict;
  const merge =
    useForMergeConflicts && params.kind === "working" && conflictPaths.includes(targetPath ?? "");
  const showEditor =
    useForDiffs || (useForMergeConflicts && selection.openedConflict !== null && merge);
  const request = useDiffRequest(params, targetFile, targetPath, comparison, merge);
  return { merge, showEditor, request };
}

function comparisonLabel(mode: Extract<DiffParams, { kind: "working" }>["comparison"] | undefined) {
  switch (mode) {
    case "base":
      return "Merge base → HEAD";
    case "all":
      return "Merge base → worktree";
    default:
      return "HEAD → worktree";
  }
}

function DiffControls({
  params,
  selectedPath,
  comparison,
  merge,
  themedStyles,
  onFileChange,
  onComparisonChange,
}: {
  params: DiffParams;
  selectedPath: string;
  comparison: Comparison;
  merge: boolean;
  themedStyles: ThemedStyles;
  onFileChange: (path: string) => void;
  onComparisonChange: (value: Comparison) => void;
}) {
  const fileOptions = useMemo(
    () => params.files.map((candidate) => ({ label: candidate.path, value: candidate.path })),
    [params.files],
  );
  const mode = params.kind === "working" ? params.comparison : undefined;
  const comparisonOptions = useMemo(
    () => [
      { label: comparisonLabel(mode), value: "paseo" as const },
      { label: "Index → worktree", value: "index" as const },
    ],
    [mode],
  );
  return (
    <View style={themedStyles.toolbar}>
      <Select
        label="Diff file"
        value={selectedPath}
        options={fileOptions}
        onValueChange={onFileChange}
      />
      {params.kind === "working" && !merge ? (
        <Select<Comparison>
          label="Comparison"
          value={comparison}
          options={comparisonOptions}
          onValueChange={onComparisonChange}
        />
      ) : null}
    </View>
  );
}

function ConflictControls({
  paths,
  selectedPath,
  showEditor,
  themedStyles,
  onFileChange,
  onToggle,
}: {
  paths: readonly string[];
  selectedPath: string;
  showEditor: boolean;
  themedStyles: ThemedStyles;
  onFileChange: (path: string) => void;
  onToggle: () => void;
}) {
  const options = useMemo(() => paths.map((path) => ({ label: path, value: path })), [paths]);
  return (
    <View style={themedStyles.toolbar}>
      <Select
        label="Conflicted file"
        value={selectedPath}
        options={options}
        onValueChange={onFileChange}
      />
      <Pressable accessibilityRole="button" onPress={onToggle}>
        <Text style={themedStyles.action}>{showEditor ? "Back to diff" : "Resolve in Neovim"}</Text>
      </Pressable>
    </View>
  );
}

function DiffContent({
  workspaceId,
  revision,
  tab,
  theme,
  children,
  showEditor,
  loading,
  error,
  request,
  merge,
  themedStyles,
}: Pick<DiffToolsProps, "workspaceId" | "revision" | "tab" | "theme" | "children"> & {
  showEditor: boolean;
  loading: boolean;
  error: string | null;
  request: EditorRequest | null;
  merge: boolean;
  themedStyles: ThemedStyles;
}) {
  if (!showEditor) return children;
  if (loading) return <Loading />;
  if (error) return null;
  if (!request) {
    return <Text style={themedStyles.empty}>No changed files in this comparison.</Text>;
  }
  return (
    <View style={styles.fill}>
      {merge ? (
        <Text style={themedStyles.merge}>
          BASE / LOCAL / REMOTE are read-only; edit and save MERGED, then stage and commit with Git
          yourself.
        </Text>
      ) : null}
      <NeovimTerminal
        workspaceId={workspaceId}
        request={request}
        revision={revision}
        tab={tab}
        theme={theme}
      />
    </View>
  );
}

function DiffTools(props: DiffToolsProps) {
  const { workspaceId, params, revision, tab, theme, children, useForDiffs, useForMergeConflicts } =
    props;
  const [comparison, setComparison] = useState<Comparison>("paseo");
  const selection = useDiffSelection(params);
  const conflicts = useConflicts(
    workspaceId,
    revision,
    useForMergeConflicts && params.kind === "working",
  );
  const { merge, showEditor, request } = useDiffEditor(
    props,
    selection,
    conflicts.paths,
    comparison,
  );
  const themedStyles = useThemedStyles(theme);
  const conflictPath = conflicts.paths.includes(selection.selectedPath ?? "")
    ? selection.selectedPath
    : conflicts.paths[0];
  const { setOpenedConflict } = selection;
  const toggleConflict = useCallback(() => {
    if (conflictPath) setOpenedConflict(showEditor ? null : conflictPath);
  }, [conflictPath, showEditor, setOpenedConflict]);

  if (!showEditor && !conflicts.loading && !conflicts.error && conflicts.paths.length === 0) {
    return children;
  }
  return (
    <View style={themedStyles.panel}>
      {useForDiffs && selection.selectedFile ? (
        <DiffControls
          params={params}
          selectedPath={selection.selectedFile.path}
          comparison={comparison}
          merge={merge}
          themedStyles={themedStyles}
          onFileChange={selection.selectFile}
          onComparisonChange={setComparison}
        />
      ) : null}
      {!useForDiffs && conflictPath ? (
        <ConflictControls
          paths={conflicts.paths}
          selectedPath={conflictPath}
          showEditor={showEditor}
          themedStyles={themedStyles}
          onFileChange={selection.selectConflict}
          onToggle={toggleConflict}
        />
      ) : null}
      {conflicts.error ? (
        <View>
          <Text accessibilityRole="alert" style={themedStyles.error}>
            {conflicts.error}
          </Text>
          <SettingsAction
            label="Read conflicted files"
            actionLabel="Retry"
            onPress={conflicts.retry}
          />
        </View>
      ) : null}
      <DiffContent
        workspaceId={workspaceId}
        revision={revision}
        tab={tab}
        theme={theme}
        showEditor={showEditor}
        loading={conflicts.loading}
        error={conflicts.error}
        request={request}
        merge={merge}
        themedStyles={themedStyles}
      >
        {children}
      </DiffContent>
    </View>
  );
}

export function NeovimDiffPanel(props: PluginDiffPanelProps) {
  const settings = useSettings(preferences);
  const themedStyles = useThemedStyles(props.theme);
  if (settings.status === "loading") return props.children;
  if (settings.status !== "ready") {
    return (
      <View style={styles.fill}>
        <Text accessibilityRole="alert" style={themedStyles.error}>
          {settings.error}
        </Text>
        <SettingsAction
          label="Load Neovim tool settings"
          actionLabel="Retry"
          onPress={settings.reload}
        />
        {props.children}
      </View>
    );
  }
  if (!settings.values.useForDiffs && !settings.values.useForMergeConflicts) return props.children;
  return (
    <DiffTools
      {...props}
      useForDiffs={settings.values.useForDiffs}
      useForMergeConflicts={settings.values.useForMergeConflicts}
    />
  );
}
