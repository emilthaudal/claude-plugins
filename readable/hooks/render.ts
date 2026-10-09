import { highlight } from './highlight'
import type { Align, Block, Inline, Item } from './markdown'
import { over, type Look, type Theme } from './theme'

// MARK: Rows

/** A stretch of text in one look. */
export type Span = { text: string; look: Look }

/** One terminal row, already fitted to the width it was laid out at. */
export type Row = Span[]

// The shape of a reply: what the theme does not pick.
const MARGIN = 2
const CODE = { margin: 2, padX: 2, padY: 1 }
const QUOTE = { bar: '▎', padX: 1 }
const NESTED_LIST_INDENT = 2
const BULLET = '• '
const TASK = { done: '[✓] ', open: '[ ] ' }
const RULE = '--------'
const TABLE = { column: '│', line: '─', cross: '┼', minColumn: 3 }
// A chip's padding is a no-break space, so a wrap never parts it from its code.
const CHIP_PAD = ' '

// MARK: Cell widths

/** Unicode blocks as first and last code point, in hex, by how many cells the terminal gives a character in them. */
const ZERO_WIDTH = blocksOf('0300-036f 200b-200f fe00-fe0f') // combining marks, zero-width spaces and joiners, variation selectors
const DOUBLE_WIDTH = blocksOf(
  // Hangul Jamo, CJK and its symbols, kana, Hangul syllables, compatibility ideographs, CJK forms, fullwidth forms
  '1100-115f 2e80-303e 3041-33ff 3400-4dbf 4e00-9fff a000-a4cf ac00-d7a3 f900-faff fe30-fe4f ff00-ff60 ffe0-ffe6' +
    // emoji and pictographs, then the supplementary ideograph planes
    ' 1f300-1f64f 1f680-1f6ff 1f900-1f9ff 20000-3fffd',
)

function blocksOf(spec: string): { first: number; last: number }[] {
  return spec.split(' ').map(range => {
    const [first = '0', last = first] = range.split('-')
    return { first: Number.parseInt(first, 16), last: Number.parseInt(last, 16) }
  })
}

const within = (blocks: { first: number; last: number }[], point: number) => blocks.some(b => point >= b.first && point <= b.last)

function cellWidth(ch: string): number {
  const point = ch.codePointAt(0) ?? 0
  return within(ZERO_WIDTH, point) ? 0 : within(DOUBLE_WIDTH, point) ? 2 : 1
}

export function widthOf(text: string): number {
  let width = 0
  for (const ch of text) width += cellWidth(ch)
  return width
}

const rowWidth = (row: Row) => row.reduce((sum, span) => sum + widthOf(span.text), 0)

function sameLook(a: Look, b: Look): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Look)[])
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

// Text in the look of the span before it joins that span, so a row is drawn with as few elements as it needs.
function push(row: Row, text: string, look: Look): void {
  if (text === '') return
  const last = row.at(-1)
  if (last !== undefined && sameLook(last.look, look)) last.text += text
  else row.push({ text, look })
}

const blank = (): Row => []
const pad = (width: number, look: Look): Row => (width > 0 ? [{ text: ' '.repeat(width), look }] : [])

function prefixed(rows: Row[], first: Row, rest: Row = first): Row[] {
  return rows.map((row, i) => [...(i === 0 ? first : rest).map(span => ({ ...span })), ...row])
}

// MARK: Wrapping

/** A word, which may run across spans (`foo**bar**`), and the spaces before it. */
type Word = { gap: Span[]; parts: Span[]; width: number }
type Chunk = Word | 'newline'

function chunksOf(spans: Span[]): Chunk[] {
  const chunks: Chunk[] = []
  let gap: Span[] = []
  let word: Word | undefined
  for (const span of spans) {
    for (const piece of span.text.split(/(\n| +)/)) {
      if (piece === '') continue
      if (piece === '\n') {
        chunks.push('newline')
        gap = []
        word = undefined
      } else if (piece.startsWith(' ')) {
        gap.push({ text: piece, look: span.look })
        word = undefined
      } else if (word !== undefined) {
        word.parts.push({ text: piece, look: span.look })
        word.width += widthOf(piece)
      } else {
        word = { gap, parts: [{ text: piece, look: span.look }], width: widthOf(piece) }
        chunks.push(word)
        gap = []
      }
    }
  }
  return chunks
}

/**
 * Fills rows word by word. The spaces where a row breaks go; a word wider than a row is cut across rows. Spaces
 * opening the text or a line it breaks itself are kept (a heading's padding); the ones a wrap lands on are not.
 */
