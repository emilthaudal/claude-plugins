# readable

A Claude Code mod that draws Claude's replies, and your own prompts, as styled Markdown in the terminal:

- **Prose** in the theme's text colour, with bold, italics, links and inline code styled.
- **Code blocks** on a solid panel, highlighted by language.
- **Quotes** on a lighter panel with a bar.
- **A copy button** under each code block and quote, which copies the text alone: no panel padding, bar or `>` markers.
- **Lists, tables and headings** laid out to the terminal's width, list items marked with `-` and their wrapped lines hung under the first word.
- **Your prompts** on a panel with a `❯` mark. A paste shows as an inset block labelled `pasted · N lines`, folded to 8 lines until you expand the transcript with ctrl+o.
- **One sentence per line** in replies, so long paragraphs are easier to scan.

Links print their URL after the text instead of as terminal hyperlinks, so they read correctly in tmux and other terminals without OSC 8 support, and a copy keeps the URL.

## Copying a selection

In fullscreen mode Claude Code copies what you select with the mouse. readable leaves the wrapping of prose to Claude Code, so a selection copies text the way it was written, ready to paste into Slack, Linear or Notion:

- A paragraph comes back as one line (one line per sentence with `sentencePerLine` on), not broken where the terminal wrapped it.
- A list comes back as Markdown: `- item` and `1. item`, two spaces for each level of nesting, each item on one line.

Claude Code copies every cell a selection covers, and a mod cannot mark cells as unselectable. So a selection that starts at the left edge also takes the reply's two-cell margin, as two spaces before each paragraph and item, and the `●` on the first line. The copy button under a code block or quote takes its text without the panel, padding or bar.

## Install

```
/plugin install readable --marketplace emilthaudal/claude-plugins
```

## Options

Set them in `/config`, or in `~/.claude/settings.json` under `pluginConfigs.readable.options`.

| Option | Values | Default |
| --- | --- | --- |
| `theme` | `terminal`: the colours of the terminal's current theme, read once when Claude starts, every colour held to a readable contrast. In [Rex](https://www.superlogical.com/rex) it is the dark or light theme the app shows, read from the app's settings and the themes it ships; in [Ghostty](https://ghostty.org), Ghostty's theme; elsewhere `embark`. `ghostty` is its old name and does the same. `embark`: matches the [Embark](https://github.com/embark-theme) terminal theme. `dark`: the colours of [glamour](https://github.com/charmbracelet/glamour)'s dark style. | `terminal` |
| `sentencePerLine` | Start each sentence of a reply on a line of its own. | `true` |

Both themes assume a dark terminal background.
