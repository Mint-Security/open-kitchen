#!/bin/sh
set -eu

event=${1:?event required}
ref=${2:?ref required}
sha=${3:?commit required}
# Commonmind shares its repository with other tools, so its releases are tagged
# commonmind--vX.Y.Z and only a change to these paths makes a new one.
prefix=commonmind--
# [.] and not \. : awk -v reads a backslash escape before the pattern sees it.
stable='^v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$'
version=
publish=false

stable_tags() {
  sed -n "s/^$prefix//p" | awk -v pattern="$stable" '$0 ~ pattern {print; exit}'
}

case "$event:$ref" in
  push:refs/heads/main)
    remote=$(git ls-remote origin refs/heads/main)
    main_sha=$(printf '%s\n' "$remote" | cut -f1)
    if [ -z "$main_sha" ]; then echo 'Could not resolve main.' >&2; exit 1; fi
    current=true
    if [ "$main_sha" != "$sha" ]; then
      git fetch --quiet origin refs/heads/main
      # A newer commit that left Commonmind alone starts no run of its own, so this one still releases.
      git diff --quiet "$sha" "$main_sha" -- ':(top)commonmind' ':(top).github/workflows/commonmind.yml' ':(top).github/workflows/commonmind-release.yml' || current=false
    fi
    if [ "$current" = true ]; then
      version=$(git tag --points-at "$sha" --sort=-version:refname | stable_tags)
      if [ -z "$version" ]; then
        latest=$(git tag --list "$prefix*" --sort=-version:refname | stable_tags)
        if [ -z "$latest" ]; then
          version=v1.0.0
        else
          patch=${latest##*.}
          version="${latest%.*}.$((patch + 1))"
        fi
      fi
      publish=true
    else
      echo 'A newer Commonmind change on main is waiting for CI; skipping this release.' >&2
    fi
    ;;
  push:refs/tags/"$prefix"v*)
    # A pushed tag skips the pull request and the tests a merge to main goes through, and its
    # release becomes the one every install and invite downloads.
    version=${ref#refs/tags/"$prefix"}
    git fetch --quiet origin refs/heads/main
    if ! git merge-base --is-ancestor "$sha" FETCH_HEAD; then
      echo "$ref is not on main; a release is cut from a commit that was merged there." >&2
      exit 1
    fi
    if [ "$(git tag --list "$prefix*" --sort=-version:refname | stable_tags)" != "$version" ]; then
      echo "$version is not the newest stable Commonmind version; it cannot become the latest release." >&2
      exit 1
    fi
    publish=true
    ;;
  workflow_dispatch:*) version="dev-$sha" ;;
esac

printf 'version=%s\npublish=%s\n' "$version" "$publish"
