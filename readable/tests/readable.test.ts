import { expect, mock, test, type TestBody } from 'claude-code/testing'
import { highlight } from '../hooks/highlight'
import { parse } from '../hooks/markdown'
import { claudeCodeTheme, contrast, fromPalette, mix, parseGhosttyConfig, parseRexCustomTheme, parseRexTheme, rexThemeId } from '../hooks/theme'

// MARK: Harness

type Engine = Parameters<TestBody>[0]
type Element = { type: string; props?: Record<string, unknown>; children?: unknown[] }
type Leaf = { text: string; props: Record<string, unknown> }

const COLUMNS = 80
// What a reply's rows may fill: the viewport less the engine's edge columns and readable's margins.
const TEXT_WIDTH = COLUMNS - 2 - 4
const NBSP = ' '

// The innermost Texts, the ones holding only strings, in drawing order.
function leaves(node: unknown, out: Leaf[] = []): Leaf[] {
  const element = node as Element | null
  if (element?.type === undefined) return out
  const kids = element.children ?? []
  const strings = kids.filter((kid): kid is string => typeof kid === 'string')
  if (element.type === 'Text' && strings.length === kids.length) out.push({ text: strings.join(''), props: element.props ?? {} })
  else for (const kid of kids) leaves(kid, out)
  return out
}

const textOf = (node: unknown) => leaves(node).map(leaf => leaf.text).join('')
const find = (node: unknown, text: string) => leaves(node).find(leaf => leaf.text.includes(text))
// The Texts the layout places (not the spans inside them), in drawing order.
function texts(node: unknown, out: Element[] = []): Element[] {
  const element = node as Element | null
  if (element?.type === 'Text') out.push(element)
  else for (const kid of element?.children ?? []) texts(kid, out)
  return out
}
// The lines of each Text, split at its newline strings; each line comes back as a Box of its spans.
function rowsOf(root: Element): Element[] {
  return texts(root).flatMap(text => {
    const rows: Element[] = [{ type: 'Box', children: [] }]
    for (const kid of text.children ?? []) {
      if (kid === '\n') rows.push({ type: 'Box', children: [] })
      else rows.at(-1)?.children?.push(kid)
    }
    return rows
  })
}

// MARK: Screen

// A stand-in for the engine's layout and mouse selection, enough for a reply's shape: Boxes in a row or a column,
// padding, margins and fixed widths, and Texts wrapped at spaces. A row the engine wraps a line onto records the
// column its text starts at; the selection starts that row there and joins it to the row above, with the space the
// wrap took. Every other row is copied from the left edge, the margin's blank cells as spaces, trailing space trimmed.
type Wrap = { at: number; space: boolean }
type Screen = { rows: string[]; wraps: (Wrap | undefined)[] }

const blankRows = (count: number): Screen => ({ rows: Array<string>(count).fill(''), wraps: Array<undefined>(count).fill(undefined) })

function wrapLine(line: string, width: number, screen: Screen): void {
  let row = ''
  let wrap: Wrap | undefined
  const close = (next: Wrap) => {
    screen.rows.push(row)
    screen.wraps.push(wrap)
    row = ''
    wrap = next
  }
  // Words at even places, the spaces between them at odd ones.
  const pieces = line.split(/( +)/)
  for (const [i, piece] of pieces.entries()) {
    if (piece === '' || i % 2 === 1) continue
    const gap = pieces[i - 1] ?? ''
    if (row !== '' && row.length + gap.length + piece.length > width) close({ at: 0, space: true })
    else if (row !== '' || wrap === undefined) row += gap
    for (const ch of piece) {
      if (row.length >= width) close({ at: 0, space: false })
      row += ch
    }
  }
  close({ at: 0, space: true })
}

function shifted(screen: Screen, x: number, width: number): Screen {
  return { rows: screen.rows.map(row => ' '.repeat(x) + row.padEnd(width - x)), wraps: screen.wraps.map(w => w && { ...w, at: w.at + x }) }
}

