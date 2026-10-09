import { toPlainText, type Block, type Inline } from './markdown'

// MARK: Where a sentence ends

// A period that ends a word, not a sentence, even before a capital ("e.g. Python", "Dr. Who").
const SHORT_FORMS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'al', 'mr', 'mrs', 'ms', 'dr', 'st', 'no', 'fig'])

/** Whether the text read so far ends a sentence: a stop, maybe closed by quotes or brackets, after a full word. */
function endsSentence(sofar: string): boolean {
  const m = /(\S*)([.!?])["'”’)\]]*$/u.exec(sofar)
  if (m === null) return false
  if (m[2] !== '.') return true
  // An initial ("J. Smith") or a short form keeps the sentence going.
  const word = (m[1] ?? '').replace(/^[("'“‘[]+/u, '')
  return !/^\p{Lu}$/u.test(word) && !SHORT_FORMS.has(word.toLowerCase())
}

// A lowercase word after the stop is the same sentence going on ("approx. ten", "v2. then").
const opensWith = (ch: string | undefined) => ch !== undefined && !/\p{Ll}/u.test(ch)

function nodeOpens(node: Inline | undefined): boolean {
  if (node === undefined || node.type === 'break') return false
  if (node.type === 'text' || node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') {
    return opensWith(toPlainText([node])[0])
  }
  // Code, a link or an image after a stop starts the next sentence.
  return true
}

// MARK: Splitting

/** Puts a line break in each space that follows a sentence; `before` is the text the run follows. */
function breakText(value: string, before: string, next: Inline | undefined): Inline[] {
  const out: Inline[] = []
  let from = 0
  const gaps = /\s+/g
  for (let gap = gaps.exec(value); gap !== null; gap = gaps.exec(value)) {
    const after = gap.index + gap[0].length
    const starts = after < value.length ? opensWith(value[after]) : nodeOpens(next)
    if (!starts || !endsSentence(before + value.slice(0, gap.index))) continue
    if (gap.index > from) out.push({ type: 'text', value: value.slice(from, gap.index) })
    out.push({ type: 'break' })
    from = after
  }
  if (from < value.length) out.push({ type: 'text', value: value.slice(from) })
  return out
}

// A link's label stays whole: a break in it would split one link over two lines.
function breakInlines(nodes: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const [i, node] of nodes.entries()) {
    if (node.type === 'text') out.push(...breakText(node.value, toPlainText(out.slice(-1)), nodes[i + 1]))
    else if (node.type === 'emphasis' || node.type === 'strong' || node.type === 'delete') {
      out.push({ ...node, children: breakInlines(node.children) })
    } else out.push(node)
  }
  return out
}

/** Breaks paragraphs, in quotes and list items too, after each sentence; other blocks are left as they are. */
export function oneSentencePerLine(blocks: Block[]): Block[] {
  return blocks.map((block): Block => {
    if (block.type === 'paragraph') return { ...block, children: breakInlines(block.children) }
    if (block.type === 'blockquote') return { ...block, children: oneSentencePerLine(block.children) }
    if (block.type === 'list') return { ...block, items: block.items.map(item => ({ ...item, children: oneSentencePerLine(item.children) })) }
    return block
  })
}
