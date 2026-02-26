#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SKILL_NAME="${PSAGENT_SKILL_NAME:-psagent-cli}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SRC_DIR="${REPO_ROOT}/skills/${SKILL_NAME}"
DST_DIR="${CODEX_HOME}/skills/${SKILL_NAME}"

if [[ ! -f "${SRC_DIR}/SKILL.md" ]]; then
  echo "Skill source not found: ${SRC_DIR}/SKILL.md" >&2
  exit 1
fi

mkdir -p "${CODEX_HOME}/skills"
rm -rf "${DST_DIR}"
mkdir -p "${DST_DIR}"
cp -R "${SRC_DIR}/." "${DST_DIR}/"

echo "Installed skill '${SKILL_NAME}' to ${DST_DIR}"
echo "Restart Codex to pick up the new skill."