function paint(node: unknown, width: number): Screen {
  const element = node as Element
  const props = element.props ?? {}
  if (element.type === 'Text' || element.type === 'Button') {
    const screen: Screen = { rows: [], wraps: [] }
    const text = element.type === 'Button' ? String(props.label) : (element.children ?? []).map(kid => (typeof kid === 'string' ? kid : textOf(kid))).join('')
    for (const line of text.split('\n')) wrapLine(line, width, screen)
    return screen
  }
  const num = (key: string) => (typeof props[key] === 'number' ? (props[key] as number) : 0)
  const left = num('paddingLeft') + num('paddingX')
  const inner = Math.max((typeof props.width === 'number' ? props.width : width) - left - num('paddingRight') - num('paddingX'), 1)
  const kids = (element.children ?? []).filter((kid): kid is Element => typeof kid === 'object')
  let body: Screen
  if (props.flexDirection === 'column') {
    body = { rows: [], wraps: [] }
    for (const kid of kids) {
      const painted = paint(kid, inner)
      body.rows.push(...painted.rows)
      body.wraps.push(...painted.wraps)
    }
  } else {
    // A row: children with a width keep it, the rest share what is left.
    const fixed = kids.reduce((sum, kid) => sum + (typeof kid.props?.width === 'number' ? (kid.props.width as number) : 0), 0)
    const flexible = kids.filter(kid => typeof kid.props?.width !== 'number').length
    let x = 0
    body = blankRows(0)
    for (const kid of kids) {
      const w = typeof kid.props?.width === 'number' ? (kid.props.width as number) : Math.max(Math.floor((inner - fixed) / Math.max(flexible, 1)), 1)
      const painted = paint(kid, w)
      for (let r = 0; r < painted.rows.length; r++) {
        body.rows[r] = (body.rows[r] ?? '').padEnd(x) + (painted.rows[r] ?? '')
        const wrap = painted.wraps[r]
        body.wraps[r] = wrap ? { ...wrap, at: wrap.at + x } : body.wraps[r]
      }
      x += w
    }
    body.wraps = Array.from({ length: body.rows.length }, (_, r) => body.wraps[r])
  }
  const top = blankRows(num('marginTop'))
  const bottom = blankRows(num('marginBottom'))
  const placed = shifted(body, left, width)
  return { rows: [...top.rows, ...placed.rows, ...bottom.rows], wraps: [...top.wraps, ...placed.wraps, ...bottom.wraps] }
}

/** What dragging the mouse over the whole reply copies, as the engine's selection reads the screen. */
function selected(screen: Screen): string {
  const lines: string[] = []
  screen.rows.forEach((row, r) => {
    const wrap = screen.wraps[r]
    const text = (wrap ? row.slice(wrap.at) : row).trimEnd()
    if (wrap && lines.length > 0) lines[lines.length - 1] += (wrap.space ? ' ' : '') + text
    else lines.push(text)
  })
  return lines.join('\n')
}

// The reply's rows, without the blank row it keeps above and below; the engine keeps a column clear at each edge.
const screenOf = (root: Element, columns = COLUMNS) => paint({ ...root, props: { ...root.props, marginTop: 0, marginBottom: 0 } }, columns - 2)

async function reply($: Engine, text: unknown, props: Record<string, unknown> = {}, columns = COLUMNS): Promise<Element> {
  const ui = await $.ui.mount({
    plugin: 'readable',
    surface: (props.surface as 'terminal' | 'desktop' | undefined) ?? 'terminal',
    component: 'AssistantMessage',
    props: { text, isFirstOfReply: false, ...props } as never,
    viewport: { columns, rows: 40 },
  })
  return (await ui.drawn()) as Element
}

/** A reply's rows as the terminal shows them, trailing space trimmed. */
async function lines($: Engine, text: string, props: Record<string, unknown> = {}): Promise<string[]> {
  return screenOf(await reply($, text, props)).rows.map(row => row.trimEnd())
}

/** What selecting the whole reply with the mouse copies. */
async function selectedText($: Engine, text: string, props: Record<string, unknown> = {}, columns = COLUMNS): Promise<string> {
  return selected(screenOf(await reply($, text, props, columns), columns))
}

async function prompt($: Engine, text = 'make it blue', kind = 'composer', isExpanded = true): Promise<Element> {
  const ui = await $.ui.mount({
    plugin: 'readable',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text, origin: { kind }, isExpanded } as never,
    viewport: { columns: COLUMNS, rows: 40 },
  })
  return (await ui.drawn()) as Element
}

const engineDraws = (on: Parameters<TestBody>[1]) => on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))

// A panel row: margins first with no background, then nothing but the panel's background to the row's end.
function onPanel(row: unknown, background: string): boolean {
  const spans = leaves(row)
  const start = spans.findIndex(leaf => leaf.props.backgroundColor !== undefined)
  return start > 0 && spans.slice(start).every(leaf => leaf.props.backgroundColor === background)
}

// MARK: Reply frame

test('sets a reply inside a two-cell margin, the first message of a reply under the engine’s bullet', async $ => {
  expect(await lines($, 'Hello there.', { isFirstOfReply: true })).toEqual(['● Hello there.'])
  expect(await lines($, 'Hello there.')).toEqual(['  Hello there.'])
})

test('paints prose in the theme’s text colour, a blank row above and below the reply', async $ => {
  const root = await reply($, 'Hello there.')
  expect(find(root, 'Hello')?.props.color).toBe('#cbe3e7')
  expect(root.props).toMatchObject({ marginTop: 1, marginBottom: 1 })
})

