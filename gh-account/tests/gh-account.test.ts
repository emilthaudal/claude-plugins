import { expect, mock, test, type TestBody } from 'claude-code/testing'
import { type Accounts, accountFor, accountsFrom, directoryOf, needsAccount, parseRules, refusal, withAccount } from '../hooks/account'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const HOME = '/home/ada'
const WORK = `${HOME}/work`
const OPTIONS = { rules: '~/work=ada-work, org:acme=ada-work', default: 'ada' }
const ACCOUNTS: Accounts = accountsFrom(OPTIONS, HOME)

/** What became of a command: it ran, unchanged, or it was refused naming the account to run it as. */
type Outcome = { ran: string } | { refused: string }

// Stands for the engine: runs nothing, keeps each command the Bash tool would have run. The session runs in the
// home directory; commands name their own with `cd` or `git -C`. gh holds tokens for the `loggedIn` accounts, and
// the repo checked out in /tmp/acme-api has an acme origin.
function bash($: Engine, on: On, loggedIn = ['ada', 'ada-work']): (command: string) => Promise<Outcome> {
  let ran: string | null = null
  mock.env(on, { HOME })
  on('session.cwd', async () => ({ value: HOME }) as never)
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'git') {
      const isRepo = e.argv[2] === '/tmp/acme-api'
      return { value: { exitCode: isRepo ? 0 : 128, stdout: isRepo ? 'git@github.com:acme/api.git\n' : '', stderr: '' } } as never
    }
    const [, , , , account] = e.argv
    const isKnown = loggedIn.includes(account ?? '')
    return { value: { exitCode: isKnown ? 0 : 1, stdout: isKnown ? 'gho_secret\n' : '', stderr: '' } } as never
  })
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    ran = e.command
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  return async command => {
    ran = null
    const answer = (await $.tool.call({ tool: 'Bash', command }).catch((error: unknown) => ({ deny: String(error) }))) as { deny?: string }
    if (ran !== null) return { ran }
    const account = answer.deny?.match(/--user ([\w-]+)/)?.[1]
    return { refused: account ?? `no account in: ${answer.deny}` }
  }
}

// MARK: Refusing

test('refuses gh in an account directory, naming the account', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  expect(await run(`cd ${WORK}/api && gh pr list`)).toEqual({ refused: 'ada-work' })
})

test('refuses gh elsewhere, naming the default account', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  expect(await run('gh pr list')).toEqual({ refused: 'ada' })
})

test('refuses a git push, naming the account for its directory', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  expect(await run('git -C ~/work/x push -u origin HEAD')).toEqual({ refused: 'ada-work' })
})

test("a repo's origin picks its org's account wherever it is checked out", { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  expect(await run('cd /tmp/acme-api && git push -u origin HEAD')).toEqual({ refused: 'ada-work' })
  expect(await run('cd /tmp/other && git push')).toEqual({ refused: 'ada' })
})

test('runs the command it suggests, unchanged', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  const command = `cd ~/work/api\ngh pr create --body-file - <<'EOF'\nline one\nEOF`
  const suggested = withAccount(command, 'ada-work')
  expect(suggested).toBe(`export GH_TOKEN="$(gh auth token --user ada-work)" && ${command}`)
  expect(refusal(command, 'ada-work')).toContain(`\n${suggested}\n`)
  expect(await run(suggested)).toEqual({ ran: suggested })
})

test('never puts the token in the refusal', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  const outcome = await run('gh pr list')
  expect(JSON.stringify(outcome)).not.toContain('gho_secret')
  expect(refusal('gh pr list', 'ada')).not.toContain('gho_secret')
})

test('runs as the active account when gh has no token for the account', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on, ['ada'])
  expect(await run(`cd ${WORK} && gh pr list`)).toEqual({ ran: `cd ${WORK} && gh pr list` })
  expect(await run('gh pr list')).toEqual({ refused: 'ada' })
})

test('leaves other commands, gh auth and chosen tokens alone', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  for (const command of ['git status', 'git commit -m "push the fix"', 'gh auth switch --user ada', 'GH_TOKEN=x gh pr list', 'echo gh']) {
    expect(await run(`cd ${WORK} && ${command}`)).toEqual({ ran: `cd ${WORK} && ${command}` })
  }
})

test('leaves a command that only quotes gh in a heredoc or a string, like an orch receipt', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  const receipt = `~/.claude/skills/orchestrate/bin/orch report <<'EOF'\n## Verified\n\`gh pr view 19\` gave MERGED; then (gh pr checks) and git push origin x\nEOF`
  for (const command of [receipt, `orch add --from 61 "retry; gh pr view (gh api)"`, `echo 'x | gh pr list'`, `ls # then gh pr list`]) {
    expect(await run(`cd ${WORK} && ${command}`)).toEqual({ ran: `cd ${WORK} && ${command}` })
  }
})

