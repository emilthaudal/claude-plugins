// MARK: Rules

/** Where an account applies: commands run under a directory, or commands that name a GitHub org's repos. */
export type Rule = { kind: 'directory'; path: string; account: string } | { kind: 'org'; org: string; account: string }

/** The accounts the mod picks between, read from the plugin's options. */
export type Accounts = { rules: Rule[]; fallback: string | null }

// A GitHub login: letters, digits and hyphens. Anything else in the options is ignored, so it never reaches a shell.
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/

/**
 * Reads the `rules` option: entries separated by commas or new lines, each `<directory>=<account>` or
 * `org:<org>=<account>`, a directory starting with `~` taken from `home`. Malformed entries are skipped.
 */
export function parseRules(text: string, home: string): Rule[] {
  const rules: Rule[] = []
  for (const entry of text.split(/[,\n]/)) {
    const at = entry.lastIndexOf('=')
    if (at < 0) continue
    const where = entry.slice(0, at).trim()
    const account = entry.slice(at + 1).trim()
    if (where === '' || !LOGIN.test(account)) continue
    if (where.toLowerCase().startsWith('org:')) {
      const org = where.slice(4).trim().toLowerCase()
      if (org !== '') rules.push({ kind: 'org', org, account })
    } else {
      rules.push({ kind: 'directory', path: resolve('/', where, home), account })
    }
  }
  return rules
}

/** Reads the plugin's options into accounts; a blank or malformed `default` means none. */
export function accountsFrom(options: { readonly [key: string]: unknown }, home: string): Accounts {
  const rules = typeof options.rules === 'string' ? parseRules(options.rules, home) : []
  const fallback = typeof options.default === 'string' && LOGIN.test(options.default.trim()) ? options.default.trim() : null
  return { rules, fallback }
}

// MARK: Matching

// A command word starts the line or follows a separator, a subshell, a command substitution or a shell keyword.
const START = String.raw`(?:^|[\n;&|(\x60]|\$\(|\b(?:do|then|else|time|exec|xargs)\s)\s*`
const GH = new RegExp(`${START}gh\\s`)
const GIT_NETWORK = new RegExp(`${START}git(?:\\s+-C\\s+\\S+)?\\s+(?:push|pull|fetch|clone|ls-remote)\\b`)
// gh auth manages the accounts themselves, and a command that sets a token has chosen its account.
const LEAVE = /(?:^|[\s;&|(])gh\s+auth\b|\b(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)=/

/** Whether the command talks to GitHub as someone: a gh call or a git network operation. */
export function needsAccount(command: string): boolean {
  // Most commands contain neither word, and a substring scan settles those without the regexes.
  if (!command.includes('gh') && !command.includes('git')) return false
  return !LEAVE.test(command) && (GH.test(command) || GIT_NETWORK.test(command))
}

// MARK: Resolving

function unquote(path: string): string {
  return path.replace(/^(['"])(.*)\1$/, '$2')
}

function resolve(from: string, path: string, home: string): string {
  const raw = unquote(path)
  const absolute = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw.startsWith('/') ? raw : `${from}/${raw}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** The directory the command's GitHub calls run in: the session's, moved by each `cd`, then by a `git -C`. */
export function directoryOf(command: string, cwd: string, home: string): string {
  let dir = cwd
  for (const [, path] of command.matchAll(new RegExp(`${START}cd\\s+("[^"]+"|'[^']+'|[^\\s;&|)]+)`, 'g'))) {
    if (path !== undefined) dir = resolve(dir, path, home)
  }
  const gitC = command.match(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/)
  return gitC?.[1] === undefined ? dir : resolve(dir, gitC[1], home)
}

function isUnder(dir: string, path: string): boolean {
  return path === '/' || dir === path || dir.startsWith(`${path}/`)
}

/**
 * The account a command runs as: the rule for an org it names, else the rule for the deepest directory it runs
 * under, else the fallback. Null when nothing applies, so the command runs as the active gh account.
 */
export function accountFor(command: string, cwd: string, home: string, accounts: Accounts): string | null {
  const org = command.match(/(?:github\.com[/:]|(?:-R|--repo)[\s=]+|repo\s+(?:clone|view|fork)\s+)([\w.-]+)\//)?.[1]?.toLowerCase()
  const byOrg = org === undefined ? undefined : accounts.rules.find(rule => rule.kind === 'org' && rule.org === org)
  if (byOrg !== undefined) return byOrg.account
  const dir = directoryOf(command, cwd, home)
  let deepest: Extract<Rule, { kind: 'directory' }> | undefined
  for (const rule of accounts.rules) {
    if (rule.kind !== 'directory' || !isUnder(dir, rule.path)) continue
    if (deepest === undefined || rule.path.length > deepest.path.length) deepest = rule
  }
  return deepest?.account ?? accounts.fallback
}

// The variable the token passes through, named so it can't clash with one the command uses.
const SLOT = 'GH_ACCOUNT_MOD_TOKEN'

/**
 * The command, run with the account's token: gh reads GH_TOKEN, and git reads it through gh's credential helper.
 * The token is read when the command runs, so it never appears in the command. An account with no token (logged
 * out, a typo) leaves GH_TOKEN as it was, and the command runs as the active account.
 */
export function withAccount(command: string, account: string): string {
  return `${SLOT}="$(gh auth token --user ${account} 2>/dev/null)" && [ -n "$${SLOT}" ] && export GH_TOKEN="$${SLOT}"; unset ${SLOT}\n${command}`
}