test('wraps prose inside both margins and wraps again at a narrower width', async $ => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}x`).join(' ')
  const wide = await lines($, words)
  expect(wide.length).toBeGreaterThan(1)
  for (const row of wide) {
    expect(row.startsWith('  ')).toBe(true)
    expect(row.length).toBeLessThanOrEqual(2 + TEXT_WIDTH)
  }
  expect(screenOf(await reply($, words, {}, 40), 40).rows.length).toBeGreaterThan(wide.length)
})

test('leaves prose for the engine to wrap, so a selection copies a paragraph back as one line', async $ => {
  const words = Array.from({ length: 40 }, (_, i) => `w${i}x`).join(' ')
  // One line in the Text however narrow the terminal: the engine wraps it, and knows the rows it wrapped onto.
  expect(rowsOf(await reply($, words, {}, 40)).map(textOf)).toEqual([words])
  expect(await selectedText($, `${words}\n\nNext.`, {}, 40)).toBe(`  ${words}\n\n  Next.`)
})

test('puts one blank row between blocks, a run of them in one Text', async $ => {
  expect(await lines($, 'One.\n\nTwo.')).toEqual(['  One.', '', '  Two.'])
  expect(texts(await reply($, '# A\n\nOne.\n\n```\nx\n```'))).toHaveLength(1)
})

// MARK: Headings and inlines

test('draws h1 as a banner and lower headings with their hashes', async $ => {
  const root = await reply($, '# Title\n\n## Section\n\n###### Small')
  expect(find(root, 'Title')).toEqual({ text: ' Title ', props: expect.objectContaining({ color: '#171527', backgroundColor: '#a37acc', bold: true }) })
  expect(find(root, 'Section')).toEqual({ text: '## Section', props: expect.objectContaining({ color: '#d4bfff', bold: true }) })
  expect(find(root, 'Small')?.props).toMatchObject({ color: '#8a889d', bold: false })
})

test('keeps a heading on one row though it holds two sentences', async $ => {
  expect(await lines($, '## Step one. Then two')).toEqual(['  ## Step one. Then two'])
})

test('styles emphasis, strong, strikethrough and inline code chips', async $ => {
  const root = await reply($, 'an *em* a **strong** a ~~gone~~ a `code` end')
  expect(find(root, 'em')?.props.italic).toBe(true)
  expect(find(root, 'strong')?.props).toMatchObject({ bold: true, color: '#eef6f7' })
  expect(find(root, 'gone')?.props.strikethrough).toBe(true)
  expect(find(root, 'code')).toEqual({ text: `${NBSP}code${NBSP}`, props: expect.objectContaining({ color: '#a1efd3', backgroundColor: '#2d2b40' }) })
})

test('prints a link as its text and then its URL, once, with no Link element', async $ => {
  const root = await reply($, 'see [the docs](https://example.com/docs) now')
  expect(textOf(root)).toContain('see the docs https://example.com/docs now')
  expect(find(root, 'the docs')?.props).toMatchObject({ color: '#d4bfff', bold: true })
  expect(find(root, 'https://example.com/docs')?.props).toMatchObject({ color: '#87dfeb', underline: true })
  expect(JSON.stringify(root)).not.toContain('"type":"Link"')
})

test('fits a long URL inside the row', async $ => {
  const url = 'https://claude.ai/code/artifact/6dafbde9-63c6-488a-b0be-8ac052ec3af0'
  const rows = await lines($, `I've expanded section 2 of [How we build with Claude](${url}) today.`)
  expect(rows.join('\n').split(url).length).toBe(2)
  for (const row of rows) expect(row.length).toBeLessThanOrEqual(COLUMNS - 2)
})

test('colours a bare URL and stops it before the sentence’s full stop', async $ => {
  const root = await reply($, 'Open https://example.com/a_(b). Then go')
  expect(find(root, 'https://example.com/a_(b)')).toEqual({ text: 'https://example.com/a_(b)', props: expect.objectContaining({ color: '#87dfeb' }) })
})

test('draws an image as a caption and its URL', async $ => {
  const root = await reply($, '![a cat](https://example.com/cat.png)')
  expect(textOf(root)).toContain('Image: a cat → https://example.com/cat.png')
  expect(find(root, 'Image: a cat')?.props.color).toBe('#8a889d')
  expect(find(root, 'cat.png')?.props).toMatchObject({ color: '#f48fb1', underline: true })
})

// MARK: Lists

test('marks bullets, numbers and tasks, and indents a nested list', async $ => {
  expect(await lines($, '- one\n  - inner\n- two\n\n3. third\n4. fourth\n\n- [x] done\n- [ ] todo')).toEqual([
    '  - one',
    '    - inner',
    '  - two',
    '',
    '  3. third',
    '  4. fourth',
    '',
    '  [✓] done',
    '  [ ] todo',
  ])
})

test('hangs a wrapped item’s text under its first word', async $ => {
  const rows = await lines($, `- ${'word '.repeat(30)}`)
  expect(rows[0]?.startsWith('  - word')).toBe(true)
  expect(rows[1]?.startsWith('    word')).toBe(true)
})

