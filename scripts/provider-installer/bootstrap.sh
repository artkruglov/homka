#!/bin/sh
# Downloads, persists, and executes one checksum-pinned Osinara release CLI asset.
# Arguments: immutable CLI asset URL and expected SHA-256.

set -eu

readonly ASSET_URL="${1:-}"
readonly EXPECTED_SHA256="${2:-}"
if [ -z "$ASSET_URL" ] || [ -z "$EXPECTED_SHA256" ]; then
  printf '%s\n' \
    "OSINARA_BOOTSTRAP_ARGUMENT_MISSING: Укажите immutable asset URL и ожидаемый SHA-256" >&2
  exit 64
fi
case "$ASSET_URL" in
  https://github.com/nyxandro/osinara/releases/download/v*/osinara-linux-x64) ;;
  *)
    printf '%s\n' "OSINARA_BOOTSTRAP_URL_INVALID: CLI должен быть exact asset canonical Osinara release" >&2
    exit 64
    ;;
esac
release_version="${ASSET_URL#https://github.com/nyxandro/osinara/releases/download/v}"
release_version="${release_version%/osinara-linux-x64}"
case "$release_version" in
  ''|*[!0-9.]*|.*|*..*|*.)
    printf '%s\n' "OSINARA_BOOTSTRAP_URL_INVALID: Release tag должен быть стабильной версией X.Y.Z" >&2
    exit 64
    ;;
esac
version_remainder="${release_version#*.}"
version_patch="${version_remainder#*.}"
if [ "$version_remainder" = "$release_version" ] || \
  [ "$version_patch" = "$version_remainder" ] || \
  [ "${version_patch#*.}" != "$version_patch" ]; then
  printf '%s\n' "OSINARA_BOOTSTRAP_URL_INVALID: Release tag должен быть стабильной версией X.Y.Z" >&2
  exit 64
fi
case "$EXPECTED_SHA256" in
  *[!0-9a-f]*)
    printf '%s\n' "OSINARA_BOOTSTRAP_CHECKSUM_INVALID: Ожидается SHA-256 из 64 строчных hex-символов" >&2
    exit 64
    ;;
esac
if [ "${#EXPECTED_SHA256}" -ne 64 ]; then
  printf '%s\n' "OSINARA_BOOTSTRAP_CHECKSUM_INVALID: Ожидается SHA-256 из 64 строчных hex-символов" >&2
  exit 64
fi
shift 2
if [ "$#" -ne 0 ]; then
  printf '%s\n' "OSINARA_BOOTSTRAP_ARGUMENT_INVALID: install.sh не принимает дополнительные аргументы" >&2
  exit 64
fi

for command in curl sha256sum mktemp chmod id install rm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf '%s\n' "OSINARA_BOOTSTRAP_COMMAND_MISSING: Недоступна обязательная команда $command" >&2
    exit 69
  fi
done

temporary_asset="$(mktemp "${TMPDIR:-/tmp}/osinara-cli.XXXXXX")"
cleanup() {
  rm -f "$temporary_asset"
}
trap cleanup EXIT HUP INT TERM

if ! curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$temporary_asset" "$ASSET_URL"; then
  printf '%s\n' "OSINARA_BOOTSTRAP_DOWNLOAD_FAILED: Не удалось загрузить release CLI asset" >&2
  exit 69
fi
actual_sha256="$(sha256sum "$temporary_asset")"
actual_sha256="${actual_sha256%% *}"
if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  printf '%s\n' "OSINARA_BOOTSTRAP_CHECKSUM_MISMATCH: SHA-256 release CLI asset не совпадает" >&2
  exit 65
fi

chmod 0700 "$temporary_asset"
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "OSINARA_BOOTSTRAP_ROOT_REQUIRED: Для установки CLI нужен пользователь root" >&2
  exit 77
fi

# Persist verified bytes before host mutation so recovery commands survive an ambiguous install failure.
install -o root -g root -m 0755 "$temporary_asset" /usr/local/bin/osinara
"$temporary_asset" install
