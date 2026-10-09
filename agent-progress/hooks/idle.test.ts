import { expect, mock, test, type TestBody } from 'claude-code/testing'

// The band runs in every session, so an idle one must cost nothing. These count what it asks of the engine over a
// quiet minute (state reads stand for its timer's work), and that a turn reads the context window per step, not per
// second. Before the clock slept when idle, a quiet minute cost 300 state reads and a turn's minute 60 usage reads.

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

async function minute($: Engine, on: On, withTurn: boolean) {
  const counts = { reads: 0, usage: 0 }
  on('state.get', async (_$, e, next) => {
    counts.reads += 1
    return next(e)
  })
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/someone' })
  on('command.register', async () => ({ value: null }) as never)
  on('fs.read', async () => {
    throw new Error('no palette file')
  })
  on('session.usage', async () => {
    counts.usage += 1
    return { value: { startedAt: 0, context: { tokens: 10_000, window: 200_000, percent: 5 } } } as never
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  if (withTurn) await $.turn.start({ text: 'go', turnId: 't' })
  // Past any linger, then one minute measured.
  await clock.advance(70_000)
  const before = { ...counts }
  await clock.advance(60_000)

  return { reads: counts.reads - before.reads, usage: counts.usage - before.usage }
}

test('an idle session asks nothing of the engine', { timeoutMs: 30_000 }, async ($, on) => {
  expect(await minute($, on, false)).toEqual({ reads: 0, usage: 0 })
})

test('a turn with no steps reads the context window not at all while it runs', { timeoutMs: 30_000 }, async ($, on) => {
  expect((await minute($, on, true)).usage).toBe(0)
})
