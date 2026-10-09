// MARK: Tree

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'emphasis' | 'strong' | 'delete'; children: Inline[] }
  | { type: 'inlineCode'; value: string }
  | { type: 'link'; url: string; children: Inline[] }
  /** A URL written as itself, bare or in angle brackets. */
  | { type: 'url'; url: string }
  | { type: 'image'; url: string; alt: string }
  | { type: 'break' }

export type Align = 'left' | 'center' | 'right' | undefined

/** `checked` is set on a task item (`- [x] done`) only. */
export type Item = { checked?: boolean; children: Block[] }

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; depth: number; children: Inline[] }
  | { type: 'code'; lang: string; value: string }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Item[] }
  | { type: 'thematicBreak' }
  | { type: 'table'; align: Align[]; header: Inline[][]; rows: Inline[][][] }

/** Reads a reply as CommonMark with GitHub's tables, task items, strikethrough and bare URLs. */
export function parse(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map(tabsToSpaces)
  return new BlockReader(lines).blocks()
}

// MARK: Line shapes

const OPEN_FENCE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})\s*(\S*)/
const ATX_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)$/
const BREAK_LINE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/
const QUOTE_LINE = /^ {0,3}>( ?)/
const ITEM_LINE = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))(?=\s|$)( *)/
const UNDERLINE = /^ {0,3}(?:(=+)|-+)\s*$/
const TABLE_DELIMITERS = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/

const isBlank = (line: string | undefined) => line === undefined || line.trim() === ''
const indentOf = (line: string) => line.length - line.trimStart().length
const unindent = (line: string, columns: number) => line.slice(Math.min(columns, indentOf(line)))

// Ink counts a tab as one cell, so indentation reaches the layout as spaces to the next stop of four.
function tabsToSpaces(line: string): string {
  const lead = /^[ \t]*/.exec(line)?.[0] ?? ''
  if (!lead.includes('\t')) return line
  let column = 0
  for (const ch of lead) column = ch === '\t' ? column - (column % 4) + 4 : column + 1
  return ' '.repeat(column) + line.slice(lead.length)
}

type ItemStart = { bullet?: string; number?: number; delimiter?: string; content: number; rest: string }

function itemStart(line: string): ItemStart | undefined {
  const m = ITEM_LINE.exec(line)
  if (m === null) return undefined
  const [whole, , bullet, digits, delimiter, gap = ''] = m
  const empty = line.slice(whole.length).trim() === ''
  // Content starts one space after the marker when the gap is wide (an indented code line) or the item is empty.
  const content = gap.length === 0 || gap.length > 4 || empty ? whole.length - gap.length + 1 : whole.length
  return {
    ...(bullet !== undefined && { bullet }),
    ...(digits !== undefined && { number: Number(digits), delimiter }),
    content,
    rest: empty ? '' : line.slice(content),
  }
}

// A line that ends the paragraph above it without a blank line between.
function interrupts(line: string): boolean {
  if (OPEN_FENCE.test(line) || ATX_HEADING.test(line) || BREAK_LINE.test(line) || QUOTE_LINE.test(line)) return true
  const item = itemStart(line)
  return item !== undefined && item.rest.trim() !== ''
}

function splitRow(row: string): string[] {
  let body = row.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cell += '|'
      i++
    } else if (body[i] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += body[i]
  }
  cells.push(cell.trim())
  return cells
}

function alignOf(delimiter: string): Align {
  const left = delimiter.startsWith(':')
  const right = delimiter.endsWith(':')
  if (left && right) return 'center'
  return right ? 'right' : left ? 'left' : undefined
}

// A table needs a header row and a delimiter row under it with as many cells.
function tableHead(lines: string[], at: number): Align[] | undefined {
  const head = lines[at]
  const delimiters = lines[at + 1]
  if (head === undefined || delimiters === undefined || !head.includes('|') || !TABLE_DELIMITERS.test(delimiters)) return undefined
  const align = splitRow(delimiters).map(alignOf)
  return splitRow(head).length === align.length ? align : undefined
}

