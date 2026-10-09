import type { Syntax } from './theme'

// MARK: Grammar

export type Token = { text: string; syntax: Syntax }

/** One way a stretch of code can start: a sticky pattern and what it is, or a function that splits the match. */
type Rule = [pattern: RegExp, tag: Syntax | ((match: string) => Token[])]

/** A language: its rules in order of precedence, and the classes of its reserved words. */
type Grammar = {
  rules: Rule[]
  words?: Map<string, Syntax>
  /** Words whose next name is being declared: `def` makes the name after it a function. */
  declares?: Map<string, Syntax>
  caseless?: boolean
}

/** Space-separated words, all of one class. */
function words(...groups: [Syntax, string][]): Map<string, Syntax> {
  const map = new Map<string, Syntax>()
  for (const [syntax, list] of groups) for (const word of list.trim().split(/\s+/)) map.set(word, syntax)
  return map
}

const sticky = (source: string) => new RegExp(source, 'y')

// MARK: Shared rules

// A line still streaming in has no closing quote: the string runs to the end of the line.
const quoted = (q: string) => sticky(`${q}(?:[^${q}\\\\\\n]|\\\\.)*${q}?`)
const tripleQuoted = (q: string) => sticky(`${q}{3}[\\s\\S]*?(?:${q}{3}|$)`)
const TEMPLATE = sticky('`(?:[^`\\\\]|\\\\[\\s\\S])*`?')

const ESCAPE = /(\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F]{1,6}\}|u[\da-fA-F]{4}|.))/

/** A string, with its escapes drawn apart. */
function stringParts(literal: string): Token[] {
  return literal
    .split(ESCAPE)
    .filter(part => part !== '')
    .map(part => ({ text: part, syntax: part.startsWith('\\') && part.length > 1 ? 'escape' : 'string' }))
}

const SPACE: Rule = [sticky('\\s+'), 'plain']
const NUMBER: Rule = [sticky('(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)\\w*'), 'number']
const IDENTIFIER = sticky('[A-Za-z_$][\\w$]*')
const OPERATOR: Rule = [sticky('=>|->|::|[-+*/%=<>!&|^~?:]+'), 'operator']
const PUNCTUATION: Rule = [sticky('[()[\\]{};,.]'), 'punctuation']
const DECORATOR: Rule = [sticky('@[A-Za-z_][\\w.]*'), 'decorator']
const slashComments: Rule[] = [[sticky('//[^\\n]*'), 'comment'], [sticky('/\\*[\\s\\S]*?(?:\\*/|$)'), 'comment']]
const hashComment: Rule = [sticky('#[^\\n]*'), 'comment']
const string = (pattern: RegExp): Rule => [pattern, stringParts]

/** What every C-like grammar ends with: numbers, then operators and punctuation. */
const TAIL: Rule[] = [NUMBER, OPERATOR, PUNCTUATION]

// MARK: Tokenizer

function tokenize(source: string, grammar: Grammar): Token[] {
  const tokens: Token[] = []
  const rules: Rule[] = [SPACE, ...grammar.rules]
  const fold = (word: string) => (grammar.caseless ? word.toLowerCase() : word)
  let declaring: Syntax | undefined
  let pos = 0
  while (pos < source.length) {
    let matched = false
    for (const [pattern, tag] of rules) {
      pattern.lastIndex = pos
      const m = pattern.exec(source)
      if (m === null || m[0] === '') continue
      const text = m[0]
      if (tag !== 'plain') declaring = undefined
      if (typeof tag === 'function') tokens.push(...tag(text))
      else tokens.push({ text, syntax: tag })
      pos += text.length
      matched = true
      break
    }
    if (matched) continue
    IDENTIFIER.lastIndex = pos
    const name = IDENTIFIER.exec(source)?.[0]
    if (name !== undefined && grammar.words !== undefined) {
      const word = fold(name)
      // A declaring keyword names only what comes right after it, so `function (` leaves the next name alone.
      tokens.push({ text: name, syntax: declaring ?? grammar.words.get(word) ?? 'plain' })
      declaring = grammar.declares?.get(word)
      pos += name.length
      continue
    }
    declaring = undefined
    tokens.push({ text: source[pos] ?? '', syntax: 'plain' })
    pos++
  }
  return merge(tokens)
}

// Neighbours of one class join, so a line is drawn with as few spans as it needs.
function merge(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (const token of tokens) {
    const last = out.at(-1)
    if (last !== undefined && last.syntax === token.syntax) last.text += token.text
    else out.push({ ...token })
  }
  return out
}

// MARK: Languages

