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
  return schemes[client] ? schemes[client] + encoded : null
}