export function flow(spans: Span[], width: number): Row[] {
  const rows: Row[] = [[]]
  let used = 0
  let wrapped = false
  const breakRow = (soft: boolean) => {
    rows.push([])
    used = 0
    wrapped = soft
  }
  for (const chunk of chunksOf(spans)) {
    if (chunk === 'newline') {
      breakRow(false)
      continue
    }
    const row = rows.at(-1) as Row
    const gapWidth = chunk.gap.reduce((sum, span) => sum + widthOf(span.text), 0)
    if (used > 0 && used + gapWidth + chunk.width > width) breakRow(true)
    else if (used > 0 || !wrapped) {
      for (const span of chunk.gap) push(row, span.text, span.look)
      used += gapWidth
    }
    if (used + chunk.width <= width) {
      for (const part of chunk.parts) push(rows.at(-1) as Row, part.text, part.look)
      used += chunk.width
      continue
    }
    for (const part of chunk.parts) {
      for (const ch of part.text) {
        const cells = cellWidth(ch)
        if (used > 0 && used + cells > width) breakRow(true)
        push(rows.at(-1) as Row, ch, part.look)
        used += cells
      }
    }
  }
  return rows
}

// Code keeps its spacing, so a long line is cut at the edge, not at a space.
function chop(row: Row, width: number): Row[] {
  const rows: Row[] = [[]]
  let used = 0
  for (const span of row) {
    for (const ch of span.text) {
      const cells = cellWidth(ch)
      if (used > 0 && used + cells > width) {
        rows.push([])
        used = 0
      }
      push(rows.at(-1) as Row, ch, span.look)
      used += cells
    }
  }
  return rows
}

// Ink counts a tab as one cell, so a tab inside a line reaches the terminal as spaces to the next stop of four.
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (widthOf(out) % 4)) : ch
  return out
}

/** Fills each row to `width` on a background, with `padX` cells either side and `padY` rows above and below. */
function panel(rows: Row[], width: number, padX: number, padY: number, fill: Look): Row[] {
  const empty = Array.from({ length: padY }, blank)
  return [...empty, ...rows, ...empty].map(row => [...pad(padX, fill), ...row, ...pad(width - padX - rowWidth(row), fill)])
}

// MARK: Inlines

function inlineSpans(nodes: Inline[], look: Look, theme: Theme): Span[] {
  const spans: Span[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        spans.push({ text: node.value, look })
        break
      case 'emphasis':
        spans.push(...inlineSpans(node.children, over(look, theme.emph), theme))
        break
      case 'strong':
        spans.push(...inlineSpans(node.children, over(look, theme.strong), theme))
        break
      case 'delete':
        spans.push(...inlineSpans(node.children, over(look, theme.strike), theme))
        break
      case 'inlineCode':
        spans.push({ text: CHIP_PAD + node.value + CHIP_PAD, look: over(look, theme.code) })
        break
      // A link is its text then its URL, which terminals open on click.
      case 'link':
        spans.push(...inlineSpans(node.children, over(look, theme.linkText), theme), { text: ' ', look }, { text: node.url, look: over(look, theme.url) })
        break
      case 'url':
        spans.push({ text: node.url, look: over(look, theme.url) })
        break
      case 'image':
        if (node.alt !== '') spans.push({ text: `Image: ${node.alt} →`, look: over(look, theme.caption) }, { text: ' ', look })
        spans.push({ text: node.url, look: over(look, theme.imageUrl) })
        break
      case 'break':
        spans.push({ text: '\n', look })
        break
    }
  }
  return spans
}

// MARK: Blocks

type Frame = { theme: Theme; width: number; look: Look; nested: boolean }

function stack(blocks: Block[], frame: Frame): Row[] {
  return blocks.flatMap((block, i) => (i === 0 ? blockRows(block, frame) : [blank(), ...blockRows(block, frame)]))
}

function blockRows(block: Block, frame: Frame): Row[] {
  const { theme, width, look } = frame
  switch (block.type) {
    case 'paragraph':
      return flow(inlineSpans(block.children, look, theme), width)
    case 'heading':
      return heading(block, frame)
    case 'code':
      return codeBlock(block, frame)
    case 'blockquote': {
      const inner = over(look, theme.quote)
      const rows = stack(block.children, { ...frame, look: inner, width: Math.max(width - 1 - QUOTE.padX * 2, 1) })
      return prefixed(panel(rows, width - 1, QUOTE.padX, 0, { backgroundColor: inner.backgroundColor }), [{ text: QUOTE.bar, look }])
    }
    case 'list':
      return list(block, frame)
    case 'thematicBreak':
      return [[{ text: RULE, look: over(look, theme.rule) }]]
    case 'table':
      return table(block, frame)
  }
}

function heading(block: Extract<Block, { type: 'heading' }>, { theme, width, look }: Frame): Row[] {
  const paint = over(over(look, theme.heading), theme.headings[block.depth as 1])
  // h1 is a banner padded by a space either side; lower levels keep their hashes.
  const [open, close] = block.depth === 1 ? [' ', ' '] : [`${'#'.repeat(block.depth)} `, '']
  const rows = flow([{ text: open, look: paint }, ...inlineSpans(block.children, paint, theme)], width)
  push(rows.at(-1) as Row, close, paint)
  return rows
}