test('copies a list as Markdown: dashes, two spaces a level, each item one line', async $ => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')
  expect(await selectedText($, `- ${long}\n  - inner ${long}\n- two\n\n1. first`)).toBe(
    [`  - ${long}`, `    - inner ${long}`, '  - two', '', '  1. first'].join('\n'),
  )
})

test('gives a list item’s marker a column of its own, beside one Text the engine wraps', async $ => {
  const root = await reply($, '- one. Two')
  const marker = find(root, '- ')
  expect(marker?.props.color).toBe('#a37acc')
  // The marker's Box keeps its width however long the item, so the wrapped rows start under the text.
  expect(JSON.stringify(root)).toContain('"width":2,"flexShrink":0')
  const content = (text: Element) => (text.children ?? []).map(kid => (typeof kid === 'string' ? kid : textOf(kid))).join('')
  expect(texts(root).map(content)).toEqual(['- ', 'one.\nTwo'])
})

test('sets a table inside a list item a blank row apart from the text and the next item', async $ => {
  expect(await lines($, '- Since:\n\n  | A | B |\n  | - | - |\n  | 1 | 2 |\n- Next')).toEqual([
    '  - Since:',
    '',
    '     A │ B',
    '    ───┼───',
    '     1 │ 2',
    '',
    '  - Next',
  ])
})

// MARK: Quotes, rules and tables

test('bars a quote and joins its lines', async $ => {
  expect(await lines($, '> quoted\n> words')).toEqual(['  ▎ quoted words', '    copy'])
})

test('fills a quote panel to the text width, its blank rows too', async $ => {
  const root = await reply($, '> one\n>\n> two')
  expect(rowsOf(root).map(row => textOf(row).length)).toEqual([TEXT_WIDTH, TEXT_WIDTH, TEXT_WIDTH])
  for (const row of rowsOf(root)) expect(onPanel(row, '#262439')).toBe(true)
})

test('rules a thematic break in the border colour', async $ => {
  const root = await reply($, 'above\n\n***\n\nbelow')
  expect(await lines($, 'above\n\n***\n\nbelow')).toEqual(['  above', '', '  --------', '', '  below'])
  expect(find(root, '--------')?.props.color).toBe('#3e3859')
})

test('lays a table out with inner borders, aligned per column', async $ => {
  expect(await lines($, '| Name | Qty |\n| :--- | ---: |\n| apple | 3 |\n| kiwi | 12 |')).toEqual([
    '   Name  │ Qty',
    '  ───────┼─────',
    '   apple │   3',
    '   kiwi  │  12',
  ])
})

// MARK: Code blocks

test('puts a code block on a panel with a row above and below and two cells either side', async $ => {
  const root = await reply($, '```\nx\n```')
  expect(await lines($, '```\nx\n```')).toEqual(['', '      x', '', '    copy'])
  // The block's margin is two cells on the right as on the left.
  expect(rowsOf(root).map(row => textOf(row).length)).toEqual([TEXT_WIDTH - 2, TEXT_WIDTH - 2, TEXT_WIDTH - 2])
  for (const row of rowsOf(root)) expect(onPanel(row, '#171527')).toBe(true)
})

test('highlights code by its fence language, tabs drawn as spaces', async $ => {
  const root = await reply($, '```go\nfunc main() {\n\treturn "hi"\n}\n```')
  expect(await lines($, '```go\nfunc main() {\n\treturn "hi"\n}\n```')).toEqual(['', '      func main() {', '          return "hi"', '      }', '', '    copy'])
  expect(find(root, 'func')?.props).toMatchObject({ color: '#c792ea', backgroundColor: '#171527' })
  expect(find(root, 'main')?.props.color).toBe('#ffe6b3')
  expect(find(root, '"hi"')?.props.color).toBe('#a1efd3')
  expect(find(root, '(')?.props.color).toBe('#cbe3e7')
})

// MARK: Copy buttons

async function copied($: Engine, on: Parameters<TestBody>[1], markdown: string, key = 'copy-0'): Promise<string | undefined> {
  let text: string | undefined
  on('ui.copy', ($, e) => {
    text = e.text
    return { value: { isCopied: true } }
  })
  const ui = await $.ui.mount({
    plugin: 'readable',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: markdown, isFirstOfReply: false } as never,
    viewport: { columns: COLUMNS, rows: 40 },
  })
  await ui.press({ key })
  return text
}

test('copies a code block’s text without its panel', async ($, on) => {
  expect(await copied($, on, 'In the queue:\n\n```\n3102-20048467\n3000-20019033\n```\n\nDone.')).toBe('3102-20048467\n3000-20019033')
})

test('copies a quote’s text without its bar or markers', async ($, on) => {
  expect(await copied($, on, '> Hi team,\n> please resend **these**.\n>\n> Thanks')).toBe('Hi team,\nplease resend **these**.\n\nThanks')
})

