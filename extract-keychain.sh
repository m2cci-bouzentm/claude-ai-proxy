#!/bin/bash
set -euo pipefail

CREDS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"

if [ "$(uname)" != "Darwin" ]; then
  echo "ERROR: macOS only. On Linux, credentials are already at $CREDS"
  exit 1
fi

mkdir -p "$(dirname "$CREDS")"
security find-generic-password -a "$(whoami)" -s "Claude Code-credentials" -w > "$CREDS"

if [ ! -s "$CREDS" ]; then
  rm "$CREDS"
  echo "ERROR: No Claude Code credentials in Keychain. Run 'claude' and log in first."
  exit 1
fi

echo "Extracted to $CREDS"
