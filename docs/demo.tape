Output docs/demo.gif
Set Shell zsh
Set FontSize 15
Set Width 1280
Set Height 1000
Set Padding 18
Set TypingSpeed 30ms
Set WindowBar Colorful
Set WaitTimeout 90s

Hide
Type `for v in ${(k)parameters[(I)CLAUDE*]} AI_AGENT; do [[ $v == CLAUDE_CODE_PLUGIN_DIRS ]] || unset $v; done; cd ~/Developer/claude-plugins` Enter
Type `claude --model haiku --allowedTools "Bash(sleep:*)" --settings '{"statusLine":{"type":"command","command":"true"}}' 2>/dev/null` Enter
Wait+Screen /Try "/
Ctrl+L
Sleep 1s
Show

Sleep 1s
Type "Without using tools, in a short answer: how do I retry a failing fetch in TypeScript? Use a heading, a code block, a small table comparing backoff strategies, and one tip as a blockquote."
Sleep 500ms
Enter
Sleep 3s
Wait+Screen /done in/
Sleep 4s
Type "Run `sleep 8 && echo deployed` and tell me when it is done"
Sleep 500ms
Enter
Sleep 3s
Wait+Screen /done in/
Sleep 5s
Hide
Ctrl+C
Sleep 300ms
Ctrl+C
Sleep 1s
