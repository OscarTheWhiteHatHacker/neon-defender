#!/usr/bin/env bash
# pr-guard - reject PR diffs that could smuggle executable or network behaviour
# into this static, offline app.
#
# usage: scripts/pr-guard.sh [base-ref]        (default: origin/main)
# exit:  0 ok, 1 findings, 2 cannot evaluate (missing ref / git error)
set -uo pipefail

BASE="${1:-origin/main}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "pr-guard: base ref '$BASE' not found" >&2
  exit 2
fi

# only code files are scanned; docs are allowed to contain arbitrary prose
DIFF=$(git diff --unified=0 "$BASE"...HEAD -- \
  '*.js' '*.mjs' '*.cjs' '*.html' '*.css' '*.json' \
  ':(exclude)scripts/pr-guard.sh' 2>/dev/null) || {
  echo "pr-guard: git diff failed" >&2
  exit 2
}

ADDED=$(printf '%s\n' "$DIFF" | grep -E '^\+' | grep -vE '^\+\+\+' || true)

if [ -z "$ADDED" ]; then
  echo "pr-guard: OK (no code lines added)"
  exit 0
fi

status=0
check() { # $1 pattern, $2 message, $3 optional allow-pattern
  local hits
  hits=$(printf '%s\n' "$ADDED" | grep -nE "$1" || true)
  if [ -n "${3:-}" ] && [ -n "$hits" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "$3" || true)
  fi
  if [ -n "$hits" ]; then
    echo "pr-guard: FAIL - $2"
    printf '%s\n' "$hits" | head -5 | sed 's/^/    /'
    status=1
  fi
}

check '\beval[[:space:]]*\('                      'dynamic code: eval()'
check 'new[[:space:]]+Function[[:space:]]*\('     'dynamic code: new Function()'
check 'document\.write[[:space:]]*\('             'document.write()'
check '(innerHTML|outerHTML)[[:space:]]*\+?='     'HTML string injection'
check '\batob[[:space:]]*\('                      'base64 decoding (obfuscation)'
check '(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|navigator\.sendBeacon)[[:space:]]*\(' \
                                                  'network API (this app is offline)'
check '\(execSync|spawnSync|child_process\)'      'process execution'
check '(onclick|onerror|onload)[[:space:]]*='     'inline event handler attribute'
check 'https?://'                                 'hardcoded external URL' \
                                                  'www\.w3\.org|github\.com|creativecommons\.org'

# CI / manifest changes are a supply-chain surface: maintainers only
CHANGED=$(git diff --name-only "$BASE"...HEAD 2>/dev/null || true)
SENSITIVE=$(printf '%s\n' "$CHANGED" | grep -E '^(\.github/workflows/|\.github/actions/|package\.json|package-lock\.json)' || true)
if [ -n "$SENSITIVE" ]; then
  echo "pr-guard: files touching CI or manifests:"
  printf '%s\n' "$SENSITIVE" | sed 's/^/    /'
  if [ "${ACTOR:-}" != "${OWNER:-}" ] && [ "${MAINTAINER_LABEL:-no}" != "yes" ]; then
    echo "pr-guard: FAIL - CI/manifest changes need a maintainer (label 'maintainer-approved')"
    status=1
  fi
fi

[ "$status" -eq 0 ] && echo "pr-guard: OK"
exit "$status"
