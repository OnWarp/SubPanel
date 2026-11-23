#!/usr/bin/env bash
set -euo pipefail

SINGBOX_VERSION="v1.14.4"
# Official release sha256 for sing-box-1.14.4-linux-amd64.tar.gz
SINGBOX_SHA256_AMD64="699a1b510aa4396b2176d32d1181920399ebf1e267835da6f3b598d0f7c24968"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
DEFAULT_BIN="${BIN_DIR}/sing-box"

echo "=== SubPanel sing-box Kernel Setup ==="

# 1. Check SING_BOX_BIN or SINGBOX_BIN env var
for env_bin in "${SING_BOX_BIN:-}" "${SINGBOX_BIN:-}"; do
  if [[ -n "${env_bin}" && -x "${env_bin}" ]]; then
    echo "Found sing-box via environment: ${env_bin}"
    "${env_bin}" version
    exit 0
  fi
done

# 2. Check local workspace bin
if [[ -x "${DEFAULT_BIN}" ]]; then
  echo "Found sing-box in local workspace: ${DEFAULT_BIN}"
  "${DEFAULT_BIN}" version
  exit 0
fi

# 3. Check system existing binaries
echo "Searching for existing sing-box binary on machine..."
FOUND_BIN=""
SEARCH_DIRS=("/usr/local/bin" "/opt" "/data" "${HOME}")
for sdir in "${SEARCH_DIRS[@]}"; do
  if [[ -d "${sdir}" ]]; then
    match=$(find "${sdir}" -maxdepth 4 -type f -name "sing-box" -perm -111 2>/dev/null | head -n 1 || true)
    if [[ -n "${match}" && -x "${match}" ]]; then
      FOUND_BIN="${match}"
      break
    fi
  fi
done

if [[ -n "${FOUND_BIN}" ]]; then
  echo "Found existing sing-box binary at: ${FOUND_BIN}"
  mkdir -p "${BIN_DIR}"
  ln -sf "${FOUND_BIN}" "${DEFAULT_BIN}"
  "${DEFAULT_BIN}" version
  exit 0
fi

# 4. Download from official GitHub releases (SagerNet/sing-box)
ARCH="$(uname -m)"
OS="$(uname -s)"
if [[ "${OS}" != "Linux" || "${ARCH}" != "x86_64" ]]; then
  echo "Error: Unsupported platform ${OS} ${ARCH} for automated download." >&2
  exit 1
fi

URL="https://github.com/SagerNet/sing-box/releases/download/${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION#v}-linux-amd64.tar.gz"
EXPECTED_SHA256="${SINGBOX_SHA256_AMD64}"

echo "No existing binary found. Downloading ${SINGBOX_VERSION} from SagerNet/sing-box..."
echo "Download URL: ${URL}"

mkdir -p "${BIN_DIR}"
TMP_TAR="${BIN_DIR}/sing-box-${SINGBOX_VERSION}.tar.gz"
TMP_EXTRACT="${BIN_DIR}/tmp_extract_${SINGBOX_VERSION}"

if ! curl -sSL -f "${URL}" -o "${TMP_TAR}"; then
  echo "Error: Failed to download sing-box from ${URL}" >&2
  rm -f "${TMP_TAR}"
  exit 1
fi

echo "Verifying SHA256 checksum..."
ACTUAL_SHA256="$(sha256sum "${TMP_TAR}" | awk '{print $1}')"
if [[ "${ACTUAL_SHA256}" != "${EXPECTED_SHA256}" ]]; then
  echo "Error: SHA256 mismatch!" >&2
  echo "  Expected: ${EXPECTED_SHA256}" >&2
  echo "  Actual:   ${ACTUAL_SHA256}" >&2
  rm -f "${TMP_TAR}"
  exit 1
fi

echo "SHA256 verified successfully (${ACTUAL_SHA256})."
mkdir -p "${TMP_EXTRACT}"
tar -xzf "${TMP_TAR}" -C "${TMP_EXTRACT}"
EXTRACTED_BIN="$(find "${TMP_EXTRACT}" -type f -name "sing-box" -perm -111 | head -n 1)"
if [[ -z "${EXTRACTED_BIN}" || ! -x "${EXTRACTED_BIN}" ]]; then
  echo "Error: Failed to find executable sing-box in extracted archive" >&2
  rm -rf "${TMP_TAR}" "${TMP_EXTRACT}"
  exit 1
fi

mv "${EXTRACTED_BIN}" "${DEFAULT_BIN}"
chmod +x "${DEFAULT_BIN}"
rm -rf "${TMP_TAR}" "${TMP_EXTRACT}"

echo "sing-box setup complete: ${DEFAULT_BIN}"
"${DEFAULT_BIN}" version
