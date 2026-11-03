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
  // Only what the shell runs counts: a `gh pr view` quoted in a message or a heredoc body is text, not a call.
  const code = codeOf(command)
  return !LEAVE.test(code) && (GH.test(code) || GIT_NETWORK.test(code))
}

// MARK: Literal text

const blank = (text: string) => text.replace(/[^\n]/g, ' ')

// A heredoc operator and its delimiter; a quoted or escaped delimiter makes the body literal.
const HEREDOC = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([A-Za-z_][\w-]*))/

type Heredoc = { delimiter: string; tabs: boolean; literal: boolean }

/**
 * The command with the text the shell takes literally blanked out: comments, single-quoted strings, the bodies of
 * heredocs with a quoted delimiter, and the plain parts of double-quoted strings and other heredocs. `$(…)` and
 * backtick substitutions stay, since they run even inside double quotes.
 */
export function codeOf(command: string): string {
  return scan(command).code(null)
}

function scan(s: string) {
  let i = 0
  const heredocs: Heredoc[] = []

  // Shell code up to `stop` (the `)` of a `$(`, or the closing backtick), or the end.
  function code(stop: string | null): string {
    let out = ''
    let depth = 0
    while (i < s.length) {
      const c = s[i] as string
      if (c === stop && (stop !== ')' || depth === 0)) {
        i++
        return out
      }
      if (c === '\\') {
        out += s.slice(i, i + 2)
        i += 2
      } else if (c === "'") {
        const end = s.indexOf("'", i + 1)
        const next = end < 0 ? s.length : end + 1
        out += blank(s.slice(i, next))
        i = next
      } else if (c === '"') {
        i++
        out += ` ${quoted(false)} `
      } else if (c === '$' && s[i + 1] === '(') {
        i += 2
        out += `$(${code(')')})`
      } else if (c === '`') {
        i++
        out += `\`${code('`')}\``
      } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1] as string))) {
        const end = s.indexOf('\n', i)
        const next = end < 0 ? s.length : end
        out += blank(s.slice(i, next))
        i = next
      } else if (s.startsWith('<<<', i)) {
        out += '<<<'
        i += 3
      } else if (s.startsWith('<<', i)) {
        const m = HEREDOC.exec(s.slice(i))
        const op = m?.[0] ?? '<<'
        if (m !== null) {
          const literal = m[2] !== undefined || m[3] !== undefined || m[4] === '\\'
          heredocs.push({ delimiter: m[2] ?? m[3] ?? (m[5] as string), tabs: m[1] === '-', literal })
        }
        out += op
        i += op.length
      } else if (c === '\n') {
        i++
        out += `\n${bodies()}`
      } else {
        if (c === '(') depth++
        else if (c === ')') depth--
        out += c
        i++
      }
    }
    return out
  }

  // A double-quoted string's inside, from after its opening quote; with `toEnd`, all that is left (a heredoc body).
  function quoted(toEnd: boolean): string {
    let out = ''
    while (i < s.length) {
      const c = s[i] as string
      if (c === '"' && !toEnd) {
        i++
        return out
      }
      if (c === '\\') {
        out += blank(s.slice(i, i + 2))
        i += 2
      } else if (c === '$' && s[i + 1] === '(') {
        i += 2
        out += `$(${code(')')})`
      } else if (c === '`') {
        i++
        out += `\`${code('`')}\``
      } else {
        out += c === '\n' ? '\n' : ' '
        i++
      }
    }
    return out
  }

  // The bodies of the heredocs opened on the line that just ended, each up to and including its delimiter line.
  function bodies(): string {
    let out = ''
    for (const heredoc of heredocs.splice(0)) {
      const start = i
      let close = s.length
      while (i < s.length) {
        const end = s.indexOf('\n', i)
        const line = s.slice(i, end < 0 ? s.length : end)
        const at = i
        i = end < 0 ? s.length : end + 1
        if ((heredoc.tabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
          close = at
          break
        }
      }
      const body = s.slice(start, close)
      out += (heredoc.literal ? blank(body) : scan(body).quoted(true)) + blank(s.slice(close, i))
    }
    return out
  }

  return { code, quoted }
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

/**
 * The command, run with the account's token: gh reads GH_TOKEN, and git reads it through gh's credential helper.
 * The token is read when the command runs, so it never appears in the command. `export … &&` covers every part of
 * a compound command, and stops it if the token can't be read rather than running it as another account.
 */
export function withAccount(command: string, account: string): string {
  return `export GH_TOKEN="$(gh auth token --user ${account})" && ${command}`
}

/**
 * What the model reads when a command is refused for lacking an account: the command to run instead, written out,
 * so auto mode reviews exactly what runs.
 */
export function refusal(command: string, account: string): string {
  return [
    `gh-account: this command talks to GitHub and must run as the GitHub account ${account}, chosen in the command itself. Nothing ran. Run this instead, unchanged:`,
    '',
    withAccount(command, account),
    '',
    `The token is read when the command runs and is never printed. Start every gh call and git push, pull, fetch, clone or ls-remote here the same way, with export GH_TOKEN="$(gh auth token --user ${account})" && in front.`,
  ].join('\n')
}
