# gh-account

Runs `gh` and git network commands (`push`, `pull`, `fetch`, `clone`, `ls-remote`) as the right GitHub account, so
Claude never has to run `gh auth switch`, and never pushes as the wrong you.

A matching Bash command that doesn't choose an account is refused before it runs. Claude is told the exact command
to run instead, which chooses the account itself:

```sh
export GH_TOKEN="$(gh auth token --user <account>)" && <the command>
```

`gh` reads `GH_TOKEN`, and git reads it through gh's credential helper (the one `gh auth setup-git` installs). Claude
learns the prefix from the first refusal and usually writes it unprompted after that.

### Why refuse instead of rewriting

Versions before 0.3 added the prefix to the command themselves. Auto mode reviews a command before hooks run, and it
refuses any call a hook changed afterwards ("a hook changed this call's input after auto mode reviewed it"), so in
auto mode every rewritten `gh` call and push was blocked. Now the command Claude writes is the command that runs, and
auto mode reviews all of it. The alternatives don't work: an environment set for the session (`CLAUDE_ENV_FILE`) is
open only to shell-command hooks, and setting `GH_TOKEN` for the Claude process per call would leak between
subagents running in different accounts at the same time.

## Why it's safe

- **The token is read when the command runs**, from gh's own keyring. It never appears in the command, the transcript
  or a log. The hook checks that the account has a token and drops it unread.
- **Nothing changes globally.** The active gh account stays as it was; the token applies to that one command.
- **A missing account changes nothing.** If gh has no token for the account (logged out, a typo), the command isn't
  refused and runs as the active account. If the token disappears between the refusal and the retry, `&&` stops the
  command rather than run it as someone else.
- **Commands that choose for themselves are left alone**: `gh auth …`, and anything that sets `GH_TOKEN`,
  `GITHUB_TOKEN` or `GH_ENTERPRISE_TOKEN`.
- **If the hook fails, the command runs unchanged**, exactly as without the mod.

## Configure

Both accounts must be logged in to gh (`gh auth login`, once per account). Then set the plugin's options in `/config`,
or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "gh-account": {
      "options": {
        "rules": "~/work=me-work, org:acme=me-work",
        "default": "me"
      }
    }
  }
}
```

- **`rules`**: comma-separated (or one per line) `<directory>=<account>` and `org:<org>=<account>`. A command that names
  an org's repo (`-R acme/api`, `gh repo clone acme/api`, a `github.com/acme/…` URL) uses that org's rule wherever it
  runs. Otherwise the org of the repo it runs in, read from its `origin` remote, picks the rule, so a worktree in a
  temporary directory still runs as its org's account. Otherwise the deepest directory rule the command runs under
  wins, following its `cd` and `git -C`.
- **`default`**: the account for everything no rule matches. Leave it empty to run those as the active account.

With neither set, the mod does nothing.

## Install

```
/plugin install gh-account --marketplace emilthaudal/claude-plugins
```

In auto mode, the classifier judges the prefixed command as written. If it blocks commands for reading a token with
`gh auth token`, tell it about the prefix in `autoMode.allow` in `~/.claude/settings.json`, for example:

```json
"The gh-account prefix `export GH_TOKEN=\"$(gh auth token --user <account>)\" && ` on gh and git network commands, where <account> is me or me-work. It only picks which of the user's own GitHub accounts runs the command and never prints the token; judge the command that follows as if the prefix were absent"
```

## Test

```
claude plugin validate gh-account
claude plugin test gh-account
```
