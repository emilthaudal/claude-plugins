# agent-progress

A band above the Claude Code prompt that shows what the current turn is waiting on, and nothing when it is idle.

```
◆ 1:12  $ pnpm test 1:10 of ~2:00                      14 tools  ctx 41% 82k
● CI someone/plugins#12 main  running 5/8                         3:40 of ~6:00
◆ review-changes ━━━━━━━━━━╺──────────  50%  2/4 agents · Review ▸ Verify  2:05
   ├─ ✓ agent 1                                  haiku 4.5  done ×6     0:48
   ╰─ ◆ agent 2                                  haiku 4.5  Grep ×3     1:02
```

## Rows

**Turn.** Elapsed time, then what Claude is doing:

- `$ <command> 1:10 of ~2:00`: a shell command that has run for more than 5 seconds, against how long that command usually takes. The usual time is the median of its last 20 runs once there are three. Commands are grouped by their first word or two (`pnpm test`, `docker build`, `bats tests`). Polling loops and `sleep` are not timed. A run past twice its usual time (and over a minute) turns red, and you get one toast.
- `waiting on you 0:42`: Claude has asked a question (AskUserQuestion, or a plan to approve). After 30 seconds you also get a toast, a macOS notification and a sound.

On the right are the turn's tool count and the context window's fill (`ctx 41% 82k`). The fill turns amber above 200k tokens or 70% of the window, and red above 300k or 85%, where it suggests `/compact`. Model steps get slower as the context grows.

**CI.** After `git push` or `gh pr create`, the pushed commit's GitHub checks: commit statuses (CircleCI) and check runs (GitHub Actions and other apps). The row shows how many checks are done, the failed jobs, and the elapsed time against the repository's usual CI time. It is only shown when the pushed commit has `.circleci/` or `.github/workflows/`. When CI finishes you get a toast, a notification and a sound. If Claude is idle, it is also sent the result (`CI failed for someone/plugins#12 (main) after 6:10: lint.`) so it can carry on. Polling backs off from every 15 seconds to every minute, and stops when CI finishes or after an hour.

CI is read with `gh`, as the active account. If that account can't see the repository, the band tries the other accounts `gh auth status` lists, so a work and a personal account both work without `gh auth switch`.

**Workflows.** A `Workflow` run as a progress bar of its agents, with its phases and each agent's model, current tool and time. Plain `Agent` subagents are not shown: Claude Code already lists them under the prompt.

The band uses no timer while nothing shows. It ticks once a second while a row is up, and the bars shimmer ten times a second only while a workflow runs.

## Commands

- `/slowest`: the shell commands that took the most time in total, across sessions, with their usual time and count.
- `/progress`: hide or show the band.
- `/progress-clear`: remove finished workflow bars and CI rows.

## Options

Set these in the plugin's config menu, or under `pluginConfigs` in `~/.claude/settings.json`:

| Option | Default | |
| --- | --- | --- |
| `watchCi` | `true` | Watch CI after a push |
| `tellClaudeWhenCiFinishes` | `true` | Send Claude the CI result when it finishes while Claude is idle |
| `notifications` | `true` | macOS notifications for a long wait and for finished CI |
| `sounds` | `true` | macOS system sounds (Ping, Glass, Basso) for the same |
| `contextWarnTokens` | `200000` | Tokens above which the context meter turns amber |
| `contextBadTokens` | `300000` | Tokens above which it turns red |
| `paletteFile` | `~/.claude/aurora-palette.json` | A JSON file overriding the band's colours; a missing file is fine |

A palette file names any of `lavender`, `muted`, `rule`, `pink`, `purple`, `blue`, `cyan`, `ok`, `warn` and `bad` as `#rrggbb`, and `stops`, the bars' gradient, as a list of at least two. A status line script can read the same file so the two match.

## Install

```
/plugin install agent-progress --marketplace emilthaudal/claude-plugins
```

It needs [`gh`](https://cli.github.com), logged in, for the CI rows. Notifications and sounds use macOS's `osascript` and `afplay`; elsewhere they are skipped.

## Develop

```
claude plugin validate agent-progress
claude plugin test agent-progress
```
