import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
  TextInput,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { preferences } from "../shared/settings";

type ReadySettings = Extract<SettingsState<typeof preferences.schema>, { status: "ready" }>;

type LaunchValues = Pick<
  ReadySettings["values"],
  "neovimExecutable" | "initFile" | "extraArguments" | "gitExecutable"
>;

const styles = StyleSheet.create({
  content: { padding: 16, gap: 24 },
  arguments: {
    minWidth: 220,
    minHeight: 72,
    padding: 8,
    borderWidth: 1,
    borderRadius: 6,
    textAlignVertical: "top",
  },
});

function useThemedStyles(theme: PluginSurfaceProps["theme"]) {
  return useMemo(
    () => ({
      arguments: {
        ...styles.arguments,
        borderColor: theme.colors.border,
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface0,
      },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
    }),
    [theme],
  );
}

function launchValues(settings: ReadySettings): LaunchValues {
  const { neovimExecutable, initFile, extraArguments, gitExecutable } = settings.values;
  return { neovimExecutable, initFile, extraArguments, gitExecutable };
}

function LaunchControls({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginSurfaceProps["theme"];
}) {
  const { save, values, revision } = settings;
  const [draft, setDraft] = useState(() => launchValues(settings));
  const changed = JSON.stringify(draft) !== JSON.stringify(launchValues(settings));
  const themedStyles = useThemedStyles(theme);
  const handleExecutableChange = useCallback((neovimExecutable: string) => {
    setDraft((current) => ({ ...current, neovimExecutable }));
  }, []);
  const handleInitFileChange = useCallback((initFile: string) => {
    setDraft((current) => ({ ...current, initFile }));
  }, []);
  const handleArgumentsChange = useCallback((extraArguments: string) => {
    setDraft((current) => ({ ...current, extraArguments }));
  }, []);
  const handleGitExecutableChange = useCallback((gitExecutable: string) => {
    setDraft((current) => ({ ...current, gitExecutable }));
  }, []);
  const handleSave = useCallback(() => {
    void save({ ...values, ...draft }, revision);
  }, [save, values, revision, draft]);
  return (
    <SettingsSection
      title="Launch configuration"
      info="New editors use these settings. Existing sessions keep running with their original configuration."
    >
      <SettingsCard>
        <SettingsInput
          label="Neovim executable"
          hint="Use nvim from PATH or enter the executable path on the daemon host."
          initialValue={draft.neovimExecutable}
          placeholder="nvim"
          disabled={settings.saving}
          onChangeText={handleExecutableChange}
        />
        <SettingsInput
          label="Init file"
          hint="Optional. Leave empty to use your normal Neovim configuration."
          initialValue={draft.initFile}
          placeholder="~/.config/nvim/init.lua"
          disabled={settings.saving}
          onChangeText={handleInitFileChange}
        />
        <SettingsRow
          label="Extra arguments"
          hint="One argument per line. Arguments are passed directly, without a shell."
        >
          <TextInput
            accessibilityLabel="Extra Neovim arguments"
            multiline
            numberOfLines={3}
            value={draft.extraArguments}
            editable={!settings.saving}
            onChangeText={handleArgumentsChange}
            placeholder="--clean"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={themedStyles.arguments}
          />
        </SettingsRow>
        <SettingsInput
          label="Git executable"
          hint="Used by :PaseoDiff and the optional diff and merge views."
          initialValue={draft.gitExecutable}
          placeholder="git"
          disabled={settings.saving}
          onChangeText={handleGitExecutableChange}
        />
        <SettingsAction
          label="Apply configuration"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={!changed || settings.saving}
          onPress={handleSave}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ThemeControls({ settings }: { settings: ReadySettings }) {
  const { save, values, revision } = settings;
  const handleThemeChange = useCallback(
    (followPaseoTheme: boolean) => {
      void save({ ...values, followPaseoTheme }, revision);
    },
    [save, values, revision],
  );
  return (
    <SettingsSection title="Appearance">
      <SettingsCard>
        <SettingsSwitch
          label="Follow Paseo theme"
          hint="Match Paseo's code font, size, line spacing, and native Neovim colors live. Turn off to restore terminal appearance and your colorscheme."
          value={values.followPaseoTheme}
          disabled={settings.saving}
          onValueChange={handleThemeChange}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ToolControls({ settings }: { settings: ReadySettings }) {
  const { save, values, revision } = settings;
  const handleDiffsChange = useCallback(
    (useForDiffs: boolean) => {
      void save({ ...values, useForDiffs }, revision);
    },
    [save, values, revision],
  );
  const handleMergeConflictsChange = useCallback(
    (useForMergeConflicts: boolean) => {
      void save({ ...values, useForMergeConflicts }, revision);
    },
    [save, values, revision],
  );
  return (
    <SettingsSection title="Optional diff tools">
      <SettingsCard>
        <SettingsSwitch
          label="Use Neovim for diffs"
          hint="Render changes and commit comparisons in native Neovim diff windows."
          value={settings.values.useForDiffs}
          disabled={settings.saving}
          onValueChange={handleDiffsChange}
        />
        <SettingsSwitch
          label="Use Neovim for merge conflicts"
          hint="Open BASE, LOCAL, REMOTE and editable MERGED buffers. Staging and commits remain manual."
          value={settings.values.useForMergeConflicts}
          disabled={settings.saving}
          onValueChange={handleMergeConflictsChange}
        />
      </SettingsCard>
      <SettingsRow
        label="Merge conflicts"
        hint="When only merge conflicts are enabled, select a conflicted file in Changes and choose Resolve in Neovim above the built-in diff."
      />
    </SettingsSection>
  );
}

export function NeovimSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const themedStyles = useThemedStyles(theme);
  if (settings.status === "loading")
    return <Text style={themedStyles.muted}>Loading Neovim settings…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Neovim tools">
        <Text accessibilityRole="alert" style={themedStyles.error}>
          {settings.error}
        </Text>
        <SettingsAction label="Load settings" actionLabel="Retry" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Restore default settings"
            actionLabel="Reset"
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <SettingsSection title="File editor">
        <SettingsCard>
          <SettingsRow
            label="Default editor"
            hint="Choose Neovim under Settings > Files > All text files. File links and line targets then open in the editor."
          />
          <SettingsRow
            label="Git inside Neovim"
            hint="Use :PaseoDiff for the current file or :PaseoMerge for a conflict. Your existing Git plugins and commands are unchanged."
          />
          <SettingsRow
            label="Editor sessions"
            hint="Closing a panel keeps Neovim running. Save and use :qa before closing a tab if you want to end its process. A restored tab reconnects to its saved session."
          />
        </SettingsCard>
      </SettingsSection>
      <ThemeControls settings={settings} />
      {settings.saveError ? (
        <Text accessibilityRole="alert" style={themedStyles.error}>
          {settings.saveError}
        </Text>
      ) : null}
      <LaunchControls
        key={JSON.stringify(launchValues(settings))}
        settings={settings}
        theme={theme}
      />
      <ToolControls settings={settings} />
    </ScrollView>
  );
}
