import { defineRpc, type PluginTheme } from "@getpaseo/plugin";
import { z } from "zod";

const rgb = z.number().int().min(0).max(0xffffff);
const highlightSchema = z.object({
  fg: rgb.optional(),
  bg: rgb.optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
});
export type Highlights = Record<string, z.infer<typeof highlightSchema>>;

export const themeRpc = defineRpc({
  name: "theme",
  input: z.object({
    sessionId: z.uuid(),
    highlights: z.record(z.string(), highlightSchema).nullable(),
  }),
  output: z.object({ applied: z.boolean() }),
});

// Paseo's semantic and syntax palettes use opaque hex colors. Convert to Neovim's
// numeric RGB API rather than passing CSS strings or relying on terminal ANSI colors.
function color(value: string): number {
  if (/^#[\da-f]{6}$/i.test(value)) return Number.parseInt(value.slice(1), 16);
  if (/^#[\da-f]{3}$/i.test(value))
    return Number.parseInt(value.slice(1).replace(/./g, "$&$&"), 16);
  throw new Error(`Unsupported Paseo theme color: ${value}. Expected an opaque hex color.`);
}

const SYNTAX_GROUPS: Record<keyof NonNullable<PluginTheme["syntax"]>, readonly string[]> = {
  keyword: [
    "Statement",
    "Conditional",
    "Repeat",
    "Label",
    "Keyword",
    "Exception",
    "@keyword",
    "@keyword.coroutine",
    "@keyword.function",
    "@keyword.operator",
    "@keyword.import",
    "@keyword.type",
    "@keyword.modifier",
    "@keyword.repeat",
    "@keyword.return",
    "@keyword.debug",
    "@keyword.exception",
    "@keyword.conditional",
    "@keyword.conditional.ternary",
  ],
  comment: ["Comment", "@comment", "@comment.documentation"],
  string: ["String", "Character", "@string", "@string.documentation", "@character"],
  number: ["Number", "Float", "@number", "@number.float"],
  literal: ["Constant", "Boolean", "@constant", "@constant.builtin", "@boolean"],
  function: [
    "Function",
    "@function",
    "@function.builtin",
    "@function.call",
    "@function.method",
    "@function.method.call",
  ],
  definition: ["@variable.parameter", "@function.macro"],
  class: ["Structure", "@type.definition", "@module", "@constructor"],
  type: ["Type", "StorageClass", "Typedef", "@type", "@type.builtin"],
  tag: ["Tag", "@tag"],
  attribute: ["@attribute", "@tag.attribute"],
  property: ["@property", "@variable.member"],
  variable: ["Identifier", "@variable", "@variable.builtin"],
  operator: ["Operator", "@operator"],
  punctuation: [
    "Delimiter",
    "@punctuation",
    "@punctuation.delimiter",
    "@punctuation.bracket",
    "@punctuation.special",
    "@tag.delimiter",
  ],
  regexp: ["@string.regexp"],
  escape: ["Special", "SpecialChar", "@string.escape", "@string.special"],
  meta: ["PreProc", "Include", "Define", "Macro", "PreCondit", "@keyword.directive"],
  heading: ["Title", "@markup.heading"],
  link: ["Underlined", "@markup.link", "@markup.link.url"],
};

export function themeHighlights(theme: PluginTheme): Highlights {
  const c = Object.fromEntries(
    Object.entries(theme.colors).map(([name, value]) => [name, color(value)]),
  );
  const highlights: Highlights = {
    Normal: { fg: c.foreground, bg: c.surface0 },
    NormalNC: { fg: c.foreground, bg: c.surface0 },
    NormalFloat: { fg: c.foreground, bg: c.surface1 },
    FloatBorder: { fg: c.border, bg: c.surface1 },
    WinSeparator: { fg: c.border, bg: c.surface0 },
    VertSplit: { fg: c.border, bg: c.surface0 },
    EndOfBuffer: { fg: c.foregroundMuted, bg: c.surface0 },
    LineNr: { fg: c.foregroundMuted, bg: c.surface0 },
    CursorLineNr: { fg: c.foreground, bg: c.surface1 },
    SignColumn: { fg: c.foregroundMuted, bg: c.surface0 },
    FoldColumn: { fg: c.foregroundMuted, bg: c.surface0 },
    Folded: { fg: c.foregroundMuted, bg: c.surface1 },
    NonText: { fg: c.foregroundMuted },
    Whitespace: { fg: c.foregroundMuted },
    CursorLine: { bg: c.surface1 },
    ColorColumn: { bg: c.surface1 },
    StatusLine: { fg: c.foreground, bg: c.surface2 },
    StatusLineNC: { fg: c.foregroundMuted, bg: c.surface1 },
    TabLine: { fg: c.foregroundMuted, bg: c.surface1 },
    TabLineFill: { bg: c.surface1 },
    TabLineSel: { fg: c.foreground, bg: c.surface2 },
    Pmenu: { fg: c.foreground, bg: c.surface1 },
    PmenuSel: { fg: c.accentForeground, bg: c.accent },
    Visual: { fg: c.foreground, bg: c.surface2 },
    Search: { fg: c.accentForeground, bg: c.accent },
    IncSearch: { fg: c.accentForeground, bg: c.accent },
    Error: { fg: c.statusDanger },
    ErrorMsg: { fg: c.statusDanger },
    WarningMsg: { fg: c.statusWarning },
    DiagnosticError: { fg: c.statusDanger },
    DiagnosticWarn: { fg: c.statusWarning },
    DiagnosticOk: { fg: c.statusSuccess },
    DiagnosticInfo: { fg: c.accent },
    DiagnosticHint: { fg: c.foregroundMuted },
    DiffAdd: { fg: c.statusSuccess, bg: c.surface1 },
    DiffDelete: { fg: c.statusDanger, bg: c.surface1 },
    DiffChange: { bg: c.surface1 },
    DiffText: { bg: c.surface2 },
  };
  if (theme.syntax) {
    for (const [token, groups] of Object.entries(SYNTAX_GROUPS)) {
      const fg = color(theme.syntax[token as keyof typeof theme.syntax]);
      for (const group of groups) highlights[group] = { fg };
    }
  }
  return highlights;
}
