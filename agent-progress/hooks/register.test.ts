import { expect, mock, test, type TestBody } from 'claude-code/testing'

// The band only watches: every call it sees must come back exactly as the engine answered it, whatever the band's own
// bookkeeping does. These drive the real hooks with the test's own `on` standing for the engine beneath them.

const RESULT = { result: { stdout: 'hi', stderr: '', interrupted: false }, text: 'hi' }

test('a Bash call passes through with its result unchanged', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const seen: string[] = []
  on('tool.call', async (_$, e) => {
    seen.push(String((e as { command?: string }).command))

    return RESULT as never
  })
  const ran = await $.tool.call({ tool: 'Bash', command: 'echo hi', tool_use_id: 't1' } as never)
  expect(ran).toMatchObject(RESULT)
  expect(seen).toEqual(['echo hi'])
})

test('a failing clock, store or state does not break a call', async ($, on) => {
  on('clock.now', () => {
    throw new Error('clock down')
  })
  on('store.get', () => {
    throw new Error('store down')
  })
  on('tool.call', async () => RESULT as never)
  for (const call of [
    { tool: 'Bash', command: 'pnpm test', tool_use_id: 't1' },
    { tool: 'Read', file_path: '/tmp/x', tool_use_id: 't2' },
    { tool: 'AskUserQuestion', questions: [], tool_use_id: 't3' },
  ]) {
    expect(await $.tool.call(call as never)).toMatchObject(RESULT)
  }
})

test('Agent and Workflow calls pass through', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  const agent = { result: { agentId: 'a1', resolvedModel: 'claude-haiku-4-5' }, text: 'launched' }
  const workflow = { result: { taskId: 'w1', runId: 'wf_abc123' }, text: 'started' }
  on('tool.call', async (_$, e) => ((e as { tool: string }).tool === 'Agent' ? agent : workflow) as never)
  expect(await $.tool.call({ tool: 'Agent', description: 'look', prompt: 'p', tool_use_id: 'a' } as never)).toMatchObject(agent)
  expect(
    await $.tool.call({
      tool: 'Workflow',
      script: "export const meta = { name: 'w', description: 'd' }",
      tool_use_id: 'w',
    } as never),
  ).toMatchObject(workflow)
})

test('AskUserQuestion passes through, however long the person takes', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  const answer = { result: { answers: { q: 'yes' } }, text: 'yes' }
  on('tool.call', async () => {
    await clock.sleep(45_000)

    return answer as never
  })
  const pending = $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q' } as never)
  await clock.advance(45_000)
  expect(await pending).toMatchObject(answer)
})

test('a push answers at once while its CI lookup is still in flight', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  // git and gh never answer: the CI watch the push starts is stuck, and must not hold the call or the next one.
  on('process.run', () => new Promise(() => {}))
  on('tool.call', async () => RESULT as never)
  const push = await $.tool.call({ tool: 'Bash', command: 'git push -u origin HEAD', tool_use_id: 'p' } as never)
  expect(push).toMatchObject(RESULT)
  const after = await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 's' } as never)
  expect(after).toMatchObject(RESULT)
})

// MARK: The band

type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''

  return ((node as Drawn).children ?? []).map(textOf).join('')
}

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 110, scroll: { offset: 0, bodyRows: 12 } }

type Engine = Parameters<TestBody>[0]

async function band($: Engine) {
  const ui = await $.ui.mount({ plugin: 'agent-progress', surface: 'desktop', component: 'AbovePrompt', props: PROPS as never })

  return textOf(await ui.drawn())
}

/** What a command the band runs answers: its exit code and output, given its words and the GH_TOKEN it ran with. */
type Run = (args: string, token: string | undefined) => { exitCode?: number; stdout?: string }

// A session as the hooks see it: started (its timers running), in a turn, with the context window as given.
// The test registers its own `tool.call` answer, and its clock, before this: every hook beneath comes before any call.
async function session($: Engine, on: Parameters<TestBody>[1], given: { store?: Record<string, unknown>; run?: Run } = {}) {
  const run: Run = given.run ?? (() => ({}))
  mock.store(on, given.store ?? {})
  mock.env(on, { HOME: '/home/someone' })
  on('command.register', async () => ({ value: null }) as never)
  on('fs.read', async () => {
    throw new Error('no palette file')
  })
  on('process.run', async (_$, e) => {
    const { argv, init } = e as unknown as { argv: string[]; init?: { env?: Record<string, string> } }
    const { exitCode = 0, stdout = '' } = run(argv.join(' '), init?.env?.GH_TOKEN)

    return { value: { exitCode, stdout, stderr: '' } } as never
  })
  on('session.cwd', async () => ({ value: '/work/plugins' }) as never)
  on('ui.toast', async () => ({ value: null }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: 320_000, window: 1_000_000, percent: 32 } } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't' })
}

// The band ticks once a second, so a minute on the mocked clock is sixty ticks of real work.
const SLOW = { timeoutMs: 30_000 }

// A clone of a repository whose pushed commit has (or lacks) CI config, as git and gh answer for it.
const repoWithCi =
  (ciConfig: string, gh: Run = () => ({})): Run =>
  (args, token) =>
    args.includes('remote get-url')
      ? { stdout: 'https://github.com/someone/plugins.git' }
      : args.includes('--abbrev-ref')
        ? { stdout: 'main' }
        : args.includes('rev-parse HEAD')
          ? { stdout: 'abc123' }
          : args.includes('ls-tree')
            ? { stdout: ciConfig }
            : args.startsWith('gh ')
              ? gh(args, token)
              : {}

