#!/bin/bash
# Blocks mutating tools while an investigate-mode marker exists for THIS session.
# Marker: ~/.claude/investigate-mode/<session_id>
# Requires: jq
input=$(cat)
J() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

sid=$(J '.session_id // ""')
if [ -z "$sid" ] || [ "$sid" = "null" ]; then
  tp=$(J '.transcript_path // ""')
  [ -n "$tp" ] && sid=$(basename "$tp" .jsonl)
fi
[ -z "$sid" ] && exit 0

marker="$HOME/.claude/investigate-mode/$sid"
[ -f "$marker" ] || exit 0

tool=$(J '.tool_name // ""')
cmd=$(J '.tool_input.command // ""')

# Always allow the escape hatch: clearing the marker.
case "$cmd" in *investigate-mode*) exit 0 ;; esac

block() {
  jq -nc --arg r "🔍 investigate mode is active for this session: read-only, no edits or state changes.
If the user has approved this action, run:  rm '$marker'
then retry. Do not clear it on your own initiative." '{decision:"block",reason:$r}'
  exit 2
}

case "$tool" in
  Edit|Write|NotebookEdit) block ;;
esac

if [ "$tool" = "Bash" ]; then
  if printf '%s' "$cmd" | grep -qE '(^|[;&|`(]|[[:space:]])(git[[:space:]]+(commit|push|stash|reset|rebase|merge|cherry-pick|revert|checkout|switch|restore|apply|clean|tag|branch[[:space:]]+-[dD])|rm|rmdir|mv|cp|truncate|tee|dd|chmod|chown|ln|mkdir|touch|patch|npm[[:space:]]+(i|install|uninstall)|pip[[:space:]]+(install|uninstall)|uv[[:space:]]+(add|remove|sync|pip)|brew[[:space:]]+(install|uninstall|upgrade)|cargo[[:space:]]+(install|add|remove)|make|alembic|pytest|docker|kubectl)([[:space:]]|$)'; then
    block
  fi
  # in-place edits and output redirection
  if printf '%s' "$cmd" | grep -qE "sed[[:space:]]+(-[a-zA-Z]*i|--in-place)|[^>&|]>[^>&|(]|>>"; then
    block
  fi
fi
exit 0