function codeBlock(block: Extract<Block, { type: 'code' }>, { theme, width, look }: Frame): Row[] {
  const base = over(look, theme.codeBlock)
  const outer = Math.max(width - CODE.margin * 2, 1)
  const padX = Math.min(CODE.padX, Math.floor((outer - 1) / 2))
  const inner = outer - padX * 2
  // Tokens can span lines (a block comment), so each is cut at its newlines into the source lines it covers.
  const lines: Row[] = [[]]
  for (const { text, syntax } of highlight(block.value, block.lang)) {
    const paint = over(base, theme.syntax[syntax])
    for (const [i, part] of text.split('\n').entries()) {
      if (i > 0) lines.push([])
      push(lines.at(-1) as Row, part, paint)
    }
  }
  const rows = lines.flatMap(line => chop(line.map(span => ({ ...span, text: expandTabs(span.text) })), inner))
  return prefixed(panel(rows, outer, padX, CODE.padY, { backgroundColor: base.backgroundColor }), pad(CODE.margin, look))
}

function markerOf(block: Extract<Block, { type: 'list' }>, item: Item, index: number, frame: Frame): Span {
  const look = over(frame.look, frame.theme.marker)
  if (item.checked !== undefined) return { text: item.checked ? TASK.done : TASK.open, look }
  return { text: block.ordered ? `${block.start + index}. ` : BULLET, look }
}

// Code and tables sit a blank row apart from the text around them, even in a tight list.
const standsApart = (block: Block | undefined) => block?.type === 'code' || block?.type === 'table'

function itemRows(item: Item, marker: Span, frame: Frame): Row[] {
  const hang = widthOf(marker.text)
  const rows: Row[] = []
  for (const [i, child] of item.children.entries()) {
    // A nested list keeps its own indent from the list's edge, not from the item's text.
    if (child.type === 'list' && i > 0) {
      rows.push(...blockRows(child, frame))
      continue
    }
    if (i > 0 && (standsApart(child) || standsApart(item.children[i - 1]))) rows.push(blank())
    const body = blockRows(child, { ...frame, width: Math.max(frame.width - hang, 1) })
    rows.push(...prefixed(body, rows.length === 0 ? [marker] : pad(hang, frame.look), pad(hang, frame.look)))
  }
  return rows.length === 0 ? [[marker]] : rows
}

function list(block: Extract<Block, { type: 'list' }>, frame: Frame): Row[] {
  const indent = frame.nested ? NESTED_LIST_INDENT : 0
  const inner = { ...frame, nested: true, width: Math.max(frame.width - indent, 1) }
  const rows = block.items.flatMap((item, i) => {
    const drawn = itemRows(item, markerOf(block, item, i, inner), inner)
    return i > 0 && standsApart(block.items[i - 1]?.children.at(-1)) ? [blank(), ...drawn] : drawn
  })
  return indent === 0 ? rows : prefixed(rows, pad(indent, frame.look))
}

// A table too wide for the row narrows its widest column, a cell at a time, the leftmost first among equals.
function narrowed(columns: number[], room: number): number[] {
  const out = [...columns]
  let excess = out.reduce((sum, w) => sum + w, 0) - room
  while (excess > 0) {
    let widest = 0
    for (let c = 1; c < out.length; c++) if ((out[c] ?? 0) > (out[widest] ?? 0)) widest = c
    if ((out[widest] ?? 0) <= TABLE.minColumn) break
    out[widest] = (out[widest] ?? 0) - 1
    excess--
  }
  return out
}

function aligned(row: Row, width: number, align: Align, look: Look): Row {
  const slack = Math.max(width - rowWidth(row), 0)
  const left = { right: slack, center: slack >> 1, left: 0 }[align ?? 'left']
  return [...pad(left, look), ...row, ...pad(slack - left, look)]
}

// Inner borders only: a cell has a space either side, and a line stands between columns.
function table(block: Extract<Block, { type: 'table' }>, { theme, width, look }: Frame): Row[] {
  const paint = over(look, theme.table)
  const header = block.header.map(cell => inlineSpans(cell, paint, theme))
  const body = block.rows.map(cells => cells.map(cell => inlineSpans(cell, paint, theme)))
  const natural = block.align.map((_, c) => Math.max(1, ...[header, ...body].map(cells => rowWidth(cells[c] ?? []))))
  const widths = narrowed(natural, width - (block.align.length * 3 - 1))
  const line = (cells: Span[][]): Row[] => {
    const wrapped = widths.map((w, c) => flow(cells[c] ?? [], w))
    const height = Math.max(...wrapped.map(rows => rows.length))
    return Array.from({ length: height }, (_, r) => {
      const row: Row = []
      widths.forEach((w, c) => {
        if (c > 0) push(row, TABLE.column, paint)
        for (const span of [{ text: ' ', look: paint }, ...aligned(wrapped[c]?.[r] ?? [], w, block.align[c], paint), { text: ' ', look: paint }]) {
          push(row, span.text, span.look)
        }
      })
      return row
    })
  }
  const rule = widths.map(w => TABLE.line.repeat(w + 2)).join(TABLE.cross)
  return [...line(header), [{ text: rule, look: paint }], ...body.flatMap(line)]
}

// MARK: Reply

/** Lays a parsed reply out at `columns` cells wide, inside the document margin on each side. */
export function render(blocks: Block[], theme: Theme, columns: number): Row[] {
  const rows = stack(blocks, { theme, width: Math.max(columns - MARGIN * 2, 1), look: theme.text, nested: false })
  return prefixed(rows, pad(MARGIN, {}))
}