for (const [config, isWatched] of [['', false], ['.circleci', true]] as const) {
  test(`a push ${isWatched ? 'is' : 'is not'} watched when the commit ${isWatched ? 'has' : 'has no'} CI config`, SLOW, async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', async () => RESULT as never)
    await session($, on, { run: repoWithCi(config) })
    await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'p' } as never)
    await clock.advance(5_000)
    const text = await band($)
    // The band's text joins its spans with no space between them.
    if (isWatched) expect(text).toContain('CIsomeone/plugins mainwaiting for checks')
    else expect(text).not.toContain('waiting for checks')
    // A branch with no pull request is named once.
    expect(text).not.toContain('main main')
  })
}

test('with CI watching off, a push is not watched', { ...SLOW, options: { watchCi: false } }, async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async () => RESULT as never)
  await session($, on, { run: repoWithCi('.circleci') })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'p' } as never)
  await clock.advance(5_000)
  expect(await band($)).not.toContain('waiting for checks')
})

test('CI is read as whichever logged-in gh account can see the repository', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async () => RESULT as never)
  const tokens: (string | undefined)[] = []
  const gh: Run = (args, token) => {
    if (args === 'gh auth status --hostname github.com') {
      return { stdout: '✓ Logged in to github.com account work (keyring)\n✓ Logged in to github.com account home (keyring)' }
    }
    if (args.startsWith('gh auth token --user ')) return { stdout: `token-${args.split(' ').pop()}` }
    // Only the home account sees someone/plugins; the active one (no token) and work get a 404.
    if (args === 'gh api repos/someone/plugins --silent') return { exitCode: token === 'token-home' ? 0 : 1 }
    if (args.startsWith('gh pr view')) tokens.push(token)

    return { stdout: '' }
  }
  await session($, on, { run: repoWithCi('.github/workflows', gh) })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'p' } as never)
  await clock.advance(1_000)
  expect(tokens).toEqual(['token-home'])
})

test('a push into a folder under ~ is looked for in the home folder', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async () => RESULT as never)
  const dirs: string[] = []
  await session($, on, {
    run: (args, token) => {
      if (args.startsWith('git -C ')) dirs.push(args.split(' ')[2]!)

      return repoWithCi('')(args, token)
    },
  })
  await $.tool.call({ tool: 'Bash', command: 'cd ~/code/plugins && git push', tool_use_id: 'p' } as never)
  await clock.advance(1_000)
  expect(dirs[0]).toBe('/home/someone/code/plugins')
})

test('the turn row shows a running command against its usual time, and the context fill', SLOW, async ($, on) => {
  const usual = { samples: [120_000, 118_000, 125_000], total: 363_000, count: 3 }
  const clock = mock.clock(on)
  on('tool.call', async () => {
    await clock.sleep(90_000)

    return RESULT as never
  })
  await session($, on, { store: { commands: { 'bats tests': usual } } })
  const pending = $.tool.call({ tool: 'Bash', command: 'bats tests/', tool_use_id: 'b' } as never)
  await clock.advance(70_000)
  const text = await band($)
  expect(text).toContain('$ bats tests 1:10 of ~2:00')
  expect(text).toContain('ctx 32% 320k · consider /compact')
  await clock.advance(20_000)
  expect(await pending).toMatchObject(RESULT)
})

test('a question to the person shows how long it has waited', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  on('tool.call', async () => {
    await clock.sleep(60_000)

    return RESULT as never
  })
  await session($, on)
  const pending = $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q' } as never)
  await clock.advance(42_000)
  expect(await band($)).toContain('waiting on you 0:42')
  await clock.advance(18_000)
  await pending
  await clock.advance(1_000)
  expect(await band($)).not.toContain('waiting on you')
})

for (const sounds of [true, false]) {
  test(`a long wait plays macOS's Ping ${sounds ? 'when sounds are on' : 'only when sounds are on'}`, { ...SLOW, options: { sounds, notifications: false } }, async ($, on) => {
    const clock = mock.clock(on)
    on('tool.call', async () => {
      await clock.sleep(40_000)

      return RESULT as never
    })
    const played: string[] = []
    await session($, on, {
      run: args => {
        if (args.startsWith('afplay ')) played.push(args)

        return {}
      },
    })
    const pending = $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q' } as never)
    await clock.advance(40_000)
    await pending
    expect(played).toEqual(sounds ? ['afplay /System/Library/Sounds/Ping.aiff'] : [])
  })
}

test('a model step streams every chunk through, in order, even when bookkeeping fails', async ($, on) => {
  on('clock.now', () => {
    throw new Error('clock down')
  })
  const chunks = [
    { kind: 'input', index: 0, json: '{"command":' },
    { kind: 'input', index: 0, json: '"echo hi"}' },
    { kind: 'text', index: 1, text: 'done' },
  ]
  on('turn.step', async function* () {
    for (const chunk of chunks) yield chunk as never

    return { turnId: 't', index: 0, answer: 'done', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.turn.start({ text: 'go', turnId: 't' }).catch(() => undefined)
  const got: unknown[] = []
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  while (true) {
    const piece = await stream.next()
    if (piece.done) break
    got.push(piece.value)
  }
  expect(got).toEqual(chunks)
})
