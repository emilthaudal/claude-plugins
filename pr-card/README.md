# pr-card

A Claude Code mod that draws a pull request as a card when Claude pushes or works on it, and keeps its status above the prompt.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ Refresh sessions in the auth middleware #128                         ● Open │
│                                                                              │
│ ◉    Merge into main                                            2 conflicts │
│ ●      Add session refresh tests  feat/session-refresh   d29f50  You · now │
│ │ ◇    Rotate session keys  main                        a3f9c1  Lena · 18m │
│ ● │    Refresh sessions near expiry                      c70a92  You · 25m │
│ │/                                                                           │
│ ○      Bump next to 16.3                                  9c2d4a  Sam · 3h │
│ Conflicts in src/auth.ts, src/middleware.ts                                  │
│ ◌ Lint  ✓ Tests  ✓ Preview                                                   │
│ Pushed to origin                                        +482 −37 ■■■■■ │
╰──────────────────────────────────────────────────────────────────────────────╯
 ● #128 2 conflicts  +482 −37 ■■■■■  ◌ 1 running  feat/session-refresh
```

- **The card** replaces the output of `git push` and `gh pr create`, `merge`, `checks`, `view`, `status`, `ready`, `edit` and `reopen`. It shows the PR's title, number and state, then the branch and its base drawn as `git log --graph --first-parent` with each lane in its own colour, your commits bright and other people's dim. Commits only the base has are marked `◇`. A merge into the branch is one row, with the commits it brings in counted, so a stack of branches merged up into each other stays short. A branch that doesn't match its remote shows both labels, `AS-480` and `origin/AS-480`. When a command pushes a branch by name, the card shows that branch even if the command ends on another one. A merge row says whether the branch merges cleanly. Below the graph are the CI checks, with failing and running ones first, and the lines added and removed.
- **Conflicts** come from a trial `git merge-tree` against the base, so the card names the files. Nothing in your working tree changes.
- **The pill above the prompt** shows the PR for the repository Claude last worked on: merge state, size and checks. It reads the PR again at the end of a turn, and every minute while checks are running.
- **GitHub accounts:** when the active `gh` account can't see a repository, the mod tries your other logged-in accounts and remembers the one that worked. Work and personal repos both work without `gh auth switch`.

The card reads the base as your last fetch left it. GitHub's own mergeability check covers anything newer.

## Install

```
/plugin install pr-card --marketplace emilthaudal/claude-plugins
```

It sits alongside `readable`: that mod draws replies and prompts, this one draws command results and the band.
