#!/usr/bin/env bash
# Two Claude Code sessions on this machine, a host and a guest, to see pair the way two people do.
#
#   scripts/pair-sandbox.sh host    the host (Sam), in a throwaway project with a few files to work on
#   scripts/pair-sandbox.sh guest   the guest (Dana), in an empty folder
#   scripts/pair-sandbox.sh         both, side by side in tmux
#
# Both load plugins/pair from this checkout: it shadows any installed or claude.ai-synced pair, and an
# interactive session reloads it on every edit. Dividend's band is turned off so pair's shows.
# The host's turns are real model turns (Haiku unless PAIR_SANDBOX_MODEL says otherwise).
# The sandbox lives under $XDG_CACHE_HOME/pair-sandbox (PAIR_SANDBOX overrides it) and is kept between runs.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
box="${PAIR_SANDBOX:-${XDG_CACHE_HOME:-$HOME/.cache}/pair-sandbox}"
model="${PAIR_SANDBOX_MODEL:-haiku}"

if [ -e "$box" ] && { [ -L "$box" ] || [ ! -O "$box" ]; }; then
  echo "$box is a link or not yours; set PAIR_SANDBOX to a folder of your own." >&2
  exit 1
fi

settings() {
  printf '{"pluginConfigs":{"pair@inline":{"options":{"displayName":"%s"}}},"enabledPlugins":{"dividend@mint-security":false}}' "$1"
}

project() {
  local dir="$box/project"
  [ -f "$dir/greet.js" ] && return 0
  mkdir -p "$dir"
  cat >"$dir/greet.js" <<'EOF'
export function greet(name) {
  return `hello ${name}`
}

export const shout = text => text.toUpperCase()
EOF
  cat >"$dir/greet.test.js" <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { greet, shout } from './greet.js'

test('greets by name', () => assert.equal(greet('Dana'), 'hello Dana'))
test('shouts', () => assert.equal(shout('hi'), 'HI'))
EOF
  printf '{ "name": "greeter", "type": "module", "scripts": { "test": "node --test" } }\n' >"$dir/package.json"
  printf '# greeter\n\nA tiny module for trying pair: ask Claude to change it while your guest watches.\n' >"$dir/README.md"
  git -C "$dir" init -q && git -C "$dir" add -A && git -C "$dir" -c user.name=sandbox -c user.email=sandbox@localhost commit -qm 'greeter'
}

run() {
  local name="$1" dir="$2"
  shift 2
  cd "$dir"
  exec env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude -n "$name" --plugin-dir "$repo/plugins/pair" --settings "$(settings "$name")" "$@"
}

case "${1:-}" in
  host)
    project
    echo "Host (Sam). Ask Claude something about greet.js, then /pair: the invite goes to your clipboard (/pair invite copies it again)."
    run Sam "$box/project" --model "$model" --permission-mode acceptEdits
    ;;
  guest)
    mkdir -p "$box/guest"
    echo "Guest (Dana). Paste the host's invite: /pair XXXX-XXXX-... (84 characters in groups of four)"
    run Dana "$box/guest"
    ;;
  '')
    command -v tmux >/dev/null || { echo "No tmux: run '$0 host' and '$0 guest' in two terminals." >&2; exit 1; }
    self="$(printf '%q' "$0")"
    if [ -n "${TMUX:-}" ]; then
      tmux new-window -n pair-sandbox "$self host" \; split-window -h "$self guest"
    else
      name="pair-sandbox-$$"
      tmux new-session -d -s "$name" -x 240 -y 60 "$self host" \; split-window -h "$self guest" \; attach -t "$name"
    fi
    ;;
  *)
    echo "usage: $0 [host|guest]" >&2
    exit 2
    ;;
esac
