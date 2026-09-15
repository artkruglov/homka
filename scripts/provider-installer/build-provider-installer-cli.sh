#!/bin/bash
# Builds one glibc GNU/Linux x86_64 Node SEA executable containing the complete provider installer CLI.
# Arguments: exact output executable path, stable release version, installation archive SHA-256.

set -euo pipefail

readonly PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly OUTPUT_PATH="${1:-}"
readonly RELEASE_VERSION="${2:-}"
readonly ARCHIVE_SHA256="${3:-}"
if [[ -z "$OUTPUT_PATH" || "$OUTPUT_PATH" != /* ]]; then
  printf '%s\n' \
    "OSINARA_CLI_BUILD_OUTPUT_INVALID: Укажите абсолютный путь выходного executable" >&2
  exit 64
fi
if [[ ! "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  printf '%s\n' "OSINARA_CLI_BUILD_VERSION_INVALID: Ожидается стабильная версия X.Y.Z" >&2
  exit 64
fi
if [[ ! "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' "OSINARA_CLI_BUILD_ARCHIVE_SHA_INVALID: Ожидается SHA-256 installation bundle" >&2
  exit 64
fi

for command in node cp chmod install mktemp rm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "OSINARA_CLI_BUILD_COMMAND_MISSING: Недоступна команда $command" >&2
    exit 69
  fi
done

readonly ESBUILD="${PROJECT_ROOT}/node_modules/.bin/esbuild"
readonly POSTJECT="${PROJECT_ROOT}/node_modules/.bin/postject"
if [[ ! -x "$ESBUILD" || ! -x "$POSTJECT" ]]; then
  printf '%s\n' \
    "OSINARA_CLI_BUILD_DEPENDENCY_MISSING: Выполните npm ci перед сборкой release CLI" >&2
  exit 69
fi

readonly WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/osinara-cli-build.XXXXXX")"
cleanup() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

# SEA executes one CommonJS entry script, so every package dependency is bundled into these bytes.
"$ESBUILD" "${PROJECT_ROOT}/scripts/provider-installer/osinara.ts" \
  --bundle \
  --define:OSINARA_INSTALL_ARCHIVE_SHA256="\"${ARCHIVE_SHA256}\"" \
  --define:OSINARA_INSTALL_RELEASE_VERSION="\"${RELEASE_VERSION}\"" \
  --format=cjs \
  --outfile="${WORK_DIR}/osinara-cli.cjs" \
  --platform=node \
  --target=node24
printf '%s\n' \
  '{' \
  "  \"main\": \"${WORK_DIR}/osinara-cli.cjs\"," \
  "  \"output\": \"${WORK_DIR}/osinara-cli.blob\"," \
  '  "disableExperimentalSEAWarning": true,' \
  '  "useCodeCache": false,' \
  '  "useSnapshot": false' \
  '}' > "${WORK_DIR}/sea-config.json"
node --experimental-sea-config "${WORK_DIR}/sea-config.json"

# Blob generation and injection must use the exact same Node binary version.
cp "$(command -v node)" "${WORK_DIR}/osinara-linux-x64"
"$POSTJECT" "${WORK_DIR}/osinara-linux-x64" NODE_SEA_BLOB "${WORK_DIR}/osinara-cli.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
chmod 0755 "${WORK_DIR}/osinara-linux-x64"
install -m 0755 "${WORK_DIR}/osinara-linux-x64" "$OUTPUT_PATH"
