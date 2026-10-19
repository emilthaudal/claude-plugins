/** How one CI check stands. */
export type CheckState = 'pass' | 'fail' | 'pending' | 'skip'

export type Check = { name: string; state: CheckState }

/** Whether the branch can merge into its base, as GitHub and a local trial merge see it. */
export type MergeKind = 'ready' | 'conflicts' | 'behind' | 'blocked' | 'failing' | 'draft' | 'unknown' | 'merged' | 'closed'

/** One row of `git log --graph`: a commit, or a row of lane edges between commits. */
export type GraphRow =
  | {
      kind: 'commit'
      /** The graph's columns left of the commit, `*` and `o` already drawn as marks. */
      lanes: string
      sha: string
      subject: string
      author: string
      isMine: boolean
      age: string
      /** Branch names pointing at the commit, `origin/` dropped unless the local branch points elsewhere. */
      refs: string[]
      /** The merge base `--boundary` adds below the branch's commits. */
      isBoundary: boolean
      /** A commit the base has and the branch lacks, drawn `◇`. */
      isBase: boolean
      parents: string[]
      /** For a merge into the branch: the commits it brings in that the base lacks. */
      brings: number
    }
  | { kind: 'edge'; lanes: string }

export type Card = {
  title: string
  number: number | null
  state: 'open' | 'draft' | 'merged' | 'closed' | 'none'
  head: string
  base: string
  merge: { kind: MergeKind; files: string[] }
  checks: Check[]
  additions: number
  deletions: number
  rows: GraphRow[]
  /** Commits left out below the last row. */
  more: number
  /** What the command that drew the card did: `Pushed to origin`, `Opened #12`. */
  step: string
}

declare module 'claude-code' {
  interface PluginState {
    'pr-card': {
      /** The card drawn under a command's row, by the call's tool_use_id. */
      cards: StateFamily<Card | null>
      /** The PR the band above the prompt shows. */
      band: Card | null
    }
  }
}
