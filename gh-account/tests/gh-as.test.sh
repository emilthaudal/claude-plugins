#!/bin/sh
# Runs bin/gh-as against a fake gh on PATH: sh gh-account/tests/gh-as.test.sh
# The fake gh holds a token for "ada" only and answers an empty account like the real one: with the active account's.
set -u
here=$(cd "$(dirname "$0")" && pwd)
gh_as=$here/../bin/gh-as
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/gh" <<'EOF'
#!/bin/sh
# gh auth token --user ACCOUNT
case $4 in
  ada) echo tok-ada ;;
  '') echo tok-active ;;
  *) echo "no oauth token found for $4" >&2; exit 1 ;;
esac
EOF
chmod +x "$tmp/gh"
PATH=$tmp:$PATH
export PATH

fail=0
check() { # name, expected exit, expected stdout, then the command
  name=$1 want=$2 out=$3
  shift 3
  got=$("$@" 2>/dev/null)
  code=$?
  if [ "$code" != "$want" ] || [ "$got" != "$out" ]; then
    echo "FAIL $name: exit $code (want $want), stdout '$got' (want '$out')"
    fail=1
  else
    echo "ok   $name"
  fi
}

check 'named account gets its token' 0 tok-ada "$gh_as" ada sh -c 'printf %s "$GH_TOKEN"'
check 'inherited token is replaced' 0 tok-ada env GH_TOKEN=other "$gh_as" ada sh -c 'printf %s "$GH_TOKEN"'
check 'empty account is refused' 2 '' "$gh_as" '' sh -c 'printf %s "$GH_TOKEN"'
check 'unknown account runs nothing' 1 '' "$gh_as" bob printf ran
check 'bad characters are refused' 2 '' "$gh_as" 'a;b' printf ran
check 'a dash account is refused' 2 '' "$gh_as" -x printf ran
check 'a dash command is refused' 2 '' "$gh_as" ada -c true
check 'no command is refused' 2 '' "$gh_as" ada
check 'arguments pass through' 0 '[a b][$HOME]' "$gh_as" ada printf '[%s]' 'a b' '$HOME'
check 'exit code passes through' 42 '' "$gh_as" ada sh -c 'exit 42'
check 'xtrace in the environment stays off' 0 '' env SHELLOPTS=xtrace "$gh_as" ada true

# Nothing in the trace of a plain run may carry the token.
if env SHELLOPTS=xtrace "$gh_as" ada true 2>&1 | grep -q tok-ada; then
  echo 'FAIL token printed under SHELLOPTS=xtrace'
  fail=1
fi
exit $fail
