import { atom, memberOf, read, update } from 'claude-code'
import type { Hook, Register } from 'claude-code'
import type { Card } from '../types'
import { directoryOf, type Kind, prCommand, pushedBranch } from './command'
import { drawCard, drawPill } from './draw'
import { gather, ghRunner, type Run } from './git'

const cards = atom({ plugin: 'pr-card', key: 'cards' } as const, null)
const band = atom({ plugin: 'pr-card', key: 'band' } as const, null)

// The engine keeps a column clear at each edge of the transcript, so a row as wide as the viewport would spill.
const EDGE = 2
const UNMEASURED_COLUMNS = 120
// How often the band reads its PR again while checks run or GitHub is still working out mergeability.
const POLL_MS = 60_000
// The least time between two reads at the end of a turn.
const TURN_REFRESH_MS = 30_000

type Engine = Parameters<Hook<'ui.render'>>[0]

/** What the module keeps between hooks: none of it outlives a reload, which reads the band again at session.start. */
type Session = {
  /** The gh account that answered in each repository, so the next read goes straight to it. */
  accounts: Map<string, { env?: Record<string, string> }>
  /** The repository the band follows: the session's, then the last one a PR command ran in. */
  bandDir: string | null
  readAt: number
  poll: { cancel: () => void } | null
}

/** Whether the band's PR is still settling: checks running, or mergeability not yet known. */
const isSettling = (card: Card | null) =>
  card !== null && card.state === 'open' && (card.checks.some(c => c.state === 'pending') || card.merge.kind === 'unknown')

async function readCard($: Engine, session: Session, dir: string, kind: Kind, branch: string | null = null): Promise<Card | null> {
  const git: Run = async (argv, env) => {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd: dir, env, timeoutMs: 15_000 })
    return { exitCode, stdout, stderr }
  }
  const account = session.accounts.get(dir) ?? {}
  session.accounts.set(dir, account)
  return gather(git, ghRunner(git, account), kind, await $.clock.now(), branch)
}

/** Shows `card` in the band, and reads it again in a minute while it is still settling. */
async function showInBand($: Engine, session: Session, card: Card | null): Promise<void> {
  session.readAt = await $.clock.now()
  await update($, band, () => (card?.number == null ? null : card))
  session.poll?.cancel()
  session.poll = isSettling(card) ? $.clock.after(POLL_MS, () => void refreshBand($, session)) : null
}

async function refreshBand($: Engine, session: Session): Promise<void> {
  if (session.bandDir === null) return
  const card = await readCard($, session, session.bandDir, 'view').catch(() => null)
  await showInBand($, session, card)
}

export const register: Register = on => {
  const session: Session = { accounts: new Map(), bandDir: null, readAt: 0, poll: null }

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    session.bandDir = await $.session.cwd().catch(() => null)
    void refreshBand($ as Engine, session)
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const kind = prCommand(e.command)
    if (kind === null) return ran
    // The command has run: nothing below may throw, or the hook's failure would hide its result.
    try {
      const [cwd, home] = await Promise.all([$.session.cwd(), $.env.get('HOME')])
      const dir = directoryOf(e.command, cwd, home ?? '/')
      // A push that names its branch is about that branch, wherever the command left the checkout.
      const card = await readCard($ as Engine, session, dir, kind, kind === 'push' ? pushedBranch(e.command) : null)
      if (card !== null) {
        await update($, memberOf(cards, { requestId: e.tool_use_id }), () => card)
        session.bandDir = dir
        await showInBand($ as Engine, session, card)
      }
    } catch {
      // No card: the engine draws the command's output as usual.
    }
    return ran
  })

  // A turn may have committed, rebased or pushed by other means; the band catches up when it ends.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if ((await $.clock.now()) - session.readAt > TURN_REFRESH_MS) void refreshBand($ as Engine, session)
    return ran
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal' || e.props.tool !== 'Bash' || e.props.isErrored) return next(e)
    const card = await read($, memberOf(cards, e))
    if (card === null) return next(e)
    return drawCard($.ui.resolve(e) as never, card, (e.viewport?.columns ?? UNMEASURED_COLUMNS) - EDGE)
  }).catch(($, e, next) => next(e))

  // The pill sits above whatever else the band shows.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const card = e.surface === 'terminal' && !e.props.hasSurvey ? await read($, band) : null
    if (card === null) return next(e)
    const ui = $.ui.resolve(e)
    const rest = await next(e)
    const pill = drawPill(ui as never, card)
    return rest ? ui.Box({ flexDirection: 'column', children: [pill, rest] }) : pill
  }).catch(($, e, next) => next(e))
}
