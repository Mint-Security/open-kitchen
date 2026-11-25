#!/bin/sh
# Publishes the archives in ./dist as the release commonmind--$VERSION. The release workflow
# runs this from the repository root with GITHUB_REF, GITHUB_SHA, VERSION and GH_TOKEN set.
set -eu

: "${GITHUB_REF:?}" "${GITHUB_SHA:?}" "${VERSION:?}"
tag="commonmind--$VERSION"
git fetch origin main --tags
if [ "$GITHUB_REF" = refs/heads/main ] && ! git diff --quiet "$GITHUB_SHA" origin/main -- commonmind .github/workflows/commonmind.yml .github/workflows/commonmind-release.yml; then
  echo "A newer Commonmind change on main is waiting for CI; skipping this release."
  exit 0
fi
if git rev-parse --verify "refs/tags/$tag" >/dev/null 2>&1; then
  test "$(git rev-parse "$tag^{commit}")" = "$GITHUB_SHA"
fi
# Other tools share this repository, so the notes GitHub generates would list their pull requests
# too. The notes are this version's section of the changelog or, without one, the commits that
# changed Commonmind since its last release.
notes=$(awk -v heading="## commonmind ${VERSION#v}" '$0 == heading {found = 1; next} found && /^## / {exit} found && (started || NF) {started = 1; print}' CHANGELOG.md 2>/dev/null || true)
if [ -z "$notes" ]; then
  previous=$(git tag --list "commonmind--v*" --sort=-version:refname --merged "$GITHUB_SHA" | grep -vxF "$tag" | head -n 1)
  notes=$(git log --no-merges --format='- %s' ${previous:+"$previous.."}"$GITHUB_SHA" -- commonmind .github/workflows/commonmind.yml .github/workflows/commonmind-release.yml)
fi
cd dist
sha256sum commonmind-*.tar.gz > checksums.txt
cp ../commonmind/scripts/install.sh .
if release=$(gh release view "$tag" --json isDraft,targetCommitish 2>/dev/null); then
  if [ "$(printf '%s' "$release" | jq -r .isDraft)" = false ]; then
    echo "$tag is already published."
    exit 0
  fi
  if [ "$(printf '%s' "$release" | jq -r .targetCommitish)" != "$GITHUB_SHA" ]; then
    # A draft has no tag, so this commit planned the same version as the earlier one whose
    # upload failed. That run is superseded and will not finish it; this one takes it over.
    echo "Replacing the draft $tag an earlier commit left."
    gh release delete "$tag" --yes
    gh release create "$tag" --target "$GITHUB_SHA" --title "Commonmind $VERSION" --draft --notes "$notes"
  fi
else
  gh release create "$tag" --target "$GITHUB_SHA" --title "Commonmind $VERSION" --draft --notes "$notes"
fi
gh release upload "$tag" ./* --clobber
# The installer downloads from the repository's latest release, so this one must be it.
gh release edit "$tag" --draft=false --latest
