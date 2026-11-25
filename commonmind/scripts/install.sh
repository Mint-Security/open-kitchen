#!/bin/sh
set -eu

repo=${COMMONMIND_REPO:-Mint-Security/open-kitchen}
release_url=${COMMONMIND_RELEASE_URL:-https://github.com/$repo/releases/latest/download}
install_home=${COMMONMIND_HOME:-$HOME/.commonmind}
case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *) echo "Commonmind managed sync supports macOS and Linux." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) echo "Unsupported CPU architecture." >&2; exit 1 ;;
esac

fetch() {
  if curl -fsSL "$release_url/$1" -o "$2"; then return; fi
  echo "Could not download $1 from $release_url." >&2
  return 1
}

archive="commonmind-$platform-$arch.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
fetch "$archive" "$tmp/$archive"
fetch checksums.txt "$tmp/checksums.txt"
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
fi
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "Release checksum verification failed." >&2
  exit 1
fi
tar -xzf "$tmp/$archive" -C "$tmp"
umask 077
mkdir -p "$install_home/bin"
chmod 700 "$install_home"
for binary in commonmind syncthing; do
  cp "$tmp/$binary" "$install_home/bin/$binary.new"
  chmod 755 "$install_home/bin/$binary.new"
  mv -f "$install_home/bin/$binary.new" "$install_home/bin/$binary"
done
for notice in LICENSE syncthing-LICENSE.txt syncthing-SOURCE.txt THIRD-PARTY-LICENSES.txt; do
  cp "$tmp/$notice" "$install_home/bin/$notice"
done
export COMMONMIND_HOME="$install_home"
printf 'Installed Commonmind in %s/bin\n' "$install_home"
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
path_command="export PATH=$(shell_quote "$install_home/bin"):\$PATH"
printf '\n============================================================\n'
printf 'COMMONMIND TERMINAL SETUP\n\n'
installer_shell=${SHELL:-}
case "${installer_shell##*/}" in
  zsh)
    shell_rc="${ZDOTDIR:-$HOME}/.zshrc"
    managed_path_command="$path_command # commonmind PATH"
    saved_path_command=
    if [ -f "$shell_rc" ] && grep -Fqx "$managed_path_command" "$shell_rc"; then
      saved_path_command=$managed_path_command
      printf 'PATH is already configured in %s\n' "$shell_rc"
    elif [ -f "$shell_rc" ] && grep -Fqx "$path_command" "$shell_rc"; then
      saved_path_command=$path_command
      printf 'PATH is already configured in %s\n' "$shell_rc"
    elif { [ -f "$shell_rc" ] && [ -r "$shell_rc" ]; } || { [ ! -e "$shell_rc" ] && [ ! -L "$shell_rc" ]; }; then
      if (printf '\n%s\n' "$managed_path_command" >> "$shell_rc") 2>/dev/null; then
        saved_path_command=$managed_path_command
        printf 'Added Commonmind to PATH in %s\n' "$shell_rc"
      fi
    fi
    if [ -n "$saved_path_command" ]; then
      printf '\nTo undo: remove this line from %s, then open a new terminal:\n    %s\n' "$shell_rc" "$saved_path_command"
    else
      printf 'Warning: could not update %s. Installation succeeded.\n' "$shell_rc"
      printf 'To enable future zsh terminals, add this line there manually:\n    %s\n' "$path_command"
    fi
    ;;
  *)
    printf 'Shell configuration was not changed (automatic setup supports zsh).\n'
    printf 'To enable future terminals, add this line to your shell startup file:\n    %s\n' "$path_command"
    ;;
esac
printf '\nOpen a new terminal, or run this in your current terminal:\n  %s\n' "$path_command"
printf '============================================================\n\n'
if [ "${1:-}" = "--join" ]; then
  if [ "$#" -lt 2 ]; then echo "--join requires an invite" >&2; exit 1; fi
  invite=$2
  shift 2
  "$install_home/bin/commonmind" join "$@" "$invite"
elif [ "$#" -gt 0 ]; then
  "$install_home/bin/commonmind" "$@"
else
  if [ -f "$install_home/settings.json" ]; then
    printf 'Existing configuration preserved. Check it with: "%s/bin/commonmind" status\n' "$install_home"
  else
    printf 'Create a team: "%s/bin/commonmind" init --team YOUR-TEAM\n' "$install_home"
  fi
fi
