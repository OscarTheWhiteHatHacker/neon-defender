#!/usr/bin/env bash
# set-pr-policy.sh - enforce "branch + pull request only" on a repo's default
# branch, and optionally require the auto-reviewer's status check.
#
# usage:
#   scripts/set-pr-policy.sh                       # current repo
#   scripts/set-pr-policy.sh owner/repo [owner/repo ...]
#   REQUIRED_CHECK="pr-guard / guard" scripts/set-pr-policy.sh owner/repo
#
# Idempotent: creates the ruleset the first time, updates it afterwards.
# Rules applied: no deletion, no force-push, no direct commits (every change
# must arrive as a pull request), stale approvals dismissed on push, review
# threads must be resolved. bypass_actors is empty on purpose - admins are
# bound too; edit the ruleset in the UI if you ever need an escape hatch.
set -euo pipefail

REQUIRED_CHECK="${REQUIRED_CHECK:-}"

apply() {
  local repo="$1"
  local name="protect-default-branch"
  local id payload

  id=$(gh api "/repos/$repo/rulesets" --jq ".[] | select(.name==\"$name\") | .id" 2>/dev/null || true)

  payload=$(mktemp)
  {
    cat <<JSON
{
  "name": "$name",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash", "merge", "rebase"]
    } }$( [ -n "$REQUIRED_CHECK" ] && printf ',\n    { "type": "required_status_checks", "parameters": { "strict_required_status_checks_policy": false, "required_status_checks": [ { "context": "%s" } ] } }' "$REQUIRED_CHECK" )
  ],
  "bypass_actors": []
}
JSON
  } >"$payload"

  if [ -n "$id" ]; then
    gh api -X PUT "/repos/$repo/rulesets/$id" --input "$payload" --jq "\"updated ruleset '\(.name)' on $repo\""
  else
    gh api -X POST "/repos/$repo/rulesets" --input "$payload" --jq "\"created ruleset '\(.name)' on $repo\""
  fi
  rm -f "$payload"
}

if [ "$#" -eq 0 ]; then
  apply "$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
else
  for r in "$@"; do apply "$r"; done
fi