test('gives each code block and quote a button of its own, and prose none', async ($, on) => {
  expect(await copied($, on, 'one\n\n```\na\n```\n\ntwo\n\n> b', 'copy-1')).toBe('b')
  const ui = await $.ui.mount({
    plugin: 'readable',
    surface: 'terminal',
    component: 'AssistantMessage',
    props: { text: 'one\n\n```\na\n```\n\ntwo\n\n> b', isFirstOfReply: false } as never,
    viewport: { columns: COLUMNS, rows: 40 },
  })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
  expect(await lines($, 'just prose')).toEqual(['  just prose'])
})

test('draws code of an unknown language plain on the panel', async $ => {
  const root = await reply($, '```\nplain words\n```')
  expect(find(root, 'plain words')?.props).toMatchObject({ color: '#cbe3e7', backgroundColor: '#171527' })
})

test('tags declarations, strings with escapes and comments', async () => {
  const tokens = (source: string, lang: string) => highlight(source, lang).filter(token => token.text.trim() !== '')
  expect(tokens('def run(): # go', 'python')).toEqual([
    { text: 'def', syntax: 'declaration' },
    { text: 'run', syntax: 'function' },
    { text: '()', syntax: 'punctuation' },
    { text: ':', syntax: 'operator' },
    { text: '# go', syntax: 'comment' },
  ])
  expect(tokens('"a\\nb"', 'ts')).toEqual([{ text: '"a', syntax: 'string' }, { text: '\\n', syntax: 'escape' }, { text: 'b"', syntax: 'string' }])
  expect(tokens('+added\n-removed', 'diff')).toEqual([{ text: '+added', syntax: 'added' }, { text: '-removed', syntax: 'removed' }])
})

// MARK: Sentences

test('gives each sentence a row, but not a stop followed by lowercase', async $ => {
  expect(await lines($, 'It ran. Did it pass! Is it merged? not yet, it waits.')).toEqual([
    '  It ran.',
    '  Did it pass!',
    '  Is it merged? not yet, it waits.',
  ])
})

test('reads short forms, initials, version numbers and file names as mid-sentence', async $ => {
  expect(await lines($, 'Ask Dr. Who, i.e. A. N. Other, to bump v2.4 in index.ts first. Then ship')).toEqual([
    '  Ask Dr. Who, i.e. A. N. Other, to bump v2.4 in index.ts first.',
    '  Then ship',
  ])
})

test('ends a sentence inside bold text and starts one at inline code', async $ => {
  expect(await lines($, '**It works.** Next step. `npm i` installs it.')).toEqual([
    '  It works.',
    '  Next step.',
    `  ${NBSP}npm i${NBSP} installs it.`,
  ])
})

test('splits sentences in list items and quotes too', async $ => {
  expect(await lines($, '- One. Two.\n\n> Three. Four.')).toEqual(['  - One.', '    Two.', '', '  ▎ Three.', '  ▎ Four.', '    copy'])
})

// MARK: Parser

test('leaves snake_case plain and pairs nested emphasis', () => {
  expect(parse('call snake_case_name now')).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'call snake_case_name now' }] }])
  expect(parse('***both** one*')).toEqual([
    { type: 'paragraph', children: [{ type: 'emphasis', children: [{ type: 'strong', children: [{ type: 'text', value: 'both' }] }, { type: 'text', value: ' one' }] }] },
  ])
})

test('reads setext headings, escapes, entities and hard breaks', () => {
  expect(parse('Title\n===')).toEqual([{ type: 'heading', depth: 1, children: [{ type: 'text', value: 'Title' }] }])
  expect(parse('\\*not\\* &amp; a  \nb')).toEqual([
    { type: 'paragraph', children: [{ type: 'text', value: '*not* & a' }, { type: 'break' }, { type: 'text', value: 'b' }] },
  ])
})

test('reads half-streamed markdown: an open fence and a table with no rows yet', async $ => {
  expect(parse('```ts\nconst a = 1')).toEqual([{ type: 'code', lang: 'ts', value: 'const a = 1' }])
  expect((await lines($, 'Here:\n\n```ts\nconst x = 1')).join('\n')).toContain('const x = 1')
  expect((await lines($, 'Here:\n\n| Name | Value |\n| ---')).join('\n')).toContain('Name')
})

// MARK: Prompts

const withPaste = (count: number) =>
  `look at this:\n\n<pasted_content id="8829">\n${Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n')}\n</pasted_content id="8829">\n\nwhat do you think?`

test('draws the person’s prompt on a panel behind a mark', async $ => {
  const root = await prompt($)
  expect(root.props?.backgroundColor).toBe('#2d2b40')
  expect(textOf(root)).toBe('❯ make it blue')
  expect(find(root, '❯')?.props).toMatchObject({ color: '#a37acc', backgroundColor: '#2d2b40', bold: true })
  expect(find(root, 'make it blue')?.props).toMatchObject({ color: '#eef6f7', backgroundColor: '#2d2b40' })
})

