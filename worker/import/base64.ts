const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const recognizedUriLine = /(?:^|\r?\n)\s*(?:ss|ssr|vmess|v2rayn|vless|trojan(?:-go)?|hysteria|hy|hysteria2|hy2|tuic|anytls|naive(?:\+https)?|https?|socks5?|socks):\/\//iu

export function containsRecognizedUri(content: string): boolean {
  return recognizedUriLine.test(content)
}

export function decodeBase64Utf8(value: string): string | null {
  const compact = value.trim().replace(/\s+/gu, '')
  if (!compact || !/^[A-Za-z0-9+/_-]*={0,2}$/u.test(compact) || compact.length % 4 === 1) return null

  try {
    const normalized = compact.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

export function decodeSubscriptionBase64(content: string): string | null {
  const decoded = decodeBase64Utf8(content)
  return decoded && containsRecognizedUri(decoded) ? decoded : null
}
