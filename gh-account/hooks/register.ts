import type { Register } from 'claude-code'
import { type Accounts, accountFor, accountsFrom, needsAccount, withAccount } from './account'

export const register: Register = (on, options) => {
  // The options are fixed for a load (a change in /config reloads the module). A `~` in them needs the home
  // directory, which takes a call to read, so they are read on the first command that needs them.
  let home: string | null = null
  let accounts: Accounts | null = null

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // The fast path: most commands don't talk to GitHub, and pass with nothing awaited.
    if (!needsAccount(e.command)) return next(e)
    home ??= (await $.env.get('HOME')) ?? '/'
    accounts ??= accountsFrom(options, home)
    if (accounts.rules.length === 0 && accounts.fallback === null) return next(e)
    const cwd = await $.session.cwd().catch(() => home ?? '/')
    const account = accountFor(e.command, cwd, home, accounts)
    return next(account === null ? e : { ...e, command: withAccount(e.command, account) })
  })
    // A failed rewrite runs the command unchanged, as the active gh account: the same as without the mod.
    .catch(($, e, next) => next(e))
}