test('draws a paste as a labelled inset block without its tags', async $ => {
  const root = await prompt($, withPaste(3))
  expect(JSON.stringify(root)).not.toContain('pasted_content')
  expect(find(root, 'pasted · 3 lines')?.props).toMatchObject({ color: '#8a889d', italic: true, backgroundColor: '#262439' })
  expect(find(root, 'line 2')?.props).toMatchObject({ color: '#cbe3e7', backgroundColor: '#262439' })
  expect(find(root, '▎')?.props.color).toBe('#a37acc')
  expect(find(root, 'look at this:')).toBeDefined()
  expect(find(root, 'what do you think?')).toBeDefined()
})

test('folds a long paste to its first lines until the row is expanded', async $ => {
  const folded = await prompt($, withPaste(20), 'composer', false)
  expect(find(folded, 'line 8')).toBeDefined()
  expect(find(folded, 'line 9')).toBeUndefined()
  expect(find(folded, '12 more lines')).toBeDefined()
  const open = await prompt($, withPaste(20), 'composer', true)
  expect(find(open, 'line 20')).toBeDefined()
  expect(find(open, 'more lines')).toBeUndefined()
})

// MARK: Left to the engine

test('leaves summaries, other surfaces and notifications to the engine', async ($, on) => {
  engineDraws(on)
  expect(textOf(await reply($, '# Title', { isSummary: true }))).toBe('engine')
  expect(textOf(await reply($, '# Title', { surface: 'desktop' }))).toBe('engine')
  expect(textOf(await prompt($, 'done', 'task-notification'))).toBe('engine')
})

test('hands a message it cannot draw to the engine', async ($, on) => {
  engineDraws(on)
  expect(textOf(await reply($, 42))).toBe('engine')
})

// MARK: Options

test('draws in glamour’s dark colours when the theme option says dark', { options: { theme: 'dark' } }, async $ => {
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe('ansi256(252)')
  expect(find(await prompt($), 'make it blue')?.props.backgroundColor).toBe('#2b3142')
})

test('keeps sentences together when sentence per line is off', { options: { sentencePerLine: false } }, async $ => {
  expect(await lines($, 'First one. Second one!')).toEqual(['  First one. Second one!'])
})

// MARK: Ghostty

