#!/bin/bash
# Unit test for track_activity.sh's is_sensitive_path denylist.
# Extracts the function from the script (single source of truth) and exercises it.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$SCRIPT_DIR/scripts/track_activity.sh"

# Pull just the function definition out of the hook script and load it, so the
# test never runs the hook's stdin/curl side effects.
eval "$(sed -n '/^is_sensitive_path()/,/^}/p' "$SRC")"

fail=0
assert_sensitive() {
  if is_sensitive_path "$1"; then :; else echo "FAIL: expected sensitive: $1"; fail=1; fi
}
assert_ok() {
  if is_sensitive_path "$1"; then echo "FAIL: expected NON-sensitive: $1"; fail=1; else :; fi
}

# Sensitive
assert_sensitive ".env"
assert_sensitive "config/.env.production"
assert_sensitive "certs/server.pem"
assert_sensitive "tls/server.key"
assert_sensitive "home/user/.ssh/id_rsa"
assert_sensitive "id_ed25519"
assert_sensitive "deploy/kubeconfig"
assert_sensitive "clusters/prod.kubeconfig"
assert_sensitive "aws/credentials"
assert_sensitive "app/my-secrets.yaml"
assert_sensitive ".netrc"
assert_sensitive "project/.npmrc"
assert_sensitive "/home/u/.aws/config"
assert_sensitive "vault.p12"

# Non-sensitive
assert_ok "src/index.ts"
assert_ok "README.md"
assert_ok "docs/design.md"
assert_ok "package.json"

if [ "$fail" -eq 0 ]; then echo "PASS: all is_sensitive_path cases"; else echo "TEST FAILURES"; exit 1; fi
