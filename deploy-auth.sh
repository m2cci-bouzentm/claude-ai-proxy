#!/bin/bash
set -euo pipefail

SSH_CMD="${1:?Usage: ./deploy-auth.sh 'ssh -i ~/.ssh/key user@host'}"
REMOTE=$(echo "$SSH_CMD" | grep -oE '[^ ]+@[^ ]+')
SSH_OPTS=$(echo "$SSH_CMD" | sed "s|ssh ||; s|$REMOTE||")
LOCAL_CREDS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"

echo "=== Claude Proxy Auth Deploy ==="

if [ ! -f "$LOCAL_CREDS" ]; then
  echo "ERROR: $LOCAL_CREDS not found."
  echo "Run 'claude' and log in, or extract from Keychain:"
  echo "  ./extract-keychain.sh"
  exit 1
fi

echo "[1/2] Uploading credentials to VPS..."
$SSH_CMD "mkdir -p ~/.claude"
scp $SSH_OPTS "$LOCAL_CREDS" "$REMOTE:~/.claude/.credentials.json"

echo "[2/2] Removing local credentials..."
rm "$LOCAL_CREDS"

echo "=== Done. Start container with: docker compose up -d --build ==="
