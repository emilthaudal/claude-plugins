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

// MARK: Ghostty

/** A terminal's colours: its background, foreground and the 16 ANSI colours, each `#rrggbb`. */
export type Palette = { background: string; foreground: string; ansi: string[] }

const HEX = /^#?([0-9a-f]{6})$/i
const hex = (value: string) => {
  const match = HEX.exec(value)
  return match === null ? undefined : `#${(match[1] as string).toLowerCase()}`
}

/** Reads the colours out of `ghostty +show-config`; undefined when any of the 18 is missing. */
export function parseGhosttyConfig(text: string): Palette | undefined {
  let background: string | undefined
  let foreground: string | undefined
  const ansi: (string | undefined)[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*([a-z-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match === null) continue
    const key = match[1] as string
    const value = match[2] as string
    if (key === 'background') background = hex(value)
    else if (key === 'foreground') foreground = hex(value)
    else if (key === 'palette') {
      const entry = /^(\d+)=(.+)$/.exec(value)
      if (entry !== null && Number(entry[1]) < 16) ansi[Number(entry[1])] = hex(entry[2] as string)
    }
  }
  const colors = Array.from({ length: 16 }, (_, i) => ansi[i])
  if (background === undefined || foreground === undefined || colors.some(c => c === undefined)) return undefined
  return { background, foreground, ansi: colors as string[] }
}

const rgb = (color: string) => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
const toHex = (c: number[]) => `#${c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`
/** `a` moved a fraction `t` of the way towards `b`. */
export function mix(a: string, b: string, t: number): string {
  const to = rgb(b)
  return toHex(rgb(a).map((v, i) => v + ((to[i] as number) - v) * t))
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `color` moved towards `towards` only as far as it takes to reach `min` contrast on `on`. */
function legible(color: string, on: string, towards: string, min: number): string {
  for (let step = 0; step <= 20; step++) {
    const tried = mix(color, towards, step / 20)
    if (contrast(tried, on) >= min) return tried
  }
  return towards
}

/** Readable's looks drawn from a terminal's palette, each colour kept legible on the panel it sits on. */
export function fromPalette({ background: bg, foreground: fg, ansi }: Palette): Theme {
  const isDark = luminance(bg) < luminance(fg)
  // As in Embark: on a dark terminal the code panel sits below the background and the others step above it.
  const inset = isDark ? mix(bg, '#000000', 0.25) : mix(bg, fg, 0.04)
  const raised = mix(bg, fg, isDark ? 0.05 : 0.08)
  const surface = mix(bg, fg, isDark ? 0.1 : 0.13)
  const border = mix(bg, fg, 0.25)
  const extreme = isDark ? '#ffffff' : '#000000'
  const [, red, green, yellow, blue, magenta, cyan, , dim] = ansi as [string, string, string, string, string, string, string, string, string]
  const brightMagenta = ansi[13] as string
  const brightWhite = ansi[15] as string

  // Prose is held to 4.5:1 on the lightest panel it meets, code to 4.5:1 on the code panel.
  const prose = (color: string) => legible(color, surface, extreme, 4.5)
  const code = (color: string) => legible(color, inset, extreme, 4.5)
  // Bright black is often a dim grey meant for hints; comments and captions get a lower floor but must still read.
  const muted = legible(dim, surface, fg, 3.5)
  const comment = legible(dim, inset, fg, 3.5)
  const text = prose(fg)
  const bright = prose(brightWhite === fg ? mix(fg, extreme, 0.4) : brightWhite)
  const accent = prose(magenta)
  const heading = prose(brightMagenta)

  return {
    text: { color: text },
    strong: { color: bright, bold: true },
    emph: { color: heading, italic: true },
    strike: { strikethrough: true },
    code: { color: prose(green), backgroundColor: surface },
    linkText: { color: heading, bold: true },
    url: { color: prose(cyan), underline: true },
    caption: { color: muted },
    imageUrl: { color: prose(red), underline: true },
    heading: { color: heading, bold: true },
    headings: {
      1: { color: legible(inset, accent, isDark ? '#000000' : '#ffffff', 4.5), backgroundColor: accent, bold: true },
      6: { color: muted, bold: false },
    },
    marker: { color: accent },
    rule: { color: border },
    table: { color: text },
    quote: { color: text, backgroundColor: raised, italic: true },
    codeBlock: { color: code(fg), backgroundColor: inset },
    syntax: {
      plain: { color: code(fg) },
      comment: { color: comment, italic: true },
      directive: { color: code(brightMagenta) },
      keyword: { color: code(magenta) },
      declaration: { color: code(magenta) },
      module: { color: code(brightMagenta) },
      type: { color: code(blue) },
      builtin: { color: code(cyan) },
      function: { color: code(yellow) },
      class: { color: code(blue), bold: true },
      decorator: { color: code(yellow) },
      tag: { color: code(red) },
      attribute: { color: code(brightMagenta) },
      string: { color: code(green) },
      escape: { color: code(cyan) },
      number: { color: code(red) },
      operator: { color: code(cyan) },
      punctuation: { color: code(fg) },
      added: { color: code(green) },
      removed: { color: code(red) },
      hunk: { color: comment },
      header: { color: code(fg), bold: true },
    },
    prompt: { color: bright, backgroundColor: surface, mark: accent },
    paste: { color: text, backgroundColor: raised, label: muted },
  }
}

// MARK: Choice

/** The fixed themes the `theme` option picks between; plugin.json lists them after `ghostty`. */
export const THEMES = { embark: EMBARK, dark: DARK } satisfies Record<string, Theme>

export type ThemeName = keyof typeof THEMES | 'ghostty'