// What `ghostty +show-config` prints for Rosé Pine Moon, trimmed to the lines readable reads and a few it skips.
const ROSE_PINE_MOON = [
  'font-family = Monaspace Neon NF',
  'theme = Rose Pine Moon',
  'background = #232136',
  'foreground = #e0def4',
  'selection-background = #44415a',
  ...['#393552', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4'].map((c, i) => `palette = ${i}=${c}`),
  ...['#6e6a86', '#eb6f92', '#3e8fb0', '#f6c177', '#9ccfd8', '#c4a7e7', '#ea9a97', '#e0def4'].map((c, i) => `palette = ${i + 8}=${c}`),
].join('\n')

function inGhostty(on: Parameters<TestBody>[1], stdout = ROSE_PINE_MOON) {
  mock.env(on, { GHOSTTY_BIN_DIR: '/Applications/Ghostty.app/Contents/MacOS' })
  const runs: string[][] = []
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  return runs
}

test('reads the background, foreground and 16 colours out of show-config', () => {
  const palette = parseGhosttyConfig(ROSE_PINE_MOON)
  expect(palette?.background).toBe('#232136')
  expect(palette?.foreground).toBe('#e0def4')
  expect(palette?.ansi).toHaveLength(16)
  expect(palette?.ansi[5]).toBe('#c4a7e7')
  expect(parseGhosttyConfig('background = #232136\nforeground = #e0def4\npalette = 0=#393552')).toBeUndefined()
})

test('keeps every colour readable on the panel under it, lifting the ones that fall short', () => {
  const theme = fromPalette(parseGhosttyConfig(ROSE_PINE_MOON)!)
  const code = theme.codeBlock.backgroundColor!
  for (const [name, look] of Object.entries(theme.syntax)) {
    const floor = name === 'comment' || name === 'hunk' ? 3.5 : 4.5
    expect(contrast(look.color!, code)).toBeGreaterThanOrEqual(floor)
  }
  // Rosé Pine's bright black is a hint grey too faint for comments, so it is lifted; its iris already reads.
  expect(contrast('#6e6a86', code)).toBeLessThan(3.5)
  expect(theme.syntax.comment.color).not.toBe('#6e6a86')
  expect(theme.syntax.keyword.color).toBe('#c4a7e7')
  expect(contrast(theme.prompt.color!, theme.prompt.backgroundColor!)).toBeGreaterThanOrEqual(4.5)
})

test('draws in the colours of Ghostty’s theme, asking Ghostty once', async ($, on) => {
  const runs = inGhostty(on)
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe('#e0def4')
  expect(find(await prompt($), 'make it blue')?.props.backgroundColor).toBe(fromPalette(parseGhosttyConfig(ROSE_PINE_MOON)!).prompt.backgroundColor)
  expect(runs).toEqual([['/Applications/Ghostty.app/Contents/MacOS/ghostty', '+show-config']])
})

test('falls back to Embark outside Ghostty or when Ghostty’s colours cannot be read', async ($, on) => {
  inGhostty(on, 'theme = something-broken')
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe('#cbe3e7')
})

test('falls back to Embark when Ghostty is not the terminal', async ($, on) => {
  mock.env(on, {})
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe('#cbe3e7')
})

test('leaves Ghostty alone when a fixed theme is chosen', { options: { theme: 'embark' } }, async ($, on) => {
  const runs = inGhostty(on)
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe('#cbe3e7')
  expect(runs).toEqual([])
})

// MARK: Rex

// What `defaults read com.superlogical.rex` prints, trimmed to the theme keys and one it skips.
const REX_DEFAULTS = [
  '{',
  '    "Workspace.appearance" = dark;',
  '    "Workspace.darkThemeID" = "velvet-dusk";',
  '    "Workspace.interfaceStyle" = blendTheme;',
  '    "Workspace.lightThemeID" = "lavender-postcard";',
  '}',
].join('\n')

// Velvet Dusk as Rex's themes.json holds it, beside a light theme readable must not pick.
const VELVET_DUSK = {
  background: '#171122',
  foreground: '#d6cbe6',
  ansi: ['#241a35', '#e07396', '#83bb8d', '#dcae76', '#7f95dc', '#b98ae0', '#7fb8c4', '#b5aacb'].concat(
    ['#635677', '#ef92ae', '#9ed3a7', '#edc793', '#9cafe9', '#cfa8f0', '#9cd0da', '#ede6f7'],
  ),
}
const REX_THEMES = JSON.stringify([
  { id: 'lavender-postcard', appearance: 'light', source: { ...VELVET_DUSK, background: '#f6f1fb', foreground: '#3a2f4d' } },
  { id: 'velvet-dusk', appearance: 'dark', source: { ...VELVET_DUSK, cursor: '#c9a1f0' } },
])

// An imported theme, as Rex keeps it in Workspace.customThemes: each colour as 0–1 floats.
const PLUM_INK = {
  background: '#1d1321',
  foreground: '#e0d8e4',
  ansi: ['#2a1f2f', '#e8808d', '#8cc98f', '#dbb56f', '#7fa6e6', '#c495e0', '#6cc6c4', '#b9adbf'].concat(
    ['#5f5165', '#f59aa5', '#a5dca7', '#ebc98b', '#9bbcf2', '#d4adec', '#8ad6d4', '#efe8f2'],
  ),
}
const PLUM_INK_ID = 'custom-1BE7371E-083D-417A-8C66-FEE0E9EE2DD5'
const floats = (hex: string) => {
  const [red, green, blue] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
  return { red, green, blue, alpha: 1, colorSpace: 'srgb' }
}
const REX_CUSTOM_THEMES = JSON.stringify([
  {
    id: PLUM_INK_ID,
    name: 'Plum Ink',
    appearance: 'dark',
    palette: { background: floats(PLUM_INK.background), foreground: floats(PLUM_INK.foreground), ansi: PLUM_INK.ansi.map(floats) },
  },
])
const withPlumInk = (defaults: string) => defaults.replace('"velvet-dusk"', `"${PLUM_INK_ID}"`)

// Inside Rex, readable checks the chosen theme on a timer; the clock is mocked so that timer waits on the test.
function inRex(on: Parameters<TestBody>[1], { defaults = (): string => REX_DEFAULTS, systemDark = true } = {}) {
  mock.env(on, { REX_SESSION: 'session:01a1', HOME: '/Users/me' })
  const clock = mock.clock(on)
  const writes: { path: string; text: string }[] = []
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined } as never
  })
  const runs: string[][] = []
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const out = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '' } }) as never
    if (argv[0] === 'defaults' && argv[2] === '-g') return systemDark ? out(0, 'Dark\n') : out(1, '')
    if (argv[0] === 'defaults') return out(0, defaults())
    if (argv[0] === 'cat' && argv[1]?.startsWith('/Applications/Rex Beta.app/')) return out(0, REX_THEMES)
    if (argv[0] === 'sh' && argv[2]?.includes('customThemes')) return out(0, REX_CUSTOM_THEMES)
    return out(1, '')
  })
  return { runs, clock, writes }
}

test('picks the dark or light Rex theme by the app’s appearance, else the system’s', () => {
  expect(rexThemeId(REX_DEFAULTS, false)).toBe('velvet-dusk')
  expect(rexThemeId(REX_DEFAULTS.replace('= dark;', '= light;'), true)).toBe('lavender-postcard')
  expect(rexThemeId(REX_DEFAULTS.replace('= dark;', '= system;'), false)).toBe('lavender-postcard')
  expect(rexThemeId(REX_DEFAULTS.replace('= dark;', '= system;'), true)).toBe('velvet-dusk')
  expect(rexThemeId('{\n}', true)).toBeUndefined()
})

