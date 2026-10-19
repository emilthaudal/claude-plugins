import type { Card, Check, GraphRow, MergeKind } from '../types'

/** The terminal's element table, as `$.ui.resolve(e)` answers it. */
type Elements = { Box: (props: object) => never; Text: (props: object) => never }

// Ink's named colours, so lanes and states take the terminal theme's own.
const LANES = ['blue', 'green', 'magenta', 'cyan', 'yellow']
const MAX_WIDTH = 110
const BAR_CELLS = 5

// MARK: Labels

const MERGE: Record<MergeKind, { label: string; color: string; mark: string }> = {
  ready: { label: 'ready', color: 'green', mark: '◉' },
  conflicts: { label: 'conflicts', color: 'yellow', mark: '◉' },
  behind: { label: 'behind base', color: 'yellow', mark: '◉' },
  blocked: { label: 'blocked', color: 'gray', mark: '◉' },
  failing: { label: 'checks failing', color: 'red', mark: '◉' },
  draft: { label: 'draft', color: 'gray', mark: '◌' },
  unknown: { label: 'checking', color: 'gray', mark: '◌' },
  merged: { label: 'merged', color: 'magenta', mark: '◉' },
  closed: { label: 'closed', color: 'red', mark: '◌' },
}

const STATE: Record<Card['state'], { label: string; color: string }> = {
  open: { label: '● Open', color: 'green' },
  draft: { label: '◌ Draft', color: 'gray' },
  merged: { label: '● Merged', color: 'magenta' },
  closed: { label: '● Closed', color: 'red' },
  none: { label: 'no PR yet', color: 'gray' },
}

const CHECK: Record<Check['state'], { mark: string; color: string }> = {
  pass: { mark: '✓', color: 'green' },
  fail: { mark: '✗', color: 'red' },
  pending: { mark: '◌', color: 'yellow' },
  skip: { mark: '–', color: 'gray' },
}

/** The merge row's right-hand label: `3 conflicts` once the files are known. */
export function mergeLabel(card: Card): string {
  const { kind, files } = card.merge
  if (kind === 'conflicts' && files.length > 0) return `${files.length} ${files.length === 1 ? 'conflict' : 'conflicts'}`
  return MERGE[kind].label
}

