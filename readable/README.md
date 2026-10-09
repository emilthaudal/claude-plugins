# readable

A Claude Code mod that draws Claude's replies, and your own prompts, as styled Markdown in the terminal:

- **Prose** in the theme's text colour, with bold, italics, links and inline code styled.
- **Code blocks** on a solid panel, highlighted by language.
- **Quotes** on a lighter panel with a bar.
- **Lists, tables and headings** laid out to the terminal's width.
- **Your prompts** on a panel with a `❯` mark. A paste shows as an inset block labelled `pasted · N lines`, folded to 8 lines until you expand the transcript with ctrl+o.
- **One sentence per line** in replies, so long paragraphs are easier to scan.

Links print their URL after the text instead of as terminal hyperlinks, so they read correctly in tmux and other terminals without OSC 8 support.

## Install

```
/plugin install readable --marketplace emilthaudal/claude-plugins
```

## Options

Set them in `/config`, or in `~/.claude/settings.json` under `pluginConfigs.readable.options`.

| Option | Values | Default |
| --- | --- | --- |
| `theme` | `embark`: matches the [Embark](https://github.com/embark-theme) terminal theme. `dark`: the colours of [glamour](https://github.com/charmbracelet/glamour)'s dark style. | `embark` |
| `sentencePerLine` | Start each sentence of a reply on a line of its own. | `true` |

Both themes assume a dark terminal background.
