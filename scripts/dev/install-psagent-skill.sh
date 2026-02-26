#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SKILL_NAME="${PSAGENT_SKILL_NAME:-psagent-cli}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SRC_FILE="${REPO_ROOT}/skill.md"
DST_DIR="${CODEX_HOME}/skills/${SKILL_NAME}"

if [[ ! -f "${SRC_FILE}" ]]; then
  legacy_docs_file="${REPO_ROOT}/docs/skill.md"
  if [[ -f "${legacy_docs_file}" ]]; then
    SRC_FILE="${legacy_docs_file}"
  fi
fi

if [[ ! -f "${SRC_FILE}" ]]; then
  legacy_file="${REPO_ROOT}/skills/${SKILL_NAME}/SKILL.md"
  if [[ -f "${legacy_file}" ]]; then
    SRC_FILE="${legacy_file}"
  fi
fi

if [[ ! -f "${SRC_FILE}" ]]; then
  echo "Skill source not found: ${SRC_FILE}" >&2
  exit 1
fi

mkdir -p "${CODEX_HOME}/skills"
rm -rf "${DST_DIR}"
mkdir -p "${DST_DIR}"
cp "${SRC_FILE}" "${DST_DIR}/SKILL.md"

echo "Installed skill '${SKILL_NAME}' to ${DST_DIR}"
echo "Restart Codex to pick up the new skill."
