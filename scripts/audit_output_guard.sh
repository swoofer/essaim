#!/bin/bash
# PreToolUse hook (#177) — path-scope les écritures des presets audit-output.
#
# Sous `--dangerously-skip-permissions` (le mode de l'agent-loop coordonné),
# `--allowedTools` est purement indicatif : le SEUL verrou par-CHEMIN est un hook
# PreToolUse. Ce hook autorise Write/Edit/NotebookEdit UNIQUEMENT sur les chemins
# d'audit déclarés (passés en arguments, relatifs à la racine du dépôt), et refuse
# toute autre cible. Bash n'est PAS géré ici (le matcher PreToolUse câblé par
# essaim ne cible qu'Edit|Write|NotebookEdit) : il est retiré de l'outillage
# audit-output côté agent-loop.
#
# Le REFUS passe par un JSON de décision sur stdout + exit 0 — vérifié contre un
# vrai claude. C'est nécessaire : le wrapper de hook généré par promptweave fait
# `"$script" || exit 1`, ce qui convertirait un exit 2 (blocage) en exit 1 (erreur
# non bloquante) et laisserait passer l'écriture. stdout+exit 0 survit au wrapper.
#
# Résistance à la traversée : on résout le plus long préfixe EXISTANT du chemin
# cible via `cd`+`pwd -P` (donc `..` et symlinks du préfixe sont résolus), on
# rejette tout `..` restant dans la partie non existante, puis on compare les
# chemins ABSOLUS. Un chemin hors dépôt, ou un `AUDIT.md/../src/x.ts`, ne peut donc
# pas se faire passer pour un chemin autorisé.

# FAIL-CLOSED si jq est absent : sans jq on ne peut PAS lire le chemin cible, donc
# on ne peut pas décider — un guard de sécurité doit alors REFUSER (jamais
# autoriser en silence). Le deny est littéral (pas via jq, qui manque). jq est
# une dépendance connue (essaim doctor la vérifie) ; ce garde-fou couvre l'hôte
# Windows/Git-Bash par défaut où jq n'est pas fourni. (#177, revue sécurité.)
if ! command -v jq >/dev/null 2>&1; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"audit-output (#177): jq introuvable, impossible de path-scoper — ecriture refusee (fail-closed). Installez jq (essaim doctor)."}}'
  exit 0
fi

INPUT=$(cat 2>/dev/null)
# stdin vide = on ne peut pas décider quel fichier -> refus (fail-closed). Avant,
# `exit 0` (allow) transformait un drain de pipe en autorisation silencieuse.
if [ -z "$INPUT" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"audit-output (#177): entree du hook vide, impossible de determiner le fichier — ecriture refusee (fail-closed)."}}'
  exit 0
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;  # hors périmètre de ce hook
esac

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // ""' 2>/dev/null)
if [ -z "$FILE_PATH" ] || [ "$FILE_PATH" = "null" ]; then
  exit 0  # rien à scoper (Write sans chemin échouerait de toute façon)
fi

# Chemin absolu physique : résout le plus long préfixe EXISTANT (pwd -P) puis
# recolle le reste. Rend un code non nul si la partie non résolue contient `..`
# (traversée déguisée) ou si le préfixe existant n'est pas un dossier accessible.
resolve_physical() {
  local p="$1" base tail="" existing real
  [ -z "$p" ] && return 1
  p="${p//\\//}"  # backslashes -> slashes
  # rendre absolu (contre le cwd de claude = racine du workspace)
  case "$p" in
    /*) ;;           # /abs (MSYS)
    [A-Za-z]:/*) ;;  # C:/abs (Windows)
    *) p="$PWD/$p" ;;
  esac
  # Résoudre le DOSSIER (jamais le fichier : `cd` sur un fichier échoue). On
  # remonte au plus long ANCÊTRE existant, en accumulant la queue non résolue.
  base="$(basename "$p")"
  existing="$(dirname "$p")"
  while [ ! -d "$existing" ]; do
    case "$existing" in / | [A-Za-z]:/ | "" | .) break ;; esac
    tail="$(basename "$existing")${tail:+/$tail}"
    existing="$(dirname "$existing")"
  done
  # `..` n'importe où dans la partie NON résolue (queue + base) = traversée non
  # vérifiable -> refus.
  case "/$tail/$base/" in */../* | */..) return 1 ;; esac
  real="$(cd "$existing" 2>/dev/null && pwd -P)" || return 1
  printf '%s' "${real}${tail:+/$tail}/$base"
}

ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$ROOT" ] && ROOT="$PWD"
ROOT_REAL=$(cd "$ROOT" 2>/dev/null && pwd -P) || ROOT_REAL="$PWD"

TARGET=$(resolve_physical "$FILE_PATH")
target_ok=$?

deny() {
  local reason="$1"
  jq -cn --arg r "$reason" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

if [ "$target_ok" -ne 0 ] || [ -z "$TARGET" ]; then
  deny "audit-output (#177) : chemin d'écriture non résoluble ou traversant (« $FILE_PATH ») — refusé."
fi

# La cible (feuille) est un lien symbolique DÉJÀ présent : resolve_physical ne
# résout que le DOSSIER, pas la feuille — une écriture suivrait le lien hors
# scope. On refuse ; un livrable d'audit légitime est un fichier régulier. (#177)
if [ -L "$TARGET" ] || [ -L "$FILE_PATH" ]; then
  deny "audit-output (#177) : la cible « $FILE_PATH » est un lien symbolique — refusé."
fi

# Les chemins autorisés arrivent en args : soit un par arg, soit tous dans un
# seul arg séparés par des espaces (promptweave sérialise le tableau `paths` en
# un arg). On accepte les deux (les chemins d'audit ne contiennent pas d'espace).
for arg in "$@"; do
  for allowed in $arg; do  # $arg NON quoté -> word-split sur les espaces
    [ -z "$allowed" ] && continue
    allowed="${allowed//\\//}"
    allowed="${allowed#./}"
    A=$(resolve_physical "$ROOT_REAL/$allowed") || continue
    if [ "$TARGET" = "$A" ]; then
      exit 0  # autorisé : c'est un des livrables d'audit déclarés
    fi
  done
done

deny "audit-output (#177) : « $FILE_PATH » est hors des chemins d'audit autorisés ($*) — écriture refusée."
