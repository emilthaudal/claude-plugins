import type { Register } from 'claude-code'
import { parse, type Block } from './markdown'
import { pasteShown, promptParts } from './prompt'
import { render, type Row } from './render'
import { oneSentencePerLine } from './sentences'
import { over, THEMES, type Theme, type ThemeName } from './theme'

// MARK: Reply rows

// The engine keeps a column clear at each edge of the transcript, so a row as wide as the viewport would spill.
const EDGE = 2
// Used for the first draw, before the engine reports the terminal's size.
const UNMEASURED_COLUMNS = 120
const REPLY_MARK = '●'
const PROMPT_MARK = '❯'
const PASTE_BAR = '▎'

/** Laid-out rows of recent replies: a reply redraws on every scroll and resize, but its text and width rarely change. */
class RecentRows {
  private readonly rows = new Map<string, Row[]>()

  constructor(private readonly capacity: number) {}

  get(key: string, lay: () => Row[]): Row[] {
    const hit = this.rows.get(key)
    // Insertion order is recency: a hit moves to the back, and the front is the first to go.
    this.rows.delete(key)
    const rows = hit ?? lay()
    this.rows.set(key, rows)
    if (this.rows.size > this.capacity) this.rows.delete(this.rows.keys().next().value as string)
    return rows
  }
}

// The first message of a reply carries the engine's `●`, in the margin left of the text.
function marked(rows: Row[], theme: Theme): Row[] {
  const [first, ...rest] = rows
  const margin = first?.[0]
  if (first === undefined || margin === undefined || !margin.text.startsWith(' ')) return rows
  return [[{ text: REPLY_MARK, look: theme.text }, { ...margin, text: margin.text.slice(1) }, ...first.slice(1)], ...rest]
}

// MARK: Options

type Options = { theme: ThemeName; sentencePerLine: boolean }

function readOptions(raw: unknown): Options {
  const options = (raw ?? {}) as Record<string, unknown>
  const theme = typeof options.theme === 'string' && options.theme in THEMES ? (options.theme as ThemeName) : 'embark'
  return { theme, sentencePerLine: options.sentencePerLine !== false }
}

// MARK: Hooks

export const register: Register = (on, raw) => {
  const options = readOptions(raw)
  const theme: Theme = THEMES[options.theme]
  const reshape = (blocks: Block[]) => (options.sentencePerLine ? oneSentencePerLine(blocks) : blocks)
  const recent = new RecentRows(200)

  // A hook that throws hands the row to the engine, so a parser bug never blanks a message.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // A summary keeps the engine's faint "· summary" mark, which rows of readable's own would drop.
    if (e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const columns = (e.viewport?.columns ?? UNMEASURED_COLUMNS) - EDGE
    const first = e.props.isFirstOfReply === true
    const rows = recent.get(`${columns}:${first}:${e.props.text}`, () => {
      const blocks = reshape(parse(e.props.text))
      if (blocks.length === 0) return []
      const laid = render(blocks, theme, columns)
      return first ? marked(laid, theme) : laid
    })
    if (rows.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // The reply is one Text, its rows joined by newlines: nested Texts are not layout nodes, so the engine lays out one
    // node per reply instead of one per row, which a resumed session pays for every message at once.
    // Links are text with the URL after them, not Link elements: a terminal without OSC 8 (tmux) prints a Link's URL
    // again after it, unmeasured, which overflows the row.
    const children = rows.flatMap((row, i) => [...(i > 0 ? ['\n'] : []), ...row.map(span => Text({ ...span.look, children: [span.text] }))])
    // A blank row above and below sets the reply apart from the rows around it.
    return Box({ marginTop: 1, marginBottom: 1, children: [Text({ children })] })
  }).catch(($, e, next) => next(e))

  // The person's own prompts sit on a panel; notifications and other agents' messages keep the engine's drawing.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.origin.kind !== 'composer') return next(e)
    const { Box, Text } = $.ui.resolve(e)
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
