#!/usr/bin/env bash
set -euo pipefail

MIHOMO_VERSION="v1.19.34"
# Official release sha256 for linux amd64 compatible v1.19.34
MIHOMO_SHA256_AMD64="2763f5b414527f7baf6dc57e3f82f3ab561eedf34bfd7c2f2cde1f7e592efe06"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
DEFAULT_BIN="${BIN_DIR}/mihomo"

echo "=== SubPanel Mihomo Kernel Setup ==="

# 1. Check MIHOMO_BIN env var
if [[ -n "${MIHOMO_BIN:-}" && -x "${MIHOMO_BIN}" ]]; then
  echo "Found mihomo via MIHOMO_BIN: ${MIHOMO_BIN}"
  "${MIHOMO_BIN}" -v
  exit 0
fi

# 2. Check local workspace bin
if [[ -x "${DEFAULT_BIN}" ]]; then
  echo "Found mihomo in local workspace: ${DEFAULT_BIN}"
  "${DEFAULT_BIN}" -v
  exit 0
fi

# 3. Check system existing binaries
echo "Searching for existing mihomo binary on machine..."
FOUND_BIN=""
SEARCH_DIRS=("/usr/local/bin" "/opt" "/data" "${HOME}")
for sdir in "${SEARCH_DIRS[@]}"; do
  if [[ -d "${sdir}" ]]; then
    # find executable named mihomo
    match=$(find "${sdir}" -maxdepth 4 -type f -name "mihomo" -perm -111 2>/dev/null | head -n 1 || true)
    if [[ -n "${match}" && -x "${match}" ]]; then
      FOUND_BIN="${match}"
      break
    fi
  fi
done

if [[ -n "${FOUND_BIN}" ]]; then
  echo "Found existing mihomo binary at: ${FOUND_BIN}"
  mkdir -p "${BIN_DIR}"
  ln -sf "${FOUND_BIN}" "${DEFAULT_BIN}"
  "${DEFAULT_BIN}" -v
  exit 0
fi

# 4. Download from official GitHub releases (MetaCubeX/mihomo)
ARCH="$(uname -m)"
OS="$(uname -s)"
if [[ "${OS}" != "Linux" || "${ARCH}" != "x86_64" ]]; then
  echo "Error: Unsupported platform ${OS} ${ARCH} for automated download." >&2
  exit 1
fi

URL="https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz"
EXPECTED_SHA256="${MIHOMO_SHA256_AMD64}"

echo "No existing binary found. Downloading ${MIHOMO_VERSION} from MetaCubeX/mihomo..."
echo "Download URL: ${URL}"

mkdir -p "${BIN_DIR}"
TMP_GZ="${BIN_DIR}/mihomo-${MIHOMO_VERSION}.gz"

if ! curl -sSL -f "${URL}" -o "${TMP_GZ}"; then
  echo "Error: Failed to download mihomo from ${URL}" >&2
  rm -f "${TMP_GZ}"
  exit 1
fi

echo "Verifying SHA256 checksum..."
ACTUAL_SHA256="$(sha256sum "${TMP_GZ}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "Error: SHA256 mismatch!" >&2
  echo "  Expected: ${EXPECTED_SHA256}" >&2
  echo "  Actual:   ${ACTUAL_SHA256}" >&2
  rm -f "${TMP_GZ}"
  exit 1
fi

echo "SHA256 verified successfully (${ACTUAL_SHA256})."
gzip -dc "${TMP_GZ}" > "${DEFAULT_BIN}"
rm -f "${TMP_GZ}"
chmod +x "${DEFAULT_BIN}"

echo "Mihomo setup complete: ${DEFAULT_BIN}"
"${DEFAULT_BIN}" -v
