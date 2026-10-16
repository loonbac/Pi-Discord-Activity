#!/usr/bin/env bash
# Sync the fork with the upstream plugin without losing the multi-session work.
#
# The upstream keeps improving: new activities, transport fixes, helper changes. This
# fork carries the multi-session aggregate, so every sync is a rebase of one line
# onto the other, never a merge that hides where a change came from.
#
# Usage:
#   scripts/sync-upstream.sh          # fetch + report + rebase current branch
#   scripts/sync-upstream.sh --dry    # fetch + report only, change nothing
#
set -euo pipefail

REMOTE_UPSTREAM="upstream"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DRY=0
[[ "${1:-}" == "--dry" ]] && DRY=1

fail() { echo "sync-upstream: $*" >&2; exit 1; }

git remote get-url "$REMOTE_UPSTREAM" >/dev/null 2>&1 || \
  fail "no '$REMOTE_UPSTREAM' remote. Add it first:
  git remote add upstream https://github.com/gripebomb/pi-discord-activity.git"

[[ -z "$(git status --porcelain)" ]] || fail "uncommitted changes; commit or stash before syncing"

echo " fetching $REMOTE_UPSTREAM"
git fetch --quiet "$REMOTE_UPSTREAM"

BASE="$REMOTE_UPSTREAM/$(git symbolic-ref --quiet --short "refs/remotes/$REMOTE_UPSTREAM/HEAD" 2>/dev/null | sed 's|^'"$REMOTE_UPSTREAM"'/||' || echo main)"
AHEAD=$(git rev-list --count "$BASE..HEAD")
BEHIND=$(git rev-list --count "HEAD..$BASE")

echo " base: $BASE"
echo " this branch: $AHEAD commit(s) ahead, $BEHIND behind"

if [[ "$BEHIND" -eq 0 ]]; then
  echo " nothing to sync: already up to date with $BASE"
  exit 0
fi

echo
echo " upstream commits not in this branch:"
git log --oneline --no-decorate "HEAD..$BASE" | head -20
[[ "$(git rev-list --count "HEAD..$BASE")" -le 20 ]] || echo "   and more"

if [[ "$DRY" -eq 1 ]]; then
  echo
  echo "(dry run: nothing was changed)"
  exit 0
fi

echo
echo " rebasing $BRANCH onto $BASE"
if git rebase "$BASE"; then
  echo " rebased cleanly"
  echo
  echo " verify the suite before anything else:"
  echo "    npm ci && npm test"
  echo " then push: git push --force-with-lease origin $BRANCH"
else
  echo
  fail "rebase conflict. Resolve it, then:
  git rebase --continue
  git rebase --abort      # to back out and keep the working tree as it was"
fi