// MARK: Blocks

class BlockReader {
  private at = 0

  constructor(private readonly lines: string[]) {}

  blocks(): Block[] {
    const out: Block[] = []
    while (this.at < this.lines.length) {
      if (isBlank(this.line)) this.at++
      else out.push(this.block())
    }
    return out
  }

  private get line(): string {
    return this.lines[this.at] ?? ''
  }

  private block(): Block {
    return this.fence() ?? this.atxHeading() ?? this.thematicBreak() ?? this.quote() ?? this.list() ?? this.table() ?? this.paragraph()
  }

  private fence(): Block | undefined {
    const open = OPEN_FENCE.exec(this.line)
    if (open === null) return undefined
    const [, lead = '', marker = '', lang = ''] = open
    const closes = (line: string) => {
      const trimmed = line.trim()
      return indentOf(line) < 4 && trimmed.length >= marker.length && trimmed === (marker[0] ?? '').repeat(trimmed.length)
    }
    const body: string[] = []
    // A reply still streaming has no closing fence yet: the rest of it is the code.
    for (this.at++; this.at < this.lines.length; this.at++) {
      if (closes(this.line)) {
        this.at++
        break
      }
      body.push(unindent(this.line, lead.length))
    }
    return { type: 'code', lang, value: body.join('\n') }
  }

  private atxHeading(): Block | undefined {
    const m = ATX_HEADING.exec(this.line)
    if (m === null) return undefined
    this.at++
    // A closing run of hashes is decoration.
    const title = (m[2] ?? '').trim().replace(/(?:^|\s+)#+$/, '')
    return { type: 'heading', depth: (m[1] ?? '#').length, children: parseInline(title) }
  }

  private thematicBreak(): Block | undefined {
    if (!BREAK_LINE.test(this.line)) return undefined
    this.at++
    return { type: 'thematicBreak' }
  }

  private quote(): Block | undefined {
    if (!QUOTE_LINE.test(this.line)) return undefined
    const inner: string[] = []
    for (; this.at < this.lines.length; this.at++) {
      const line = this.line
      const marker = QUOTE_LINE.exec(line)
      if (marker !== null) inner.push(line.slice(marker[0].length))
      // A lazy line carries on the quoted paragraph without a `>` of its own.
      else if (!isBlank(line) && !isBlank(inner.at(-1)) && !interrupts(line)) inner.push(line)
      else break
    }
    return { type: 'blockquote', children: new BlockReader(inner).blocks() }
  }

  private list(): Block | undefined {
    const first = itemStart(this.line)
    if (first === undefined) return undefined
    const sameList = (next: ItemStart) =>
      first.bullet !== undefined ? next.bullet === first.bullet : next.delimiter === first.delimiter
    const items: Item[] = []
    let next: ItemStart | undefined = first
    while (next !== undefined && sameList(next)) {
      const { content } = next
      const body = [next.rest]
      for (this.at++; this.at < this.lines.length; this.at++) {
        const line = this.line
        if (isBlank(line)) body.push('')
        else if (indentOf(line) >= content) body.push(line.slice(content))
        else if (!isBlank(body.at(-1)) && !interrupts(line) && itemStart(line) === undefined) body.push(line.trim())
        else break
      }
      items.push(taskOf(body))
      next = this.at < this.lines.length ? itemStart(this.line) : undefined
    }
    return { type: 'list', ordered: first.number !== undefined, start: first.number ?? 1, items }
  }

  private table(): Block | undefined {
    const align = tableHead(this.lines, this.at)
    if (align === undefined) return undefined
    const header = splitRow(this.line).map(parseInline)
    const rows: Inline[][][] = []
    for (this.at += 2; this.at < this.lines.length; this.at++) {
      const line = this.line
      if (isBlank(line) || !line.includes('|') || interrupts(line)) break
      const cells = splitRow(line)
      rows.push(align.map((_, c) => parseInline(cells[c] ?? '')))
    }
    return { type: 'table', align, header, rows }
  }

  private paragraph(): Block {
    const text = [this.line.trimStart()]
    for (this.at++; this.at < this.lines.length; this.at++) {
      const line = this.line
      if (isBlank(line)) break
      const underline = UNDERLINE.exec(line)
      if (underline !== null) {
        this.at++
        return { type: 'heading', depth: underline[1] === undefined ? 2 : 1, children: parseInline(text.join('\n').trim()) }
      }
      if (interrupts(line) || tableHead(this.lines, this.at) !== undefined) break
      text.push(line.trimStart())
    }
    // Trailing spaces inside the paragraph stay: two of them before a newline are a hard break.
    return { type: 'paragraph', children: parseInline(text.join('\n').trimEnd()) }
  }
}

function taskOf(body: string[]): Item {
  const box = /^\[([ xX])\](?=\s|$)\s*/.exec(body[0] ?? '')
  if (box === null) return { children: new BlockReader(body).blocks() }
  const rest = [(body[0] ?? '').slice(box[0].length), ...body.slice(1)]
  return { checked: box[1] !== ' ', children: new BlockReader(rest).blocks() }
}

// MARK: Inlines

/** A run of `*`, `_` or `~` that becomes emphasis once a partner run is found; `left` is what pairing left of it. */
type Run = { type: 'run'; char: string; size: number; left: number; opens: boolean; closes: boolean }
type Piece = Inline | Run

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/
const UNICODE_PUNCTUATION = /^[\p{P}\p{S}]$/u
const ENTITY = /^&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z]+));/
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const ANGLE_AUTOLINK = /^<([a-zA-Z][\w+.-]{1,31}:[^\s<>]*|[\w.!#$%&'*+/=?^`{|}~-]+@[a-zA-Z\d](?:[a-zA-Z\d.-]*[a-zA-Z\d])?)>/
const BARE = /^(?:https?:\/\/|www\.)[^\s<]+/
const LINK_TARGET =
  /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*))(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?\s*\)/