const JAVASCRIPT: Grammar = {
  rules: [...slashComments, string(TEMPLATE), string(quoted('"')), string(quoted("'")), DECORATOR, ...TAIL],
  words: words(
    ['keyword', `
      async await break case catch continue debugger default delete do else finally for if in instanceof new of
      return switch throw try typeof void while with yield as satisfies keyof infer is true false null undefined
      NaN Infinity this super`],
    ['declaration', `
      const let var function class interface type enum namespace declare abstract extends implements export
      private protected public readonly static override get set`],
    ['module', 'import from require'],
    ['type', 'string number boolean any unknown never object symbol bigint'],
    ['builtin', `
      Array Boolean Date Error Function JSON Map Math Number Object Promise Proxy Reflect RegExp Set String Symbol
      WeakMap WeakSet console document globalThis process window fetch parseInt parseFloat setTimeout clearTimeout`],
  ),
  declares: words(['function', 'function'], ['class', 'class interface enum type']),
}

const PYTHON: Grammar = {
  rules: [hashComment, string(tripleQuoted('"')), string(tripleQuoted("'")), string(quoted('"')), string(quoted("'")), DECORATOR, ...TAIL],
  words: words(
    ['keyword', `
      and as assert async await break continue del elif else except finally for global if in is lambda nonlocal
      not or pass raise return try while with yield match case True False None`],
    ['declaration', 'def class'],
    ['module', 'import from'],
    ['builtin', `
      abs all any bool bytes dict enumerate filter float getattr hasattr int isinstance len list map max min open
      print range repr reversed set setattr sorted str sum super tuple type zip self cls`],
  ),
  declares: words(['function', 'def'], ['class', 'class']),
}

const GO: Grammar = {
  rules: [...slashComments, string(sticky('`[^`]*`?')), string(quoted('"')), string(quoted("'")), ...TAIL],
  words: words(
    ['keyword', `
      break case chan continue default defer else fallthrough for go goto if map range return select switch
      true false nil iota`],
    ['declaration', 'const func interface struct type var'],
    ['module', 'package import'],
    ['type', `
      any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8
      uint16 uint32 uint64 uintptr`],
    ['builtin', 'append cap clear close copy delete len make max min new panic print println recover'],
  ),
  declares: words(['function', 'func'], ['class', 'type']),
}