/** What the band's pill says the PR needs: `Ready to merge`, `3 conflicts`. */
export function pillLabel(card: Card): string {
  const label = mergeLabel(card)
  if (card.merge.kind === 'ready') return 'Ready to merge'
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** Green and red cells in proportion to the lines added and removed, as GitHub draws a diff's size. */
export function diffBar(additions: number, deletions: number): { added: number; removed: number; empty: number } {
  const total = additions + deletions
  if (total === 0) return { added: 0, removed: 0, empty: BAR_CELLS }
  // Four cells share the change and the fifth stays grey, as on GitHub; a side with any lines gets at least one.
  const share = (lines: number) => (lines === 0 ? 0 : Math.max(1, Math.round(((BAR_CELLS - 1) * lines) / total)))
  const added = Math.min(share(additions), BAR_CELLS - 1 - (deletions > 0 ? 1 : 0))
  const removed = Math.min(share(deletions), BAR_CELLS - 1 - added)
  return { added, removed, empty: BAR_CELLS - added - removed }
}

/** The checks worth a chip: failing and running first, and passing ones folded into a count past `room` chips. */
export function checkChips(checks: Check[], room: number): { shown: Check[]; folded: number } {
  const order: Check['state'][] = ['fail', 'pending', 'pass', 'skip']
  const sorted = [...checks].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
  if (sorted.length <= room) return { shown: sorted, folded: 0 }
  return { shown: sorted.slice(0, room - 1), folded: sorted.length - (room - 1) }
}

// MARK: Pieces

function lanes({ Text }: Elements, graph: string) {
  return [...graph].map((char, column) =>
    char === ' ' ? ' ' : Text({ color: LANES[Math.floor(column / 2) % LANES.length], children: [char] }),
  )
}

function bar({ Text }: Elements, additions: number, deletions: number) {
  const { added, removed, empty } = diffBar(additions, deletions)
  return [
    Text({ color: 'green', children: [`+${additions}`] }),
    ' ',
    Text({ color: 'red', children: [`−${deletions}`] }),
    ' ',
    Text({ color: 'green', children: ['■'.repeat(added)] }),
    Text({ color: 'red', children: ['■'.repeat(removed)] }),
    Text({ dimColor: true, children: ['■'.repeat(empty)] }),
  ]
}

function row(ui: Elements, left: unknown[], right: unknown[]) {
  const { Box, Text } = ui
  return Box({
    justifyContent: 'space-between',
    children: [
      Box({ flexShrink: 1, children: [Text({ wrap: 'truncate-end', children: left })] }),
      Box({ flexShrink: 0, paddingLeft: 2, children: [Text({ children: right })] }),
    ],
  })
}

function commitRow(ui: Elements, commit: Extract<GraphRow, { kind: 'commit' }>, card: Card, gutter: number) {
  const { Text } = ui
  const refs = commit.refs.flatMap(ref => {
    const isBase = ref.replace(/^origin\//, '') === card.base
    return [' ', Text({ color: isBase ? 'gray' : LANES[0], inverse: !isBase, children: [` ${ref} `] })]
  })
  const brings =
    commit.brings > 0 ? [Text({ dimColor: true, children: [` +${commit.brings} ${commit.brings === 1 ? 'commit' : 'commits'}`] })] : []
  const left = [
    ...lanes(ui, commit.lanes.padEnd(gutter)),
    '  ',
    Text({ dimColor: !commit.isMine || commit.isBoundary || commit.isBase, children: [commit.subject] }),
    ...brings,
    ...refs,
  ]
  const right = [Text({ dimColor: true, children: [`${commit.sha}  ${commit.author} · ${commit.age}`] })]
  return row(ui, left, right)
}

// MARK: Card and pill

/** The card drawn under a PR command's row: header, merge row, graph, checks and the step the command took. */
export function drawCard(ui: Elements, card: Card, columns: number) {
  const { Box, Text } = ui
  const gutter = Math.max(1, ...card.rows.map(r => r.lanes.length))
  const merge = MERGE[card.merge.kind]
  const state = STATE[card.state]

  const header = row(
    ui,
    [Text({ bold: true, children: [card.title] }), ...(card.number === null ? [] : [Text({ dimColor: true, children: [` #${card.number}`] })])],
    [Text({ color: state.color, children: [state.label] })],
  )
  const mergeRow = row(
    ui,
    [Text({ color: merge.color, children: [merge.mark.padEnd(gutter)] }), Text({ dimColor: true, children: [`  Merge into ${card.base}`] })],
    [Text({ color: merge.color, children: [mergeLabel(card)] })],
  )
  const graph = card.rows.map(r =>
    r.kind === 'commit' ? commitRow(ui, r, card, gutter) : Text({ children: lanes(ui, r.lanes) }),
  )
  const more = card.more > 0 ? [Text({ dimColor: true, children: [`${' '.repeat(gutter)}  … ${card.more} more`] })] : []
  const conflicts =
    card.merge.files.length > 0
      ? [Text({ color: 'yellow', wrap: 'truncate-end', children: [`Conflicts in ${card.merge.files.join(', ')}`] })]
      : []

  const { shown, folded } = checkChips(card.checks, 6)
  const checks =
    card.checks.length > 0
      ? [
          Text({
            wrap: 'truncate-end',
            children: [
              ...shown.flatMap((check, i) => [
                ...(i > 0 ? ['  '] : []),
                Text({ color: CHECK[check.state].color, children: [`${CHECK[check.state].mark} `] }),
                Text({ dimColor: check.state === 'skip', children: [check.name] }),
              ]),
              ...(folded > 0 ? [Text({ dimColor: true, children: [`  +${folded} more`] })] : []),
            ],
          }),
        ]
      : []

  const footer =
    card.step !== '' || card.additions + card.deletions > 0
      ? [row(ui, [Text({ dimColor: true, children: [card.step] })], card.additions + card.deletions > 0 ? bar(ui, card.additions, card.deletions) : [])]
      : []

  return Box({
    flexDirection: 'column',
    width: Math.min(columns, MAX_WIDTH),
    borderStyle: 'round',
    borderColor: 'gray',
    paddingX: 1,
    children: [header, Text({ children: [' '] }), mergeRow, ...graph, ...more, ...conflicts, ...checks, ...footer],
  })
}

/** The band's one line: `● #128 Ready to merge  +482 −37 ■■■■□  ✓ 4 checks`. */
export function drawPill(ui: Elements, card: Card) {
  const { Box, Text } = ui
  const merge = MERGE[card.merge.kind]
  const failing = card.checks.filter(c => c.state === 'fail').length
  const pending = card.checks.filter(c => c.state === 'pending').length
  const checks =
    card.checks.length === 0
      ? []
      : failing > 0
        ? [Text({ color: 'red', children: [`✗ ${failing} failing`] })]
        : pending > 0
          ? [Text({ color: 'yellow', children: [`◌ ${pending} running`] })]
          : [Text({ color: 'green', children: [`✓ ${card.checks.length} checks`] })]
  return Box({
    gap: 2,
    children: [
      Text({ children: [Text({ color: merge.color, children: ['● '] }), `#${card.number} `, Text({ color: merge.color, children: [pillLabel(card)] })] }),
      Text({ children: bar(ui, card.additions, card.deletions) }),
      ...checks,
      Text({ dimColor: true, wrap: 'truncate-end', children: [card.head] }),
    ],
  })
}