export function parseInline(source: string): Inline[] {
  return new InlineScanner(source).scan()
}

class InlineScanner {
  private pos = 0
  private pieces: Piece[] = []
  private buffer = ''

  constructor(private readonly src: string) {}

  scan(): Inline[] {
    while (this.pos < this.src.length) {
      if (!this.special()) this.buffer += this.src[this.pos++]
    }
    this.flush()
    return pairRuns(this.pieces)
  }

  private flush(): void {
    if (this.buffer !== '') this.pieces.push({ type: 'text', value: this.buffer })
    this.buffer = ''
  }

  private emit(node: Piece, length: number): true {
    this.flush()
    this.pieces.push(node)
    this.pos += length
    return true
  }

  private literal(text: string, length: number): true {
    this.buffer += text
    this.pos += length
    return true
  }

  /** Reads a construct at the cursor and moves past it, or returns false to have the character read as text. */
  private special(): boolean {
    const ch = this.src[this.pos] ?? ''
    const rest = this.src.slice(this.pos)
    switch (ch) {
      case '\\':
        if (rest[1] === '\n') return this.emit({ type: 'break' }, 2)
        return ASCII_PUNCTUATION.test(rest[1] ?? '') && this.literal(rest[1] ?? '', 2)
      case '`':
        return this.codeSpan()
      case '!':
        return rest[1] === '[' && this.link(this.pos + 1, true)
      case '[':
        return this.link(this.pos, false)
      case '<': {
        const m = ANGLE_AUTOLINK.exec(rest)
        return m !== null && this.emit({ type: 'url', url: m[1] ?? '' }, m[0].length)
      }
      case '*':
      case '_':
      case '~':
        return this.run(ch)
      case '\n':
        return this.newline()
      case '&': {
        const decoded = decodeEntity(rest)
        return decoded !== undefined && this.literal(decoded.text, decoded.length)
      }
      case 'h':
      case 'w':
        return this.bareUrl(rest)
      default:
        return false
    }
  }

