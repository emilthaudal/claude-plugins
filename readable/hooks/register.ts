import type { Hook, Register } from 'claude-code'
import { parse, type Block } from './markdown'
import { pasteShown, promptParts } from './prompt'
import { BLOCK_MARGIN, MARGIN, render, type ListNode, type Node, type Row } from './render'
import { oneSentencePerLine } from './sentences'
import { fromPalette, over, parseGhosttyConfig, parseRexTheme, rexThemeId, THEMES, type Theme, type ThemeName } from './theme'

// MARK: Reply rows

// The engine keeps a column clear at each edge of the transcript, so a row as wide as the viewport would spill.
const EDGE = 2
// Used for the first draw, before the engine reports the terminal's size.
const UNMEASURED_COLUMNS = 120
const REPLY_MARK = '●'
const PROMPT_MARK = '❯'
const PASTE_BAR = '▎'

/** Laid-out recent replies: a reply redraws on every scroll and resize, but its text and width rarely change. */
class RecentLayouts {
  private readonly layouts = new Map<string, Node[]>()

  constructor(private readonly capacity: number) {}

  get(key: string, lay: () => Node[]): Node[] {
    const hit = this.layouts.get(key)
    // Insertion order is recency: a hit moves to the back, and the front is the first to go.
    this.layouts.delete(key)
    const layout = hit ?? lay()
    this.layouts.set(key, layout)
    if (this.layouts.size > this.capacity) this.layouts.delete(this.layouts.keys().next().value as string)
    return layout
  }
}

// MARK: Options

type Options = { theme: ThemeName; sentencePerLine: boolean }

function readOptions(raw: unknown): Options {
  const options = (raw ?? {}) as Record<string, unknown>
  const isNamed = options.theme === 'terminal' || options.theme === 'ghostty' || (typeof options.theme === 'string' && options.theme in THEMES)
  return { theme: isNamed ? (options.theme as ThemeName) : 'terminal', sentencePerLine: options.sentencePerLine !== false }
}

type Engine = Parameters<Hook<'ui.render'>>[0]

// MARK: Rex

// Where the Rex app ships its themes, Beta first; the file sits in the app bundle, not in a documented place.
const REX_THEMES = ['/Applications/Rex Beta.app', '/Applications/Rex.app'].map(
  app => `${app}/Contents/Resources/SuperUI_SuperDesignTokens.bundle/Contents/Resources/themes.json`,
)

// Rex puts REX_SESSION in the environment of every terminal it starts. The app keeps the chosen dark and light
// theme in its defaults, and themes.json holds each theme's colours.
async function rexTheme($: Engine): Promise<Theme | undefined> {
  const session = await $.env.get('REX_SESSION')
  if (session === undefined || session === '') return undefined
  const defaults = await $.process.run(['defaults', 'read', 'com.superlogical.rex'], { timeoutMs: 5000 })
  if (defaults.exitCode !== 0) return undefined
  // Fails when the system is in light mode, which reads as not dark.
  const style = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5000 })
  const id = rexThemeId(defaults.stdout, style.exitCode === 0 && style.stdout.trim() === 'Dark')
  if (id === undefined) return undefined
  for (const path of REX_THEMES) {
    const { exitCode, stdout } = await $.process.run(['cat', path], { timeoutMs: 5000 })
    const palette = exitCode === 0 ? parseRexTheme(stdout, id) : undefined
    if (palette) return fromPalette(palette)
  }
  return undefined
}

// MARK: Ghostty

// Ghostty puts its bin directory in the environment of everything it starts, herdr's panes included, and
// show-config prints the theme's colours already resolved, so no theme file has to be found.
async function ghosttyTheme($: Engine): Promise<Theme | undefined> {
  const dir = await $.env.get('GHOSTTY_BIN_DIR')
  if (dir === undefined || dir === '') return undefined
  const { exitCode, stdout } = await $.process.run([`${dir}/ghostty`, '+show-config'], { timeoutMs: 5000 })
  const palette = exitCode === 0 ? parseGhosttyConfig(stdout) : undefined
  return palette && fromPalette(palette)
}

// The terminal's colours are read once, on the first draw: Rex's, else Ghostty's; when neither can be read, Embark's.
let terminal: Promise<Theme> | undefined
function themeFor($: Engine, name: ThemeName): Promise<Theme> {
  if (name !== 'terminal' && name !== 'ghostty') return Promise.resolve(THEMES[name])
  terminal ??= rexTheme($)
    .catch(() => undefined)
    .then(theme => theme ?? ghosttyTheme($))
    .then(
      theme => theme ?? THEMES.embark,
      () => THEMES.embark,
    )
  return terminal
}

// MARK: Hooks

