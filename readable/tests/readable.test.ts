import { expect, test, type TestBody } from 'claude-code/testing'
import { highlight } from '../hooks/highlight'
import { parse } from '../hooks/markdown'

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
// A reply is one Text whose rows are separated by newline strings; each row comes back as a Box of its spans.
function rowsOf(root: Element): Element[] {
  const rows: Element[] = [{ type: 'Box', children: [] }]
  for (const kid of (root.children?.[0] as Element | undefined)?.children ?? []) {
    if (kid === '\n') rows.push({ type: 'Box', children: [] })
    else rows.at(-1)?.children?.push(kid)
  }
  return rows
}

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
  return rowsOf(await reply($, text, props)).map(row => textOf(row).trimEnd())
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
  expect(rowsOf(await reply($, words, {}, 40)).length).toBeGreaterThan(wide.length)
})

test('puts one blank row between blocks', async $ => {
  expect(await lines($, 'One.\n\nTwo.')).toEqual(['  One.', '', '  Two.'])
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
    '  • one',
    '    • inner',
    '  • two',
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
  expect(rows[0]?.startsWith('  • word')).toBe(true)
  expect(rows[1]?.startsWith('    word')).toBe(true)
})

test('sets a table inside a list item a blank row apart from the text and the next item', async $ => {
  expect(await lines($, '- Since:\n\n  | A | B |\n  | - | - |\n  | 1 | 2 |\n- Next')).toEqual([
    '  • Since:',
    '',
    '     A │ B',
    '    ───┼───',
    '     1 │ 2',
    '',
    '  • Next',
  ])
})

// MARK: Quotes, rules and tables

test('bars a quote and joins its lines', async $ => {
  expect(await lines($, '> quoted\n> words')).toEqual(['  ▎ quoted words'])
})

test('fills a quote panel to the text width, its blank rows too', async $ => {
  const root = await reply($, '> one\n>\n> two')
  expect(rowsOf(root).map(row => textOf(row).length)).toEqual([2 + TEXT_WIDTH, 2 + TEXT_WIDTH, 2 + TEXT_WIDTH])
  for (const row of rowsOf(root)) expect(onPanel(row, '#262439')).toBe(true)
})

test('rules a thematic break in the border colour', async $ => {
  const root = await reply($, 'above\n\n***\n\nbelow')
  expect(rowsOf(root).map(row => textOf(row).trimEnd())).toEqual(['  above', '', '  --------', '', '  below'])
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
  const rows = rowsOf(root).map(textOf)
  expect(rows.map(row => row.trimEnd())).toEqual(['', '      x', ''])
  // The block's margin is two cells on the right as on the left.
  expect(rows.map(row => row.length)).toEqual([TEXT_WIDTH, TEXT_WIDTH, TEXT_WIDTH])
  for (const row of rowsOf(root)) expect(onPanel(row, '#171527')).toBe(true)
})

test('highlights code by its fence language, tabs drawn as spaces', async $ => {
  const root = await reply($, '```go\nfunc main() {\n\treturn "hi"\n}\n```')
  expect(rowsOf(root).map(row => textOf(row).trimEnd())).toEqual(['', '      func main() {', '          return "hi"', '      }', ''])
  expect(find(root, 'func')?.props).toMatchObject({ color: '#c792ea', backgroundColor: '#171527' })
  expect(find(root, 'main')?.props.color).toBe('#ffe6b3')
  expect(find(root, '"hi"')?.props.color).toBe('#a1efd3')
  expect(find(root, '(')?.props.color).toBe('#cbe3e7')
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
  expect(await lines($, '- One. Two.\n\n> Three. Four.')).toEqual(['  • One.', '    Two.', '', '  ▎ Three.', '  ▎ Four.'])
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
