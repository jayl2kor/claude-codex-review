#!/usr/bin/env bash
set -euo pipefail

CONFIG_ROOT="$HOME/.config/claude-codex-review"
STATE_ROOT="$HOME/.local/state/claude-codex-review"
ENABLED_FILE="$CONFIG_ROOT/enabled-workspaces.txt"

inside_cmux() {
  [ -n "${CMUX_WORKSPACE_ID:-}" ] && [ -n "${CMUX_SURFACE_ID:-}" ]
}

workspace_enabled() {
  inside_cmux || return 1
  [ -f "$ENABLED_FILE" ] || return 1
  grep -Fxq "$CMUX_WORKSPACE_ID" "$ENABLED_FILE"
}

workspace_config_dir() {
  printf '%s/workspaces/%s\n' "$CONFIG_ROOT" "$CMUX_WORKSPACE_ID"
}

workspace_state_dir() {
  printf '%s/%s\n' "$STATE_ROOT" "$CMUX_WORKSPACE_ID"
}

claude_surface_file() {
  printf '%s/claude-surface\n' "$(workspace_config_dir)"
}

codex_surface_file() {
  printf '%s/codex-surface\n' "$(workspace_config_dir)"
}

registered_claude_surface() {
  [ -f "$(claude_surface_file)" ] && cat "$(claude_surface_file)"
}

registered_codex_surface() {
  [ -f "$(codex_surface_file)" ] && cat "$(codex_surface_file)"
}

has_registered_surfaces() {
  [ -s "$(claude_surface_file)" ] && [ -s "$(codex_surface_file)" ]
}