test('still refuses gh that a quoted string or an unquoted heredoc substitutes', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  for (const command of ['echo "me: $(gh api user --jq .login)"', 'cat <<EOF\n`gh api user`\nEOF', `cat <<'EOF'\ntext\nEOF\ngh pr list`]) {
    expect(await run(`cd ${WORK} && ${command}`)).toEqual({ refused: 'ada-work' })
  }
})

test('does nothing until rules or a default are set', async ($, on) => {
  const run = bash($, on)
  expect(await run(`cd ${WORK} && gh pr list`)).toEqual({ ran: `cd ${WORK} && gh pr list` })
})

test('without a default, a command no rule matches runs as the active account', { options: { rules: OPTIONS.rules } }, async ($, on) => {
  const run = bash($, on)
  expect(await run('gh pr list')).toEqual({ ran: 'gh pr list' })
  expect(await run('gh pr list -R acme/api')).toEqual({ refused: 'ada-work' })
})

// MARK: Options

test('reads rules from commas or lines, expanding ~ and skipping malformed entries', () => {
  expect(parseRules(' ~/work = ada-work ,\norg:Acme=ada-work, nonsense, /x=bad;login, =ada, /y=', HOME)).toEqual([
    { kind: 'directory', path: WORK, account: 'ada-work' },
    { kind: 'org', org: 'acme', account: 'ada-work' },
  ])
  expect(accountsFrom({ default: 'not a login' }, HOME)).toEqual({ rules: [], fallback: null })
})

// MARK: Matching

test('spots gh and git network calls anywhere in a command', () => {
  expect(needsAccount('cd x && gh pr checks 12 --watch')).toBe(true)
  expect(needsAccount('for i in 1 2; do gh run view; sleep 5; done')).toBe(true)
  expect(needsAccount('echo $(gh api user --jq .login)')).toBe(true)
  expect(needsAccount('git -C ../repo fetch origin')).toBe(true)
  expect(needsAccount('git ls-remote https://github.com/a/b.git')).toBe(true)
  expect(needsAccount('git log --oneline -3')).toBe(false)
  expect(needsAccount('rg "gh pr" src')).toBe(false)
  expect(needsAccount('ls -la')).toBe(false)
  expect(needsAccount(withAccount('git push', 'ada'))).toBe(false)
})

// MARK: Resolving

test('follows cd and git -C, relative and home paths included', () => {
  expect(directoryOf('cd ~/work/a && gh pr view', '/tmp', HOME)).toBe(`${WORK}/a`)
  expect(directoryOf('cd "../work/b"; gh pr view', `${HOME}/x`, HOME)).toBe(`${WORK}/b`)
  expect(directoryOf('git -C ../plugins push', WORK, HOME)).toBe(`${HOME}/plugins`)
})

test('an org the command names picks the account wherever it runs', () => {
  expect(accountFor('gh pr view 5 -R acme/api', '/tmp', HOME, ACCOUNTS)).toBe('ada-work')
  expect(accountFor('gh repo clone Acme/api', HOME, HOME, ACCOUNTS)).toBe('ada-work')
  expect(accountFor('git clone https://github.com/acme/x.git', HOME, HOME, ACCOUNTS)).toBe('ada-work')
  expect(accountFor('gh pr list', `${WORK}-old`, HOME, ACCOUNTS)).toBe('ada')
})

test("the command's org comes before the repo's, and the repo's before its directory", () => {
  const accounts = accountsFrom({ rules: '~/work=ada-work, org:acme=ada-work, org:ada=ada' }, HOME)
  expect(accountFor('gh pr view 5 -R ada/x', WORK, HOME, accounts, 'acme')).toBe('ada')
  expect(accountFor('gh pr list', WORK, HOME, accounts, 'ada')).toBe('ada')
  expect(accountFor('gh pr list', '/tmp', HOME, accounts, 'Acme')).toBe('ada-work')
  expect(accountFor('gh pr list', WORK, HOME, accounts, 'unknown')).toBe('ada-work')
})

test('the deepest directory rule wins', () => {
  const accounts = accountsFrom({ rules: '~/work=ada-work, ~/work/oss=ada' }, HOME)
  expect(accountFor('gh pr list', `${WORK}/oss/lib`, HOME, accounts)).toBe('ada')
  expect(accountFor('gh pr list', `${WORK}/api`, HOME, accounts)).toBe('ada-work')
})
