#!/bin/bash
# Test du hook path-scope audit-output (#177). Convention du pont vitest
# (tests/unit/shell-scripts.test.ts) : SUCCÈS = aucune sortie ; toute ligne
# imprimée fait échouer le test.
set -u
GUARD="$(cd "$(dirname "$0")/.." && pwd)/scripts/audit_output_guard.sh"

fail() { echo "FAIL: $*"; }

# Repo git temporaire = racine du workspace (cwd de claude en mode shared).
REPO=$(mktemp -d 2>/dev/null || mktemp -d -t auditguard)
git -C "$REPO" init -q
mkdir -p "$REPO/src"
: > "$REPO/src/existing.ts"
: > "$REPO/AUDIT.md"            # livrable de gardien, déjà présent
cd "$REPO" || { fail "cd repo"; exit 1; }

# run_guard <tool> <file_path> -- <allowed...>  => imprime la sortie du guard
run_guard() {
  local tool="$1" fp="$2"; shift 2; shift  # drop the "--"
  printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$tool" "$fp" \
    | bash "$GUARD" "$@"
}

assert_allow() { # <desc> <tool> <fp> -- <allowed...>
  local desc="$1"; shift
  local out; out=$(run_guard "$@")
  [ -n "$out" ] && fail "$desc : attendu AUTORISÉ (sortie vide), reçu: $out"
}
assert_deny() { # <desc> <tool> <fp> -- <allowed...>
  local desc="$1"; shift
  local out; out=$(run_guard "$@")
  case "$out" in
    *'"permissionDecision":"deny"'*) ;;  # ok
    *) fail "$desc : attendu REFUSÉ, reçu: ${out:-<vide>}" ;;
  esac
}

# --- AUTORISÉ : les livrables d'audit déclarés ---
assert_allow "AUDIT.md existant"        Write "$REPO/AUDIT.md"            -- "AUDIT.md"
assert_allow "AUDIT.md via chemin relatif" Write "AUDIT.md"              -- "AUDIT.md"
# fichier pas encore créé (premier write) : le dossier parent (repo) existe
assert_allow "livrable pas encore créé" Write "$REPO/PLAN.md"            -- "PLAN.md"
# phare : tmp/audit/ n'existe PAS encore -> doit rester autorisé (préfixe existant = repo)
assert_allow "tmp/audit/x.yaml (dossier absent)" Write "$REPO/tmp/audit/inventaire.yaml" -- "tmp/audit/inventaire.yaml"

# --- REFUSÉ : hors périmètre ---
assert_deny "src/x.ts hors liste"       Write "$REPO/src/x.ts"           -- "AUDIT.md"
assert_deny "fichier existant hors liste" Write "$REPO/src/existing.ts"  -- "AUDIT.md"
# traversée : AUDIT.md/../src/x.ts se résout en src/x.ts, pas AUDIT.md
assert_deny "traversée ../"             Write "$REPO/AUDIT.md/../src/x.ts" -- "AUDIT.md"
assert_deny "traversée relative"        Write "tmp/audit/../../etc/passwd" -- "tmp/audit/inventaire.yaml"
# chemin absolu hors du repo
assert_deny "absolu hors repo"          Write "/tmp/evil.txt"            -- "AUDIT.md"
# un préfixe qui RESSEMBLE mais diffère
assert_deny "préfixe trompeur"          Write "$REPO/AUDIT.md.bak"       -- "AUDIT.md"

# --- Cas neutres ---
# outil hors Edit/Write/NotebookEdit -> autorisé (hors périmètre du hook)
assert_allow "Read hors périmètre"      Read  "$REPO/src/x.ts"           -- "AUDIT.md"
# Write sans chemin -> autorisé (rien à scoper ; Write échouerait de toute façon)
out=$(printf '{"tool_name":"Write","tool_input":{}}' | bash "$GUARD" "AUDIT.md")
[ -n "$out" ] && fail "Write sans chemin : sortie inattendue: $out"

# --- Nettoyage ---
cd /
rm -rf "$REPO"
exit 0
