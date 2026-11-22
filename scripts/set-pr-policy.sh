#!/usr/bin/env bash
# set-pr-policy.sh - every change to a default branch must arrive as a pull
# request, and nothing merges without a human pressing merge.
#
# usage:
#   scripts/set-pr-policy.sh                        # current repo, 0 approvals
#   APPROVALS=1 scripts/set-pr-policy.sh owner/repo # require a review approval
#
# Idempotent: creates the ruleset the first time, updates it afterwards.
# Rules: no deletion, no force-push, no direct commits, stale approvals
# dismissed on push, review threads must be resolved. bypass_actors is empty on
# purpose - admins are bound too.
set -euo pipefail

APPROVALS="${APPROVALS:-0}"

apply() {
  local repo="$1"
  local name="protect-default-branch"
  local id payload

  id=$(gh api "/repos/$repo/rulesets" --jq ".[] | select(.name==\"$name\") | .id" 2>/dev/null || true)

  payload=$(mktemp)
  cat >"$payload" <<JSON
{
  "name": "$name",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": $APPROVALS,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash", "merge", "rebase"]
    } }
  ],
  "bypass_actors": []
}
JSON

  if [ -n "$id" ]; then
    gh api -X PUT "/repos/$repo/rulesets/$id" --input "$payload" --jq "\"updated ruleset '\(.name)' on $repo (approvals $APPROVALS)\""
  else
    gh api -X POST "/repos/$repo/rulesets" --input "$payload" --jq "\"created ruleset '\(.name)' on $repo (approvals $APPROVALS)\""
  fi
  rm -f "$payload"
}

if [ "$#" -eq 0 ]; then
  apply "$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
else
  for r in "$@"; do apply "$r"; done
fi
