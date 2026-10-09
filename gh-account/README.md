# gh-account

Runs `gh` and git network commands (`push`, `pull`, `fetch`, `clone`, `ls-remote`) as the right GitHub account, so
Claude never has to run `gh auth switch`, and never pushes as the wrong you.

Each matching Bash command gets one line in front of it:

```sh
GH_ACCOUNT_MOD_TOKEN="$(gh auth token --user <account> 2>/dev/null)" && [ -n "$GH_ACCOUNT_MOD_TOKEN" ] && export GH_TOKEN="$GH_ACCOUNT_MOD_TOKEN"; unset GH_ACCOUNT_MOD_TOKEN
```

`gh` reads `GH_TOKEN`, and git reads it through gh's credential helper (the one `gh auth setup-git` installs).

## Why it's safe

- **The token is read when the command runs**, from gh's own keyring. It never appears in the command, the transcript
  or a log.
- **Nothing changes globally.** The active gh account stays as it was; the token applies to that one command.
- **A missing account changes nothing.** If gh has no token for the account (logged out, a typo), `GH_TOKEN` is left
  alone and the command runs as the active account.
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
  runs. Otherwise the deepest directory rule the command runs under wins, following its `cd` and `git -C`.
- **`default`**: the account for everything no rule matches. Leave it empty to run those as the active account.

With neither set, the mod does nothing.

## Install

```
/plugin install gh-account --marketplace emilthaudal/claude-plugins
```

In auto mode, the permission classifier sees the rewritten command. If it blocks commands for reading a token with
`gh auth token`, add an allow rule for them.

## Test

```
claude plugin validate gh-account
claude plugin test gh-account
```
