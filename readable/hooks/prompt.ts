// MARK: Pasted content

/** A stretch of a prompt: what the person typed, or a block they pasted. */
export type PromptPart = { kind: 'typed'; text: string } | { kind: 'pasted'; lines: string[] }

// The engine stores a paste in the prompt between tags carrying the same id: <pasted_content id="x">…</pasted_content id="x">.
const PASTE = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g

const trimBlankLines = (text: string) => text.replace(/^\s*\n/, '').replace(/\n\s*$/, '')

/** Splits a prompt into typed text and pasted blocks; a prompt with no paste is one typed part. */
export function promptParts(text: string): PromptPart[] {
  const parts: PromptPart[] = []
  const typed = (chunk: string) => {
    const trimmed = trimBlankLines(chunk)
    if (trimmed.trim() !== '') parts.push({ kind: 'typed', text: trimmed })
  }
  let at = 0
  for (const match of text.matchAll(PASTE)) {
    typed(text.slice(at, match.index))
    parts.push({ kind: 'pasted', lines: (match[2] ?? '').split('\n') })
    at = match.index + match[0].length
  }
  typed(text.slice(at))
  return parts
}

/** How many of a paste's lines are drawn when the row is not expanded. */
const PASTE_PREVIEW_LINES = 8

/** The lines drawn for a paste and how many were left out. */
export function pasteShown(lines: string[], isExpanded: boolean): { shown: string[]; hidden: number } {
  // Folding away a single line saves nothing, so a paste one line over the preview is drawn whole.
  if (isExpanded || lines.length <= PASTE_PREVIEW_LINES + 1) return { shown: lines, hidden: 0 }
  return { shown: lines.slice(0, PASTE_PREVIEW_LINES), hidden: lines.length - PASTE_PREVIEW_LINES }
}