export const register: Register = (on, raw) => {
  const options = readOptions(raw)
  const reshape = (blocks: Block[]) => (options.sentencePerLine ? oneSentencePerLine(blocks) : blocks)
  const recent = new RecentLayouts(200)

  // A hook that throws hands the row to the engine, so a parser bug never blanks a message.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary keeps the engine's faint "· summary" mark, which rows of readable's own would drop.
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const theme = await themeFor($, options.theme)
    const columns = (e.viewport?.columns ?? UNMEASURED_COLUMNS) - EDGE
    const nodes = recent.get(`${columns}:${e.props.text}`, () => {
      const blocks = reshape(parse(e.props.text))
      return blocks.length === 0 ? [] : render(blocks, theme, columns)
    })
    if (nodes.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // A run of lines is one Text, its lines joined by newlines: nested Texts are not layout nodes, so a run of
    // paragraphs, headings and panels is one node however long, which a resumed session pays for every message at once.
    // A list item costs a few more (its row, its marker's column and its text), bounded by the items: its text has to
    // be a node of its own for the engine to wrap it under the item's first word.
    // Links are text with the URL after them, not Link elements: a terminal without OSC 8 (tmux) prints a Link's URL
    // again after it, unmeasured, which overflows the row.
    const text = (lines: Row[]) =>
      Text({ children: lines.flatMap((line, i) => [...(i > 0 ? ['\n'] : []), ...line.map(span => Text({ ...span.look, children: [span.text] }))]) })
    const spaced = (space: boolean) => (space ? { marginTop: 1 } : {})
    const list = (node: ListNode): ReturnType<typeof Box> =>
      Box({
        flexDirection: 'column',
        paddingLeft: node.indent,
        ...spaced(node.space),
        children: node.items.map(item => {
          const parts = item.parts.map((part, i) => {
            if (part.kind === 'list') return list(part)
            const body = part.lines.length > 0 ? [text(part.lines)] : []
            const space = spaced(item.space && i === 0 && item.parts.length === 1)
            if (part.marker === undefined) return Box({ paddingLeft: part.hang, ...space, children: body })
            // The marker has a column of its own, so the rows the engine wraps the text onto start under its first word.
            const marker = Box({ width: part.hang, flexShrink: 0, children: [Text({ ...part.marker.look, children: [part.marker.text] })] })
            return Box({ ...space, children: [marker, ...body] })
          })
          return parts.length === 1 ? (parts[0] as ReturnType<typeof Box>) : Box({ flexDirection: 'column', ...spaced(item.space), children: parts })
        }),
      })
    let copies = 0
    const drawn = nodes.map(node => {
      if (node.kind === 'text') return text(node.lines)
      if (node.kind === 'list') return list(node)
      const raw = node.text
      // Selecting a panel with the mouse takes its padding and bar along; the button copies the block's text alone.
      const copy = Button({
        key: `copy-${copies++}`,
        label: 'copy',
        plain: true,
        dimColor: true,
        onPress: async press => {
          const { isCopied } = await $.ui.copy({ text: raw, surface: press.surface })
          $.ui.toast(isCopied ? 'Copied' : 'Could not copy')
        },
      })
      return Box({ paddingLeft: BLOCK_MARGIN, children: [copy] })
    })
    // A blank row above and below sets the reply apart from the rows around it. The margins are layout, not spaces in
    // the text, so the rows the engine wraps a line onto start at the text and a selection leaves them out.
    const margins = { marginTop: 1, marginBottom: 1 }
    const column = { flexDirection: 'column' as const, paddingRight: MARGIN, children: drawn }
    if (e.props.isFirstOfReply !== true) return Box({ ...margins, ...column, paddingLeft: MARGIN })
    // The first message of a reply carries the engine's `●`, in the margin left of the text.
    const mark = Box({ width: MARGIN, flexShrink: 0, children: [Text({ ...theme.text, children: [REPLY_MARK] })] })
    return Box({ ...margins, children: [mark, Box({ ...column, flexGrow: 1, flexShrink: 1 })] })
  }).catch(($, e, next) => next(e))

  // The person's own prompts sit on a panel; notifications and other agents' messages keep the engine's drawing.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theme = await themeFor($, options.theme)
    const { mark: markColor, ...prompt } = theme.prompt
    const { label: labelColor, ...pasted } = theme.paste
    const mark = over(prompt, { color: markColor, bold: true })
    const label = over(pasted, { color: labelColor, italic: true })
    const bar = over(pasted, { color: markColor })

    // A paste is an inset block with a bar and a label, folded to a preview until the row is expanded (ctrl+o).
    const drawPaste = (lines: string[]) => {
      const { shown, hidden } = pasteShown(lines, e.props.isExpanded)
      return Box({
        flexDirection: 'column',
        paddingX: 1,
        backgroundColor: pasted.backgroundColor,
        children: [
          Text({ ...label, children: [`pasted · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`] }),
          ...shown.map(line =>
            Text({ ...pasted, children: [Text({ ...bar, children: [`${PASTE_BAR} `] }), Text({ ...pasted, children: [line === '' ? ' ' : line] })] }),
          ),
          ...(hidden > 0 ? [Text({ ...label, children: [`… ${hidden} more lines (ctrl+o to expand)`] })] : []),
        ],
      })
    }

    return Box({
      marginTop: 1,
      paddingX: 1,
      backgroundColor: prompt.backgroundColor,
      children: [
        Text({ ...mark, children: [`${PROMPT_MARK} `] }),
        Box({
          flexDirection: 'column',
          flexGrow: 1,
          flexShrink: 1,
          gap: 1,
          children: promptParts(e.props.text).map(part =>
            part.kind === 'typed' ? Text({ ...prompt, children: [part.text] }) : drawPaste(part.lines),
          ),
        }),
      ],
    })
  }).catch(($, e, next) => next(e))
}
