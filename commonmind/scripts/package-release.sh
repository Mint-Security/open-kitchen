#!/bin/sh
set -eu

platform=${1:?usage: package-release.sh darwin|linux amd64|arm64 VERSION}
arch=${2:?architecture required}
version=${3:?version required}
case "$version" in *[!A-Za-z0-9._-]*) echo "Invalid version" >&2; exit 1 ;; esac
syncthing_version=v2.1.5
case "$platform-$arch" in
  darwin-amd64) st_platform=macos; ext=zip; checksum=f4535e479472a1ae43d3e6ffc4bcfc7651179e948387c08f3696847d142b62c7 ;;
  darwin-arm64) st_platform=macos; ext=zip; checksum=4a3153cce6f3bdc6290824e409b1622c3b78ad8b8a8b2fc846c0061b61e44d4a ;;
  linux-amd64) st_platform=linux; ext=tar.gz; checksum=3d222b609f7ab2944e02748cb10488b4160d446b49e0eafc107ef2a525ab3486 ;;
  linux-arm64) st_platform=linux; ext=tar.gz; checksum=3666f3069feeee3651e185f867759206059755101797bdd69ea5317610130855 ;;
  *) echo "Unsupported release target" >&2; exit 1 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
name="syncthing-$st_platform-$arch-$syncthing_version"
curl -fsSL "https://github.com/syncthing/syncthing/releases/download/$syncthing_version/$name.$ext" -o "$tmp/upstream"
actual=$(shasum -a 256 "$tmp/upstream" | awk '{print $1}')
if [ "$actual" != "$checksum" ]; then echo "Syncthing checksum mismatch" >&2; exit 1; fi
if [ "$ext" = zip ]; then unzip -q "$tmp/upstream" -d "$tmp"; else tar -xzf "$tmp/upstream" -C "$tmp"; fi
mkdir "$tmp/package"
GOOS=$platform GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$tmp/package/commonmind" ./cmd/commonmind
cp "$tmp/$name/syncthing" "$tmp/package/syncthing"
cp "$tmp/$name/LICENSE.txt" "$tmp/package/syncthing-LICENSE.txt"
cp LICENSE "$tmp/package/LICENSE"
printf 'Syncthing %s, distributed unmodified. Source: https://github.com/syncthing/syncthing/tree/%s\n' "$syncthing_version" "$syncthing_version" > "$tmp/package/syncthing-SOURCE.txt"

rule='================================================================'
licence_files() {
  for file in "$1"/LICENSE* "$1"/LICENCE* "$1"/COPYING* "$1"/*-LICENSE "$1"/COPYRIGHT* "$1"/NOTICE* "$1"/PATENTS; do
    if [ -f "$file" ]; then printf '%s\n' "$file"; fi
  done
}
# licences HEADER ROOT prints the licence files in ROOT, in each package
# directory read from stdin, and in the directories between the two.
licences() {
  {
    licence_files "$2"
    while read -r dir; do
      while [ "${dir#"$2"/}" != "$dir" ]; do licence_files "$dir"; dir=${dir%/*}; done
    done | sort -u
  } > "$tmp/files"
  printf '%s\n%s\n%s\n' "$rule" "$1" "$rule"
  found=
  while read -r file; do
    printf '\n--- %s ---\n\n' "${file#"$2"/}"
    cat "$file"
    case ${file##*/} in COPYRIGHT* | NOTICE* | PATENTS) ;; *) found=1 ;; esac
  done < "$tmp/files"
  if [ -z "$found" ]; then echo "No licence found for $1" >&2; return 1; fi
  printf '\n'
}
go version -m "$tmp/package/commonmind" | awk 'NR == 1 {print "Go", $NF} $1 == "dep" {print $2, $3}' > "$tmp/built-with"
GOOS=$platform GOARCH=$arch CGO_ENABLED=0 go list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}} {{$.Dir}}{{end}}{{end}}' ./cmd/commonmind > "$tmp/packages"
{
  printf 'commonmind is built from the Go standard library, the Go modules below and Unicode data. Their licences follow.\n\n'
  while read -r module version; do
    if [ "$module" = Go ]; then
      licences "Go $version" "$(go env GOROOT)" < /dev/null
      continue
    fi
    while read -r path dir; do
      if [ "$path" = "$module" ]; then printf '%s\n' "$dir"; fi
    done < "$tmp/packages" | licences "$module $version" "$(go list -m -f '{{.Dir}}' "$module")"
  done < "$tmp/built-with"
  printf '%s\nUnicode confusables.txt, built into internal/names\n%s\n\n' "$rule" "$rule"
  cat internal/names/UNICODE-LICENSE.txt
} > "$tmp/package/THIRD-PARTY-LICENSES.txt"

mkdir -p dist
COPYFILE_DISABLE=1 tar --no-xattrs -czf "dist/commonmind-$platform-$arch.tar.gz" -C "$tmp/package" commonmind syncthing LICENSE syncthing-LICENSE.txt syncthing-SOURCE.txt THIRD-PARTY-LICENSES.txt
