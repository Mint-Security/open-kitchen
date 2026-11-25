#!/usr/bin/env bash
# Variables in shell snippets expand in the child shell.
# shellcheck disable=SC2016
set -euo pipefail
assets=$(cd "${1:?usage: smoke-install.sh ASSET_DIR NEW_TEST_DIR EXPECTED_VERSION}" && pwd)
lab=${2:?new test directory required}
expected_version=${3:?expected version required}
zsh_binary=$(command -v zsh)
base_path=/usr/bin:/bin:/usr/sbin:/sbin
if [ "$(id -u)" = 0 ]; then
  echo 'Run as a regular user so the unwritable-file check is meaningful.' >&2
  exit 1
fi
mkdir "$lab"
lab=$(cd "$lab" && pwd)
trap 'echo "Installer smoke-test logs: $lab"' EXIT
mkdir -p "$lab/home" "$lab/empty-roots" "$lab/fake-bin"
cm_home="$lab/home/commonmind with spaces ' and \$dollars"
rc="$lab/home/.zshrc"
printf 'export EXISTING_SETTING=preserved' > "$rc"
install() {
  cat "$assets/install.sh" | env -i HOME="$lab/home" PATH="$base_path" SHELL="$zsh_binary" COMMONMIND_HOME="$cm_home" COMMONMIND_RELEASE_URL="file://$assets" sh
}
install > "$lab/install.log"
grep -Fq 'Added Commonmind to PATH' "$lab/install.log"
grep -Fq 'To undo: remove this line' "$lab/install.log"
grep -Fq 'export EXISTING_SETTING=preserved' "$rc"
env -i HOME="$lab/home" PATH="$base_path" "$zsh_binary" -d -e -i -c 'test "$EXISTING_SETTING" = preserved; command -v commonmind; commonmind version' > "$lab/fresh-shell.log"
grep -Fxq "$cm_home/bin/commonmind" "$lab/fresh-shell.log"
grep -Fxq "$expected_version" "$lab/fresh-shell.log"
echo 'PASS: packaged installer updates zshrc; new zsh finds the expected Commonmind version'
licences="$cm_home/bin/THIRD-PARTY-LICENSES.txt"
built_with=$(go version -m "$cm_home/bin/commonmind")
while read -r module version; do
  grep -Fxq "$module $version" "$licences" || { echo "No licence installed for $module $version" >&2; exit 1; }
done < <(awk 'NR == 1 {print "Go", $NF} $1 == "dep" {print $2, $3}' <<< "$built_with")
grep -Fxq -- '--- zstd/internal/xxhash/LICENSE.txt ---' "$licences"
grep -Fq 'UNICODE LICENSE V3' "$licences"
echo 'PASS: the licence of Go, of every module in the binary, and of the Unicode data is installed'
cp "$rc" "$lab/rc-before-reinstall"
install > "$lab/reinstall.log"
cmp "$rc" "$lab/rc-before-reinstall"
grep -Fq 'PATH is already configured' "$lab/reinstall.log"
echo 'PASS: reinstall preserves existing settings and adds no duplicate'

zsh_dir="$lab/zsh config ' and \$dollars"
mkdir "$zsh_dir"
printf 'export EXISTING_SETTING=custom\n' > "$lab/dotfiles-zshrc"
ln -s "$lab/dotfiles-zshrc" "$zsh_dir/.zshrc"
cat "$assets/install.sh" | env -i HOME="$lab/home" PATH="$base_path" SHELL="$zsh_binary" ZDOTDIR="$zsh_dir" COMMONMIND_HOME="$cm_home" COMMONMIND_RELEASE_URL="file://$assets" sh > "$lab/custom.log"
test -L "$zsh_dir/.zshrc"
env -i HOME="$lab/home" ZDOTDIR="$zsh_dir" PATH="$base_path" "$zsh_binary" -d -e -i -c 'test "$EXISTING_SETTING" = custom; commonmind version' | grep -Fxq "$expected_version"
echo 'PASS: custom ZDOTDIR, symlinked zshrc, spaces, quotes and dollar signs'

mkdir "$lab/readonly"
printf '# preserve me\n' > "$lab/readonly/.zshrc"
chmod 444 "$lab/readonly/.zshrc"
cat "$assets/install.sh" | env -i HOME="$lab/home" PATH="$base_path" SHELL="$zsh_binary" ZDOTDIR="$lab/readonly" COMMONMIND_HOME="$cm_home" COMMONMIND_RELEASE_URL="file://$assets" sh > "$lab/readonly.log"
grep -Fq 'Warning: could not update' "$lab/readonly.log"
grep -Fxq '# preserve me' "$lab/readonly/.zshrc"
cat "$assets/install.sh" | env -i HOME="$lab/home" PATH="$base_path" SHELL=/bin/bash COMMONMIND_HOME="$cm_home" COMMONMIND_RELEASE_URL="file://$assets" sh > "$lab/bash.log"
cmp "$rc" "$lab/rc-before-reinstall"
grep -Fq 'automatic setup supports zsh' "$lab/bash.log"
echo 'PASS: unwritable rc and bash fallback keep installation usable'

printf '#!/bin/sh\necho "exec: codex: not found" >&2\nexit 127\n' > "$lab/fake-bin/codex"
chmod 755 "$lab/fake-bin/codex"
env -i HOME="$lab/home" COMMONMIND_HOME="$cm_home" PATH="$lab/fake-bin:$base_path" "$cm_home/bin/commonmind" init --team installer-smoke --author fixture --roots "$lab/empty-roots" --clients codex --no-service --syncthing "$cm_home/bin/syncthing" > "$lab/init.log" 2>&1
grep -Fq 'Created team "installer-smoke"' "$lab/init.log"
grep -Fq 'Warning: agent integration incomplete' "$lab/init.log"
grep -Fq 'Team setup is saved' "$lab/init.log"
env -i HOME="$lab/home" COMMONMIND_HOME="$cm_home" PATH="$base_path" "$cm_home/bin/commonmind" status > "$lab/status.log"
echo 'PASS: real team init succeeds with deliberately broken Codex launcher'

case "$(uname -s)" in
  Darwin)
    script -q "$lab/terminal.log" env -i HOME="$lab/home" COMMONMIND_HOME="$cm_home" PATH="$lab/fake-bin:$base_path" TERM=xterm-256color "$cm_home/bin/commonmind" init --team installer-smoke --clients codex --no-service >/dev/null
    ;;
  Linux)
    env -i HOME="$lab/home" COMMONMIND_HOME="$cm_home" PATH="$lab/fake-bin:$base_path" TERM=xterm-256color CM_BIN="$cm_home/bin/commonmind" script -q -e -c '"$CM_BIN" init --team installer-smoke --clients codex --no-service' "$lab/terminal.log" >/dev/null
    ;;
  *) echo 'Unsupported smoke-test platform' >&2; exit 1 ;;
esac
grep -Fq $'\033[1;31mWarning:' "$lab/terminal.log"
if grep -Fq $'\033' "$lab/init.log"; then echo 'unexpected ANSI in redirected log'; exit 1; fi
echo 'PASS: bold red warning on terminal; redirected output stays plain'

sed '/ # commonmind PATH$/d' "$rc" > "$lab/undone-zshrc"
cat "$lab/undone-zshrc" > "$rc"
env -i HOME="$lab/home" PATH="$base_path" "$zsh_binary" -d -e -i -c 'test "$EXISTING_SETTING" = preserved; if command -v commonmind >/dev/null; then exit 1; fi'
echo 'PASS: removing the documented PATH line undoes setup and preserves other settings'
echo 'ALL INSTALLER SMOKE CHECKS PASSED'
