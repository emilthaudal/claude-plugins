// MARK: Looks

/** How a piece of text is painted: the subset of Ink's Text props readable sets. */
export type Look = {
  color?: string
  backgroundColor?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  dimColor?: boolean
}

/** Paints `look` over `base`: fields the look sets win, the rest carry through from the text around it. */
export function over(base: Look, look: Look | undefined): Look {
  if (look === undefined) return base
  const out: Look = { ...base }
  for (const [key, value] of Object.entries(look) as [keyof Look, never][]) if (value !== undefined) out[key] = value
  return out
}

/** An xterm-256 palette index, which the terminal paints from its own palette. */
const xterm = (index: number) => `ansi256(${index})`

// MARK: Syntax classes

/** What the highlighter tags a stretch of code as; a theme paints each class. */
export type Syntax =
  | 'plain'
  | 'comment'
  | 'directive'
  | 'keyword'
  | 'declaration'
  | 'module'
  | 'type'
  | 'builtin'
  | 'function'
  | 'class'
  | 'decorator'
  | 'tag'
  | 'attribute'
  | 'string'
  | 'escape'
  | 'number'
  | 'operator'
  | 'punctuation'
  | 'added'
  | 'removed'
  | 'hunk'
  | 'header'

// MARK: Theme

export type Theme = {
  /** Prose, and the base every other look in a reply paints over. */
  text: Look
  strong: Look
  emph: Look
  strike: Look
  /** Inline code, drawn as a chip with a space either side. */
  code: Look
  linkText: Look
  url: Look
  /** The `Image: alt →` caption before an image's URL. */
  caption: Look
  imageUrl: Look
  /** Every heading; `headings` overrides it per level. */
  heading: Look
  headings: Partial<Record<1 | 2 | 3 | 4 | 5 | 6, Look>>
  /** Bullets, numbers and task boxes. */
  marker: Look
  rule: Look
  table: Look
  /** A quote's panel; its bar takes the prose colour on the terminal's own background. */
  quote: Look
  /** A code block's panel, under the syntax colours. */
  codeBlock: Look
  syntax: Record<Syntax, Look>
  /** The person's prompt panel and the `❯` mark on it. */
  prompt: Look & { mark: string }
  /** A paste inside a prompt, and its label. */
  paste: Look & { label: string }
}

// MARK: Embark

/** The Embark palette as its terminal and editor themes ship it; `bg` is the terminal's own background. */
const E = {
  bg: '#1e1c31',
  inset: '#171527',
  raised: '#262439',
  surface: '#2d2b40',
  border: '#3e3859',
  fg: '#cbe3e7',
  bright: '#eef6f7',
  muted: '#8a889d',
  accent: '#a37acc',
  purple: '#c792ea',
  lavender: '#d4bfff',
  mint: '#a1efd3',
  yellow: '#ffe6b3',
  blue: '#91ddff',
  cyan: '#87dfeb',
  pink: '#f48fb1',
}

// Prose has no background, so the panels (code darker than the terminal, quotes a step lighter) stand out.
const EMBARK: Theme = {
  text: { color: E.fg },
  strong: { color: E.bright, bold: true },
  emph: { color: E.lavender, italic: true },
  strike: { strikethrough: true },
  code: { color: E.mint, backgroundColor: E.surface },
  linkText: { color: E.lavender, bold: true },
  url: { color: E.cyan, underline: true },
  caption: { color: E.muted },
  imageUrl: { color: E.pink, underline: true },
  heading: { color: E.lavender, bold: true },
  headings: {
    1: { color: E.inset, backgroundColor: E.accent, bold: true },
    6: { color: E.muted, bold: false },
  },
  marker: { color: E.accent },
  rule: { color: E.border },
  table: { color: E.fg },
  quote: { color: E.fg, backgroundColor: E.raised, italic: true },
  codeBlock: { color: E.fg, backgroundColor: E.inset },
  syntax: {
    plain: { color: E.fg },
    // Embark's own comment colour is too faint to read on the inset panel.
    comment: { color: E.muted, italic: true },
    directive: { color: E.lavender },
    keyword: { color: E.purple },
    declaration: { color: E.purple },
    module: { color: E.lavender },
    type: { color: E.blue },
    builtin: { color: E.cyan },
    function: { color: E.yellow },
    class: { color: E.blue, bold: true },
    decorator: { color: E.yellow },
    tag: { color: E.pink },
    attribute: { color: E.lavender },
    string: { color: E.mint },
    escape: { color: E.cyan },
    number: { color: E.pink },
    operator: { color: E.cyan },
    punctuation: { color: E.fg },
    added: { color: E.mint },
    removed: { color: E.pink },
    hunk: { color: E.muted },
    header: { color: E.fg, bold: true },
  },
  // The prompt sits a step above the quote panel, so it stands apart from the reply under it.
  prompt: { color: E.bright, backgroundColor: E.surface, mark: E.accent },
  // A paste sits a step below the prompt, in the reply's text colour, so it reads as quoted material.
  paste: { color: E.fg, backgroundColor: E.raised, label: E.muted },
}

// MARK: Dark

// The colours of charmbracelet/glamour's dark style (MIT), on readable's panels.
const DARK: Theme = {
  text: { color: xterm(252) },
  strong: { bold: true },
  emph: { italic: true },
  strike: { strikethrough: true },
  code: { color: xterm(203), backgroundColor: xterm(236) },
  linkText: { color: xterm(35), bold: true },
  url: { color: xterm(30), underline: true },
  caption: { color: xterm(243) },
  imageUrl: { color: xterm(212), underline: true },
  heading: { color: xterm(39), bold: true },
  headings: {
    1: { color: xterm(228), backgroundColor: xterm(63), bold: true },
    6: { color: xterm(35), bold: false },
  },
  marker: {},
  rule: { color: xterm(240) },
  table: {},
  quote: { color: xterm(250), backgroundColor: '#1f2433' },
  codeBlock: { color: '#C4C4C4', backgroundColor: '#262626' },
  syntax: {
    plain: { color: '#C4C4C4' },
    comment: { color: '#676767' },
    directive: { color: '#FF875F' },
    keyword: { color: '#00AAFF' },
    declaration: { color: '#FF5FD2' },
    module: { color: '#FF5F87' },
    type: { color: '#6E6ED8' },
    builtin: { color: '#FF8EC7' },
    function: { color: '#00D787' },
    class: { color: '#F1F1F1', bold: true, underline: true },
    decorator: { color: '#FFFF87' },
    tag: { color: '#B083EA' },
    attribute: { color: '#7A7AE6' },
    string: { color: '#C69669' },
    escape: { color: '#AFFFD7' },
    number: { color: '#6EEFC0' },
    operator: { color: '#EF8080' },
    punctuation: { color: '#E8E8A8' },
    added: { color: '#00D787' },
    removed: { color: '#FD5B5B' },
    hunk: { color: '#777777' },
    header: { color: '#C4C4C4', bold: true },
  },
  prompt: { color: xterm(255), backgroundColor: '#2b3142', mark: xterm(63) },
  paste: { color: xterm(252), backgroundColor: '#1f2433', label: xterm(243) },
}

// MARK: Choice

/** The themes the `theme` option picks between; plugin.json lists the same names. */
export const THEMES = { embark: EMBARK, dark: DARK } satisfies Record<string, Theme>

export type ThemeName = keyof typeof THEMES
