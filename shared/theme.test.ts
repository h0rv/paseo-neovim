import type { PluginTheme } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { preferences } from "./settings";
import { themeHighlights, themeRpc } from "./theme";

const theme = {
  colors: {
    surface0: "#181B1A",
    surface1: "#1E2120",
    surface2: "#272A29",
    border: "#252B2A",
    foreground: "#ffffff",
    foregroundMuted: "#A1A5A4",
    accent: "#20744A",
    accentForeground: "#fff",
    statusSuccess: "#6cb17b",
    statusWarning: "#c09664",
    statusDanger: "#d8847b",
  },
  syntax: {
    keyword: "#ff7b72",
    comment: "#8b949e",
    string: "#a5d6ff",
    number: "#79c0ff",
    literal: "#79c0ff",
    function: "#d2a8ff",
    definition: "#d2a8ff",
    class: "#ffa657",
    type: "#ff7b72",
    tag: "#7ee787",
    attribute: "#79c0ff",
    property: "#79c0ff",
    variable: "#c9d1d9",
    operator: "#79c0ff",
    punctuation: "#c9d1d9",
    regexp: "#a5d6ff",
    escape: "#79c0ff",
    meta: "#8b949e",
    heading: "#79c0ff",
    link: "#a5d6ff",
  },
} satisfies PluginTheme;

describe("native Neovim theme mapping", () => {
  it("keeps inheritance off for new and existing saved preferences", () => {
    expect(preferences.schema.parse({}).followPaseoTheme).toBe(false);
    expect(preferences.schema.parse({ useForDiffs: true }).followPaseoTheme).toBe(false);
  });

  it("maps host UI colors and actual syntax tokens to native RGB highlights", () => {
    const highlights = themeHighlights(theme);
    expect(highlights.Normal).toEqual({ fg: 0xffffff, bg: 0x181b1a });
    expect(highlights.StatusLine).toEqual({ fg: 0xffffff, bg: 0x272a29 });
    expect(highlights.FloatBorder).toEqual({ fg: 0x252b2a, bg: 0x1e2120 });
    expect(highlights.Visual).toEqual({ fg: 0xffffff, bg: 0x272a29 });
    expect(highlights.PmenuSel).toEqual({ fg: 0xffffff, bg: 0x20744a });
    expect(highlights.Comment).toEqual({ fg: 0x8b949e });
    expect(highlights["@comment"]).toEqual(highlights.Comment);
    expect(highlights["@keyword.conditional"]).toEqual({ fg: 0xff7b72 });
    expect(highlights["@function.method"]).toEqual({ fg: 0xd2a8ff });
    expect(highlights["@tag"]).toEqual({ fg: 0x7ee787 });
    expect(highlights.DiagnosticError).toEqual({ fg: 0xd8847b });
    expect(
      themeRpc.input.parse({
        sessionId: "da079f69-1c59-4fc8-b293-df191a6b79a0",
        highlights,
      }).highlights,
    ).toEqual(highlights);
  });

  it("does not invent syntax colors on older hosts and updates existing groups with a new palette", () => {
    const withoutSyntax = themeHighlights({ colors: theme.colors });
    expect(withoutSyntax.Comment).toBeUndefined();
    const next = themeHighlights({
      ...theme,
      colors: { ...theme.colors, surface0: "#ffffff" },
      syntax: { ...theme.syntax, keyword: "#cf222e" },
    });
    expect(next.Normal.bg).toBe(0xffffff);
    expect(next.Keyword).toEqual({ fg: 0xcf222e });
  });

  it("rejects unsupported CSS formats instead of sending invalid Neovim colors", () => {
    expect(() => themeHighlights({ colors: { ...theme.colors, surface0: "red" } })).toThrow(
      /Expected an opaque hex color/,
    );
  });
});
