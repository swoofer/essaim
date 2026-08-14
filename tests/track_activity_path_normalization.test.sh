#!/bin/bash
# Unit test for track_activity.sh's normalize_file_path.
#
# Extracts the function from the hook script (single source of truth) and
# exercises it against real git repos, including a TWO-LEVEL submodule nest —
# `git rev-parse --show-superproject-working-tree` only ever returns the
# IMMEDIATE superproject, so a naive call reports paths relative to the middle
# repo instead of the outermost workspace (#100).
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$SCRIPT_DIR/scripts/track_activity.sh"

eval "$(sed -n '/^normalize_file_path()/,/^}/p' "$SRC")"

if ! declare -f normalize_file_path > /dev/null; then
  echo "FAIL: normalize_file_path introuvable dans $SRC"
  exit 1
fi

fail=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok   $label"
  else
    echo "  FAIL $label"
    echo "       attendu: $expected"
    echo "       obtenu : $actual"
    fail=1
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

git_quiet() { git -c protocol.file.allow=always -c init.defaultBranch=main "$@" > /dev/null 2>&1; }
mkrepo() {
  mkdir -p "$1" && git_quiet -C "$1" init
  git_quiet -C "$1" config user.email t@t.co
  git_quiet -C "$1" config user.name T
}

# ── Cas 1 : checkout plat ──────────────────────────────────────────────────
mkrepo "$TMP/flat"
mkdir -p "$TMP/flat/src"
echo x > "$TMP/flat/src/foo.ts"
git_quiet -C "$TMP/flat" add . && git_quiet -C "$TMP/flat" commit -m init

check "checkout plat -> chemin relatif au dépôt" \
  "src/foo.ts" \
  "$(normalize_file_path "$TMP/flat/src/foo.ts")"

# ── Cas 2 : backslashes, comme sous Git Bash ───────────────────────────────
# La conversion doit précéder la comparaison de préfixe, sinon le strip est
# sauté et un chemin ABSOLU part au coordinator.
check "backslashes normalisés avant le strip" \
  "src/foo.ts" \
  "$(normalize_file_path "${TMP//\//\\}\\flat\\src\\foo.ts")"

# ── Cas 3 : submodule imbriqué sur DEUX niveaux ────────────────────────────
mkrepo "$TMP/inner"
mkdir -p "$TMP/inner/lib"
echo y > "$TMP/inner/lib/deep.ts"
git_quiet -C "$TMP/inner" add . && git_quiet -C "$TMP/inner" commit -m init

mkrepo "$TMP/middle"
echo m > "$TMP/middle/m.txt"
git_quiet -C "$TMP/middle" add . && git_quiet -C "$TMP/middle" commit -m init
git_quiet -C "$TMP/middle" submodule add "$TMP/inner" sub
git_quiet -C "$TMP/middle" commit -m "add inner"

mkrepo "$TMP/outer"
echo o > "$TMP/outer/o.txt"
git_quiet -C "$TMP/outer" add . && git_quiet -C "$TMP/outer" commit -m init
git_quiet -C "$TMP/outer" submodule add "$TMP/middle" mid
git_quiet -C "$TMP/outer" commit -m "add middle"
git_quiet -C "$TMP/outer" submodule update --init --recursive

NESTED="$TMP/outer/mid/sub/lib/deep.ts"
if [ -f "$NESTED" ]; then
  check "submodule à deux niveaux -> relatif au dépôt le plus EXTERNE" \
    "mid/sub/lib/deep.ts" \
    "$(normalize_file_path "$NESTED")"
else
  echo "  skip submodule imbriqué (git n'a pas monté $NESTED)"
fi

# ── Cas 4 : hors dépôt git ─────────────────────────────────────────────────
mkdir -p "$TMP/nogit"
echo z > "$TMP/nogit/loose.ts"
check "hors dépôt -> chemin rendu tel quel, en slashes" \
  "$TMP/nogit/loose.ts" \
  "$(normalize_file_path "$TMP/nogit/loose.ts")"

if [ "$fail" -eq 0 ]; then
  echo "PASS track_activity path normalization"
else
  echo "FAIL track_activity path normalization"
fi
exit "$fail"