test('reads one theme’s colours out of Rex’s themes.json', () => {
  expect(parseRexTheme(REX_THEMES, 'velvet-dusk')).toEqual({ ...VELVET_DUSK, cursor: '#c9a1f0' })
  expect(parseRexTheme(REX_THEMES, 'no-such-theme')).toBeUndefined()
  expect(parseRexTheme(JSON.stringify([{ id: 'short', source: { ...VELVET_DUSK, ansi: ['#000000'] } }]), 'short')).toBeUndefined()
})

test('reads an imported theme’s colours out of Rex’s custom themes', () => {
  expect(parseRexCustomTheme(REX_CUSTOM_THEMES, PLUM_INK_ID)).toEqual({ ...PLUM_INK, name: 'Plum Ink' })
  expect(parseRexCustomTheme(REX_CUSTOM_THEMES, 'custom-missing')).toBeUndefined()
  const short = JSON.stringify([{ id: 'custom-short', palette: { background: floats('#000000'), foreground: floats('#ffffff'), ansi: [floats('#000000')] } }])
  expect(parseRexCustomTheme(short, 'custom-short')).toBeUndefined()
})

test('draws in the colours of an imported Rex theme', async ($, on) => {
  inRex(on, { defaults: () => withPlumInk(REX_DEFAULTS) })
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe(fromPalette(PLUM_INK).text.color)
})

test('follows a theme switch in Rex without a restart', async ($, on) => {
  let defaults = REX_DEFAULTS
  const { clock } = inRex(on, { defaults: () => defaults })
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe(fromPalette(VELVET_DUSK).text.color)
  defaults = withPlumInk(REX_DEFAULTS)
  await clock.advance(1500)
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe(fromPalette(PLUM_INK).text.color)
})

test('builds a Claude Code theme whose diffs use the palette’s own red and green', () => {
  const theme = claudeCodeTheme({ ...VELVET_DUSK, name: 'Velvet Dusk', cursor: '#c9a1f0' })
  expect(theme.name).toBe('Rex · Velvet Dusk')
  expect(theme.base).toBe('dark')
  expect(theme.overrides.claude).toBe('#c9a1f0')
  expect(theme.overrides.diffAdded).toBe(mix(VELVET_DUSK.background, VELVET_DUSK.ansi[2] as string, 0.2))
  expect(theme.overrides.diffRemoved).toBe(mix(VELVET_DUSK.background, VELVET_DUSK.ansi[1] as string, 0.2))
  // A "green" slot holding cyan is skipped for a real green further along.
  const cyanGreen = [...VELVET_DUSK.ansi]
  cyanGreen[2] = '#33b1ff'
  expect(claudeCodeTheme({ ...VELVET_DUSK, ansi: cyanGreen }).overrides.diffAdded).toBe(
    mix(VELVET_DUSK.background, VELVET_DUSK.ansi[10] as string, 0.2),
  )
})

test('keeps Claude Code’s rex theme in step with Rex', async ($, on) => {
  let defaults = REX_DEFAULTS
  const { clock, writes } = inRex(on, { defaults: () => defaults })
  await reply($, 'Hello there.')
  expect(writes.map(w => w.path)).toEqual(['/Users/me/.claude/themes/rex.json'])
  expect(JSON.parse(writes[0]?.text ?? '{}').overrides.claude).toBe('#c9a1f0')
  defaults = withPlumInk(REX_DEFAULTS)
  await clock.advance(1500)
  expect(writes).toHaveLength(2)
  expect(JSON.parse(writes[1]?.text ?? '{}').name).toBe('Rex · Plum Ink')
})

test('leaves Claude Code’s theme alone when told to', { options: { claudeTheme: false } }, async ($, on) => {
  const { writes } = inRex(on)
  await reply($, 'Hello there.')
  expect(writes).toEqual([])
})

test('draws in the colours of Rex’s theme inside Rex', async ($, on) => {
  inRex(on)
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe(fromPalette(VELVET_DUSK).text.color)
  expect(find(await prompt($), 'make it blue')?.props.backgroundColor).toBe(fromPalette(VELVET_DUSK).prompt.backgroundColor)
})

test('falls back to Embark when Rex’s theme cannot be read', async ($, on) => {
  inRex(on, { defaults: () => '{\n}' })
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe('#cbe3e7')
})

test('still reads Rex’s theme under the old ghostty name', { options: { theme: 'ghostty' } }, async ($, on) => {
  inRex(on)
  expect(find(await reply($, 'Hello there.'), 'Hello')?.props.color).toBe(fromPalette(VELVET_DUSK).text.color)
})
