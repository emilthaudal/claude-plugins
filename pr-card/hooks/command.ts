// MARK: Which commands draw a card

export type Kind = 'push' | 'create' | 'merge' | 'checks' | 'view' | 'ready'

const GH_PR = /\bgh\s+pr\s+(create|merge|checks|view|status|ready|edit|reopen)\b/
const GIT_PUSH = /\bgit(?:\s+-C\s+\S+)?\s+push\b/

/** What a Bash command does to a PR, or null for a command that leaves PRs alone. */
export function prCommand(command: string): Kind | null {
  if (GIT_PUSH.test(command)) return 'push'
  const gh = GH_PR.exec(command)?.[1]
  if (gh === undefined) return null
  if (gh === 'status' || gh === 'edit' || gh === 'reopen') return 'view'
  return gh as Kind
}

/** The line the card's footer shows for the command. */
export function stepFor(kind: Kind, number: number | null): string {
  const pr = number === null ? 'the PR' : `#${number}`
  switch (kind) {
    case 'push':
      return 'Pushed to origin'
    case 'create':
      return `Opened ${pr}`
    case 'merge':
      return `Merged ${pr}`
    case 'ready':
      return `Marked ${pr} ready for review`
    case 'checks':
    case 'view':
      return ''
  }
}

// MARK: Where the command ran

const unquote = (path: string) => path.replace(/^(['"])(.*)\1$/, '$2')

function resolve(named: string, from: string, home: string): string {
  const path = unquote(named)
  if (path === '~' || path.startsWith('~/')) return home + path.slice(1)
  if (path.startsWith('/')) return path
  return `${from.replace(/\/$/, '')}/${path}`
}

/**
 * The directory a command works in: each `cd` taken in turn from the session's working directory, then its
 * `git -C` path from there.
 */
export function directoryOf(command: string, cwd: string, home: string): string {
  const cds = [...command.matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)].map(m => m[1] as string)
  const dir = cds.reduce((from, named) => resolve(named, from, home), cwd)
  const gitC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1]
  return gitC === undefined ? dir : resolve(gitC, dir, home)
}
