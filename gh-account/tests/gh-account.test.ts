import { expect, mock, test, type TestBody } from 'claude-code/testing'
import { type Accounts, accountFor, accountsFrom, directoryOf, needsAccount, parseRules, withAccount } from '../hooks/account'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

const HOME = '/home/ada'
const WORK = `${HOME}/work`
const OPTIONS = { rules: '~/work=ada-work, org:acme=ada-work', default: 'ada' }
const ACCOUNTS: Accounts = accountsFrom(OPTIONS, HOME)
const TOKEN = (account: string) => withAccount('', account)

// Stands for the engine: runs nothing, keeps each command the Bash tool would have run. The session runs in the
// home directory; commands name their own with `cd` or `git -C`.
function bash($: Engine, on: On): (command: string) => Promise<string> {
  let ran = ''
  mock.env(on, { HOME })
  on('session.cwd', async () => ({ value: HOME }) as never)
  on('tool.call', { tool: 'Bash' }, (_, e) => {
    ran = e.command
    return { result: { stdout: '', stderr: '', interrupted: false } } as never
  })
  return async command => {
    await $.tool.call({ tool: 'Bash', command })
    return ran
  }
}

// MARK: Rewriting

test('runs gh as the account for its directory', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  const command = `cd ${WORK}/api && gh pr list`
  expect(await run(command)).toBe(`${TOKEN('ada-work')}${command}`)
})

test('runs gh as the default account elsewhere', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  expect(await run('gh pr list')).toBe(`${TOKEN('ada')}gh pr list`)
})

test('runs a git push as the account for its directory', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  const command = `git -C ~/work/x push -u origin HEAD`
  expect(await run(command)).toBe(`${TOKEN('ada-work')}${command}`)
})

test('keeps a heredoc and a multi-line command whole, after the token line', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  const command = `cd ~/work/api\ngh pr create --body-file - <<'EOF'\nline one\nEOF`
  expect(await run(command)).toBe(`${TOKEN('ada-work')}${command}`)
})

test('leaves other commands, gh auth and chosen tokens alone', { options: OPTIONS }, async ($, on) => {
  const run = bash($, on)
  for (const command of ['git status', 'git commit -m "push the fix"', 'gh auth switch --user ada', 'GH_TOKEN=x gh pr list', 'echo gh']) {
    expect(await run(`cd ${WORK} && ${command}`)).toBe(`cd ${WORK} && ${command}`)
  }
})

test('does nothing until rules or a default are set', async ($, on) => {
  const run = bash($, on)
  expect(await run(`cd ${WORK} && gh pr list`)).toBe(`cd ${WORK} && gh pr list`)
})

test('without a default, a command no rule matches runs as the active account', { options: { rules: OPTIONS.rules } }, async ($, on) => {
  const run = bash($, on)
  expect(await run('gh pr list')).toBe('gh pr list')
  expect(await run('gh pr list -R acme/api')).toBe(`${TOKEN('ada-work')}gh pr list -R acme/api`)
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

test('the deepest directory rule wins', () => {
  const accounts = accountsFrom({ rules: '~/work=ada-work, ~/work/oss=ada' }, HOME)
  expect(accountFor('gh pr list', `${WORK}/oss/lib`, HOME, accounts)).toBe('ada')
  expect(accountFor('gh pr list', `${WORK}/api`, HOME, accounts)).toBe('ada-work')
})
