// Client URL schemes accept the existing subscription URL without altering API data.
export function clientImportLink(client: string, link: string): string | null {
  if (!link) return null
  const encoded = encodeURIComponent(link)
  const schemes: Record<string, string> = {
    clash: 'clash://install-config?url=', mihomo: 'clash://install-config?url=', 'clash-meta': 'clash://install-config?url=',
    stash: 'stash://install-config?url=', surge: 'surge:///install-config?url=', loon: 'loon://import?sub=',
    shadowrocket: 'shadowrocket://add/sub://',
  }
  if (client === 'shadowrocket') return `shadowrocket://add/sub://${btoa(Array.from(new TextEncoder().encode(link), byte => String.fromCharCode(byte)).join(''))}`
  return Object.hasOwn(schemes, client) ? schemes[client] + encoded : null
}

export type ImportDevice = 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'unknown'

export function detectImportDevice(userAgent: string, touchPoints = 0): ImportDevice {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return 'ios'
  if (/Android/i.test(userAgent)) return 'android'
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  if (/Linux/i.test(userAgent)) return 'linux'
  return 'unknown'
}

const preferredClients: Record<ImportDevice, readonly string[]> = {
  ios: ['shadowrocket', 'stash', 'surge', 'loon'],
  android: ['mihomo', 'clash', 'clash-meta'],
  windows: ['mihomo', 'clash', 'clash-meta'],
  macos: ['mihomo', 'clash', 'clash-meta', 'stash', 'surge'],
  linux: ['mihomo', 'clash', 'clash-meta'],
  unknown: ['mihomo', 'clash', 'shadowrocket'],
}

export function prefersClientImport(device: ImportDevice, client: string): boolean {
  return preferredClients[device].includes(client)
}
