import type { EngineInterface, Register } from 'claude-code'
import { type Accounts, accountFor, accountsFrom, needsAccount, refusal } from './account'

export const register: Register = (on, options) => {
  // The options are fixed for a load (a change in /config reloads the module). A `~` in them needs the home
  // directory, which takes a call to read, so they are read on the first command that needs them.
  let home: string | null = null
  let accounts: Accounts | null = null

  // The hook never rewrites a command: auto mode refuses any call a hook changed after its review. A command that
  // needs an account and doesn't choose one is refused instead, with the command to run, which auto mode reviews.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // The fast path: most commands don't talk to GitHub, and pass with nothing awaited.
    if (!needsAccount(e.command)) return next(e)
    home ??= (await $.env.get('HOME')) ?? '/'
    accounts ??= accountsFrom(options, home)
    if (accounts.rules.length === 0 && accounts.fallback === null) return next(e)
    const cwd = await $.session.cwd().catch(() => home ?? '/')
    const account = accountFor(e.command, cwd, home, accounts)
    if (account === null || !(await isLoggedIn($, account))) return next(e)
    return { deny: refusal(e.command, account) }
  })
    // A failed check runs the command unchanged, as the active gh account: the same as without the mod.
    .catch(($, e, next) => next(e))
}

/**
 * Whether gh holds a token for the account. One it doesn't (logged out, a typo) is never asked for, so the command
 * runs as the active account. The token is read only to see that it's there, and is dropped.
 */
async function isLoggedIn($: EngineInterface, account: string): Promise<boolean> {
  const { exitCode, stdout } = await $.process.run(['gh', 'auth', 'token', '--user', account], { timeoutMs: 10_000 })
  return exitCode === 0 && stdout.trim() !== ''
}
