import { describe, expect, it } from 'vitest'
import { fingerprintNode } from '../../../worker/import/fingerprint'
import type { ParsedNode } from '../../../worker/import/model'

const baseNode = (): ParsedNode => ({
  protocol: 'vless',
  displayName: 'Demo',
  server: 'Example.COM',
  port: 443,
  credentials: { uuid: '22222222-2222-4222-8222-222222222222' },
  tls: { server_name: 'TLS.Example.COM', alpn: ['h2', 'http/1.1'] },
  transport: { type: 'ws', path: '/vless', headers: { Host: 'CDN.Example.COM' } },
  plugin: { mode: 'http' },
  extensions: { z: 'last', a: 'first' },
  raw: 'vless://raw-format',
  format: 'uri-list',
})

describe('catalog node fingerprints', () => {
  it('ignores display name, source, raw text, enabled state, and order', async () => {
    const original = baseNode()
    const changed = {
      ...original,
      displayName: 'A different label',
      raw: 'a different raw line',
      format: 'mihomo' as const,
      sourceIds: ['src_9'],
      enabled: false,
      order: 99,
    }
    await expect(fingerprintNode(changed)).resolves.toBe(await fingerprintNode(original))
  })

  it('normalizes domain case and object key order', async () => {
    const reordered = baseNode()
    reordered.server = 'example.com'
    reordered.tls = { alpn: ['h2', 'http/1.1'], server_name: 'tls.example.com' }
    reordered.transport = { headers: { Host: 'cdn.example.com' }, path: '/vless', type: 'ws' }
    reordered.extensions = { a: 'first', z: 'last' }
    await expect(fingerprintNode(reordered)).resolves.toBe(await fingerprintNode(baseNode()))
  })

  it('changes when authentication, TLS, transport, or plugin data changes', async () => {
    const fields = ['credentials', 'tls', 'transport', 'plugin'] as const
    for (const field of fields) {
      const changed = baseNode()
      changed[field] = { changed: 'value' }
      await expect(fingerprintNode(changed)).resolves.not.toBe(await fingerprintNode(baseNode()))
    }
  })

  it('preserves array order where protocol preference order is meaningful', async () => {
    const changed = baseNode()
    changed.tls = { server_name: 'tls.example.com', alpn: ['http/1.1', 'h2'] }
    await expect(fingerprintNode(changed)).resolves.not.toBe(await fingerprintNode(baseNode()))
  })
})