  private codeSpan(): boolean {
    let end = this.pos
    while (this.src[end] === '`') end++
    const ticks = end - this.pos
    const close = matchingTicks(this.src, end, ticks)
    // An unmatched run is literal backticks, all of it, so a shorter run inside it cannot open.
    if (close === -1) return this.literal('`'.repeat(ticks), ticks)
    let value = this.src.slice(end, close).replace(/\n/g, ' ')
    if (value.length > 1 && value.startsWith(' ') && value.endsWith(' ') && value.trim() !== '') value = value.slice(1, -1)
    return this.emit({ type: 'inlineCode', value }, close + ticks - this.pos)
  }

  private link(open: number, image: boolean): boolean {
    const close = closingBracket(this.src, open)
    if (close === -1) return false
    const target = LINK_TARGET.exec(this.src.slice(close + 1))
    if (target === null) return false
    const label = parseInline(this.src.slice(open + 1, close))
    const url = (target[1] ?? target[2] ?? '').replace(/\\([!-/:-@[-`{-~])/g, '$1')
    const node: Inline = image ? { type: 'image', url, alt: toPlainText(label) } : { type: 'link', url, children: label }
    return this.emit(node, close + 1 + target[0].length - this.pos)
  }

  private run(char: string): boolean {
    let end = this.pos
    while (this.src[end] === char) end++
    const size = end - this.pos
    const sides = flanking(char, this.src[this.pos - 1] ?? ' ', this.src[end] ?? ' ')
    return this.emit({ type: 'run', char, size, left: size, ...sides }, size)
  }

  private newline(): boolean {
    // Two spaces before a newline are a hard break; otherwise the lines flow on with one space.
    const hard = this.buffer.endsWith('  ')
    this.buffer = this.buffer.replace(/ +$/, '')
    if (hard) {
      this.flush()
      this.pieces.push({ type: 'break' })
    } else this.buffer += ' '
    this.pos++
    while (this.src[this.pos] === ' ') this.pos++
    return true
  }

  private bareUrl(rest: string): boolean {
    const before = this.src[this.pos - 1]
    if (before !== undefined && !/[\s*_~(]/.test(before)) return false
    const m = BARE.exec(rest)
    const url = m === null ? '' : trimUrl(m[0])
    return url !== '' && this.emit({ type: 'url', url }, url.length)
  }
}

// MARK: Inline helpers

// Where a run of exactly `length` backticks starts at or after `from`; -1 when none does.
function matchingTicks(src: string, from: number, length: number): number {
  let i = from
  while (i < src.length) {
    if (src[i] !== '`') {
      i++
      continue
    }
    let end = i
    while (src[end] === '`') end++
    if (end - i === length) return i
    i = end
  }
  return -1
}

// The `]` that closes the label opened at `open`, past escapes, code spans and nested brackets; -1 when none does.
function closingBracket(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') i++
    else if (ch === '`') {
      let end = i
      while (src[end] === '`') end++
      const close = matchingTicks(src, end, end - i)
      i = (close === -1 ? end : close + (end - i)) - 1
    } else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return i
  }
  return -1
}

// A URL stops before the sentence's punctuation, and keeps a closing paren only when it opened one.
function trimUrl(raw: string): string {
  let url = raw
  for (;;) {
    const trimmed = url.replace(/[?!.,:;*_~'"]+$/, '')
    const unbalanced = trimmed.endsWith(')') && trimmed.split(')').length > trimmed.split('(').length
    const next = unbalanced ? trimmed.slice(0, -1) : trimmed
    if (next === url) return url
    url = next
  }
}

function decodeEntity(rest: string): { text: string; length: number } | undefined {
  const m = ENTITY.exec(rest)
  if (m === null) return undefined
  const [whole, decimal, hex, name] = m
  if (name !== undefined) {
    const text = NAMED[name]
    return text === undefined ? undefined : { text, length: whole.length }
  }
  const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16)
  return code > 0 && code <= 0x10ffff ? { text: String.fromCodePoint(code), length: whole.length } : undefined
}

function flanking(char: string, before: string, after: string): { opens: boolean; closes: boolean } {
  const spaceBefore = /\s/.test(before)
  const spaceAfter = /\s/.test(after)
  const punctBefore = UNICODE_PUNCTUATION.test(before)
  const punctAfter = UNICODE_PUNCTUATION.test(after)
  const left = !spaceAfter && (!punctAfter || spaceBefore || punctBefore)
  const right = !spaceBefore && (!punctBefore || spaceAfter || punctAfter)
  // `_` never opens or closes inside a word, so snake_case stays plain.
  if (char === '_') return { opens: left && (!right || punctBefore), closes: right && (!left || punctAfter) }
  return { opens: left, closes: right }
}

const isRun = (piece: Piece | undefined): piece is Run => piece?.type === 'run'

function canPair(opener: Run, closer: Run): boolean {
  if (opener.char !== closer.char || !opener.opens || opener.left === 0) return false
  if (closer.char === '~') return opener.left === closer.left && closer.left <= 2
  // The rule of three keeps `*a**b*` from pairing the wrong runs.
  const either = opener.closes || closer.opens
  return !(either && (opener.size + closer.size) % 3 === 0 && (opener.size % 3 !== 0 || closer.size % 3 !== 0))
}

/** Pairs runs into emphasis, strong and strikethrough, each closer with the nearest opener before it. */
function pairRuns(pieces: Piece[]): Inline[] {
  let i = 0
  while (i < pieces.length) {
    const closer = pieces[i]
    if (!isRun(closer) || !closer.closes || closer.left === 0) {
      i++
      continue
    }
    let j = i - 1
    while (j >= 0 && !(isRun(pieces[j]) && canPair(pieces[j] as Run, closer))) j--
    if (j < 0) {
      i++
      continue
    }
    const opener = pieces[j] as Run
    const used = closer.char === '~' ? closer.left : opener.left >= 2 && closer.left >= 2 ? 2 : 1
    const type = closer.char === '~' ? 'delete' : used === 2 ? 'strong' : 'emphasis'
    opener.left -= used
    closer.left -= used
    pieces.splice(j + 1, i - j - 1, { type, children: settle(pieces.slice(j + 1, i)) })
    i = j + 2
    if (opener.left === 0) {
      pieces.splice(j, 1)
      i--
    }
    // A closer with characters left may close an earlier opener too, so it is read again.
    if (closer.left === 0) pieces.splice(i, 1)
  }
  return settle(pieces)
}

// Runs that found no partner are text again, joined to the text either side.
function settle(pieces: Piece[]): Inline[] {
  const out: Inline[] = []
  for (const piece of pieces) {
    const node: Inline = isRun(piece) ? { type: 'text', value: piece.char.repeat(piece.left) } : piece
    if (node.type === 'text' && node.value === '') continue
    const last = out.at(-1)
    if (node.type === 'text' && last?.type === 'text') out[out.length - 1] = { type: 'text', value: last.value + node.value }
    else out.push(node)
  }
  return out
}

/** The words a reader sees, without styling: link labels, image alt text and URLs written as themselves. */
export function toPlainText(nodes: Inline[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text' || node.type === 'inlineCode') out += node.value
    else if (node.type === 'url') out += node.url
    else if (node.type === 'image') out += node.alt
    else if (node.type === 'break') out += '\n'
    else out += toPlainText(node.children)
  }
  return out
}