const RUST: Grammar = {
  rules: [...slashComments, string(quoted('"')), [sticky("'(?:\\\\.|[^'\\\\\\n])'"), 'string'], [sticky('#!?\\[[^\\]\\n]*\\]?'), 'decorator'], ...TAIL],
  words: words(
    ['keyword', `
      as async await break continue dyn else false for if in let loop match move mut ref return self Self super
      true unsafe where while`],
    ['declaration', 'const enum fn impl pub static struct trait type'],
    ['module', 'use mod crate extern'],
    ['type', 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box'],
    ['builtin', 'Some None Ok Err'],
  ),
  declares: words(['function', 'fn'], ['class', 'struct enum trait']),
}

const C_LIKE: Grammar = {
  rules: [
    [sticky('(?<=(?:^|\\n)[ \\t]*)#[ \\t]*\\w+[^\\n]*'), 'directive'],
    ...slashComments,
    string(tripleQuoted('"')),
    string(quoted('"')),
    string(quoted("'")),
    DECORATOR,
    ...TAIL,
  ],
  words: words(
    ['keyword', `
      break case catch continue default do else finally for goto if new return sizeof switch this throw try while
      true false null nullptr NULL throws instanceof super when guard`],
    ['declaration', `
      class struct enum union typedef const static extern public private protected internal virtual override final
      abstract extends implements interface template typename auto inline volatile var val let fun func object
      data sealed open`],
    ['module', 'import package namespace using'],
    ['type', `
      void int char short long float double bool boolean byte unsigned signed size_t string String Int Double Float
      Bool Boolean Long Unit Any`],
  ),
  declares: words(['function', 'fun func'], ['class', 'class struct enum interface union object']),
}

const SHELL: Grammar = {
  rules: [
    [sticky('(?<=^|\\s)#[^\\n]*'), 'comment'],
    string(quoted('"')),
    [sticky("'[^']*'?"), 'string'],
    ...TAIL,
  ],
  words: words(
    ['keyword', 'if then else elif fi case esac for while until do done in function select return exit export local readonly declare unset'],
    ['builtin', `
      alias awk cat cd cp curl echo eval exec find git grep ls mkdir mv printf pwd read rm sed set shift source test trap
      wait`],
  ),
}

const SQL: Grammar = {
  rules: [[sticky('--[^\\n]*'), 'comment'], slashComments[1] as Rule, string(quoted("'")), string(quoted('"')), ...TAIL],
  words: words(
    ['keyword', `
      select from where insert into values update set delete join left right inner outer full cross on group by
      order having limit offset as and or not null is in like between distinct union all case when then else end
      with returning exists asc desc`],
    ['declaration', 'create table drop alter add index view primary key foreign references default unique constraint'],
    ['type', 'int integer bigint smallint text varchar char boolean date timestamp timestamptz numeric decimal real serial uuid json jsonb'],
  ),
  caseless: true,
}

const JSON_LIKE: Grammar = {
  rules: [
    // A string followed by a colon is a key.
    [sticky('"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)'), 'tag'],
    string(quoted('"')),
    ...slashComments,
    ...TAIL,
  ],
  words: words(['keyword', 'true false null']),
}

const YAML: Grammar = {
  rules: [
    [sticky('(?<=^|\\s)#[^\\n]*'), 'comment'],
    [sticky('(?<=(?:^|\\n)[ \\t]*(?:- +)?)[\\w.-]+(?=[ \\t]*:(?:\\s|$))'), 'tag'],
    string(quoted('"')),
    [sticky("'(?:[^'\\n]|'')*'?"), 'string'],
    ...TAIL,
  ],
  words: words(['keyword', 'true false null yes no on off ~']),
}

const TOML: Grammar = {
  rules: [
    hashComment,
    [sticky('(?<=(?:^|\\n)[ \\t]*)(?:\\[\\[?[^\\]\\n]*\\]\\]?|[\\w.-]+(?=[ \\t]*=))'), 'tag'],
    string(tripleQuoted('"')),
    string(tripleQuoted("'")),
    string(quoted('"')),
    [sticky("'[^'\\n]*'?"), 'string'],
    ...TAIL,
  ],
  words: words(['keyword', 'true false']),
}

const CSS: Grammar = {
  rules: [
    slashComments[1] as Rule,
    string(quoted('"')),
    string(quoted("'")),
    [sticky('(?<=(?:^|[{;\\n])[ \\t]*)[\\w-]+(?=[ \\t]*:)'), 'attribute'],
    [sticky('[.#][\\w-]+'), 'class'],
    [sticky('@[\\w-]+'), 'decorator'],
    [sticky('#[\\da-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:%|[a-z]+)?'), 'number'],
    [sticky('[{}();:,>+~]'), 'punctuation'],
  ],
  words: words(['keyword', 'important inherit initial unset none auto']),
}

const MARKUP: Grammar = {
  rules: [
    [sticky('<!--[\\s\\S]*?(?:-->|$)'), 'comment'],
    [sticky('</?[\\w:-]+'), match => [{ text: match.startsWith('</') ? '</' : '<', syntax: 'punctuation' }, { text: match.replace(/^<\/?/, ''), syntax: 'tag' }]],
    [sticky('[\\w:-]+(?==)'), 'attribute'],
    [sticky('"[^"]*"?|\'[^\']*\'?'), 'string'],
    [sticky('/?>'), 'punctuation'],
    [sticky('[^<>"\'=\\s]+|[<>=]'), 'plain'],
  ],
}

const DIFF: Grammar = {
  rules: [
    [sticky('(?<=^|\\n)(?:diff|index) [^\\n]*'), 'header'],
    [sticky('(?<=^|\\n)\\+[^\\n]*'), 'added'],
    [sticky('(?<=^|\\n)-[^\\n]*'), 'removed'],
    [sticky('(?<=^|\\n)@[^\\n]*'), 'hunk'],
    [sticky('[^\\n]+'), 'plain'],
  ],
}

/** The fence languages readable colours, by every name a reply might give; others are drawn plain. */
const GRAMMARS = new Map<string, Grammar>()

function known(grammar: Grammar, names: string): void {
  for (const name of names.split(' ')) GRAMMARS.set(name, grammar)
}

known(JAVASCRIPT, 'js javascript jsx mjs cjs ts typescript tsx mts cts')
known(PYTHON, 'py python python3')
known(GO, 'go golang')
known(RUST, 'rs rust')
known(SHELL, 'sh bash zsh shell console fish')
known(C_LIKE, 'c h cpp c++ cc hpp java kotlin kt swift cs csharp scala dart')
known(SQL, 'sql postgres postgresql mysql sqlite')
known(JSON_LIKE, 'json jsonc json5')
known(YAML, 'yaml yml')
known(TOML, 'toml ini')
known(CSS, 'css scss less')
known(MARKUP, 'html xml svg vue svelte')
known(DIFF, 'diff patch')

/** Splits a code block into stretches tagged by what they are, for the theme to colour. */
export function highlight(source: string, lang: string): Token[] {
  const grammar = GRAMMARS.get(lang.toLowerCase())
  return grammar === undefined ? [{ text: source, syntax: 'plain' }] : tokenize(source, grammar)
}
