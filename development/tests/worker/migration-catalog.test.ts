import { describe, it, expect, beforeAll } from 'vitest'
import { convertCatalog } from '../../../worker/migration/catalog'
import { applyMigrations, emptyDatabase } from '../worker/d1.js'
import { env } from 'cloudflare:workers'

describe('catalog converter', () => {
  let db: D1Database

  beforeAll(async () => {
    db = env.DB
    await applyMigrations(db)
  })

  // Fixture: a valid catalog snapshot with sources, nodes, groups
  const validSnapshot = {
    schemaVersion: 2,
    revision: 1,
    updatedAt: '2024-01-15T10:00:00.000Z',
    nextSourceId: 4,
    nextNodeId: 3,
    nextGroupId: 2,
    sources: [
      {
        id: 'src_1',
        name: 'Remote Source',
        type: 'remote',
        enabled: true,
        encryptedUrl: { version: 1, algorithm: 'AES-GCM', iv: 'Hz5dfJu62fgXNlV0', ciphertext: 'KUhnhqXE4wIhQF9-nbzb-hk4V3aVtNPy' },
        encryptedHeaders: { version: 1, algorithm: 'AES-GCM', iv: 'ID9efZy72vkYN1Z1', ciphertext: 'Kkloh6bF5AMiQWB_nr3c-xo5WHeWtdTz' },
        refreshIntervalMinutes: 60,
        detectedFormat: 'mihomo',
        warnings: [],
        lastAttemptAt: '2024-01-15T09:00:00.000Z',
        lastSuccessAt: '2024-01-15T09:05:00.000Z',
        createdAt: '2024-01-10T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
      {
        id: 'src_2',
        name: 'Manual Source',
        type: 'manual',
        enabled: true,
        encryptedContent: { version: 1, algorithm: 'AES-GCM', iv: 'IUBffp282_oZOFd2', ciphertext: 'K0ppiKfG5QQjQmGAn77d_Bs6WXiXttX0' },
        warnings: [{ code: 'WARN_1', message: 'Some warning', line: 5 }],
        createdAt: '2024-01-11T10:00:00.000Z',
        updatedAt: '2024-01-11T10:00:00.000Z',
      },
      {
        id: 'src_3',
        name: 'File Source',
        type: 'file',
        enabled: false,
        encryptedContent: { version: 1, algorithm: 'AES-GCM', iv: 'IkFgf5693PsaOVh3', ciphertext: 'LEtqiajH5gUkQ2KBoL_e_Rw7WnmYt9b1' },
        detectedFormat: 'sing-box',
        warnings: [],
        createdAt: '2024-01-12T10:00:00.000Z',
        updatedAt: '2024-01-12T10:00:00.000Z',
      },
    ],
    nodes: [
      {
        id: 'node_1',
        protocol: 'vmess',
        displayName: 'Node 1',
        server: 'example.com',
        port: 443,
        credentials: { uuid: 'test-uuid', alterId: 0 },
        tls: { enabled: true, serverName: 'example.com' },
        transport: { type: 'ws', path: '/ws' },
        extensions: {},
        fingerprint: 'fp_node_1_unique',
        sourceIds: ['src_1', 'src_2'],
        rawVariants: [
          { sourceId: 'src_1', format: 'mihomo', raw: 'vmess://...', extensions: {} },
          { sourceId: 'src_2', format: 'uri-list', raw: 'vmess://...', extensions: {} },
        ],
        enabled: true,
        retained: false,
        order: 0,
        createdAt: '2024-01-13T10:00:00.000Z',
        updatedAt: '2024-01-13T10:00:00.000Z',
      },
      {
        id: 'node_2',
        protocol: 'trojan',
        displayName: 'Node 2',
        server: 'trojan.example.com',
        port: 443,
        credentials: { password: 'trojan-pass' },
        tls: { enabled: true },
        extensions: {},
        fingerprint: 'fp_node_2_unique',
        sourceIds: ['src_3'],
        rawVariants: [
          { sourceId: 'src_3', format: 'sing-box', raw: 'trojan://...', extensions: {} },
        ],
        enabled: true,
        retained: true,
        order: 1,
        createdAt: '2024-01-14T10:00:00.000Z',
        updatedAt: '2024-01-14T10:00:00.000Z',
      },
    ],
    groups: [
      {
        id: 'grp_1',
        name: 'Group A',
        sourceIds: ['src_1', 'src_3'],
        includedNodeIds: ['node_1'],
        excludedNodeIds: ['node_2'],
        nodeOrder: ['node_1', 'node_2'],
        createdAt: '2024-01-15T10:00:00.000Z',
        updatedAt: '2024-01-15T10:00:00.000Z',
      },
    ],
  }

  it('converts valid snapshot without anomalies', () => {
    const result = convertCatalog(validSnapshot)

    expect(result.report.anomalies).toHaveLength(0)
    expect(result.report.skipped).toBe(0)
    expect(result.rows.sources).toHaveLength(3)
    expect(result.rows.nodes).toHaveLength(2)
    expect(result.rows.node_raw_variants).toHaveLength(3)
    expect(result.rows.groups).toHaveLength(1)
    expect(result.rows.group_sources).toHaveLength(2)
    expect(result.rows.group_nodes).toHaveLength(2)
    expect(result.rows.group_node_order).toHaveLength(2)

    // Check source conversion
    const remoteSource = result.rows.sources.find(s => s.id === 'src_1')
    expect(remoteSource).toBeDefined()
    expect(remoteSource!.type).toBe('remote')
    expect(remoteSource!.enabled).toBe(1)
    expect(remoteSource!.encrypted_url).not.toBeNull()
    expect(remoteSource!.encrypted_headers).not.toBeNull()
    expect(remoteSource!.refresh_interval_minutes).toBe(60)

    const manualSource = result.rows.sources.find(s => s.id === 'src_2')
    expect(manualSource).toBeDefined()
    expect(manualSource!.type).toBe('manual')
    expect(manualSource!.encrypted_url).toBeNull()
    expect(manualSource!.encrypted_headers).toBeNull()
    expect(manualSource!.refresh_interval_minutes).toBeNull()

    // Check node conversion
    const node1 = result.rows.nodes.find(n => n.id === 'node_1')
    expect(node1).toBeDefined()
    expect(node1!.protocol).toBe('vmess')
    expect(node1!.source_ids).toBe('["src_1","src_2"]')
    expect(node1!.fingerprint).toBe('fp_node_1_unique')

    // Check raw variants
    const variants = result.rows.node_raw_variants.filter(v => v.node_id === 'node_1')
    expect(variants).toHaveLength(2)
    expect(variants.map(v => v.source_id).sort()).toEqual(['src_1', 'src_2'])

    // Check group conversion
    const group = result.rows.groups[0]
    expect(group.id).toBe('grp_1')
    expect(group.name).toBe('Group A')

    const groupSources = result.rows.group_sources.filter(gs => gs.group_id === 'grp_1')
    expect(groupSources).toHaveLength(2)
    expect(groupSources.map(gs => gs.source_id).sort()).toEqual(['src_1', 'src_3'])
    expect(groupSources.map(gs => gs.position)).toEqual([0, 1])

    const groupNodes = result.rows.group_nodes.filter(gn => gn.group_id === 'grp_1')
    expect(groupNodes).toHaveLength(2)
    const included = groupNodes.find(gn => gn.relation === 'included')
    const excluded = groupNodes.find(gn => gn.relation === 'excluded')
    expect(included!.node_id).toBe('node_1')
    expect(excluded!.node_id).toBe('node_2')

    const groupOrder = result.rows.group_node_order.filter(go => go.group_id === 'grp_1')
    expect(groupOrder).toHaveLength(2)
    expect(groupOrder.map(go => go.node_id)).toEqual(['node_1', 'node_2'])
    expect(groupOrder.map(go => go.position)).toEqual([0, 1])
  })

  it('reports anomalies for dangling source references in nodes', () => {
    const snapshot = {
      ...validSnapshot,
      nodes: [
        {
          ...validSnapshot.nodes[0],
          id: 'node_3',
          sourceIds: ['src_1', 'src_999'], // src_999 doesn't exist
          rawVariants: [
            { sourceId: 'src_1', format: 'mihomo', raw: 'vmess://...', extensions: {} },
          ],
        },
      ],
    }

    const result = convertCatalog(snapshot)
    expect(result.report.anomalies).toContain('Node node_3 references missing source src_999')
    expect(result.report.skipped).toBeGreaterThan(0)
  })

  it('reports anomalies for missing raw variants', () => {
    const snapshot = {
      ...validSnapshot,
      nodes: [
        {
          ...validSnapshot.nodes[0],
          id: 'node_3',
          sourceIds: ['src_1', 'src_2'],
          rawVariants: [
            { sourceId: 'src_1', format: 'mihomo', raw: 'vmess://...', extensions: {} },
            // missing raw variant for src_2
          ],
        },
      ],
    }

    const result = convertCatalog(snapshot)
    expect(result.report.anomalies).toContain('Node node_3 source src_2 missing raw variant')
  })

  it('reports anomalies for raw variants referencing unrelated sources', () => {
    const snapshot = {
      ...validSnapshot,
      nodes: [
        {
          ...validSnapshot.nodes[0],
          id: 'node_3',
          sourceIds: ['src_1'],
          rawVariants: [
            { sourceId: 'src_1', format: 'mihomo', raw: 'vmess://...', extensions: {} },
            { sourceId: 'src_999', format: 'mihomo', raw: 'vmess://...', extensions: {} }, // unrelated
          ],
        },
      ],
    }

    const result = convertCatalog(snapshot)
    expect(result.report.anomalies).toContain('Node node_3 raw variant references unrelated source src_999')
  })

  it('reports anomalies for dangling source references in groups', () => {
    const snapshot = {
      ...validSnapshot,
      groups: [
        {
          ...validSnapshot.groups[0],
          id: 'grp_2',
          sourceIds: ['src_1', 'src_999'],
        },
      ],
    }

    const result = convertCatalog(snapshot)
    expect(result.report.anomalies).toContain('Group grp_2 references missing source src_999')
  })

  it('reports anomalies for dangling node references in groups', () => {
    const snapshot = {
      ...validSnapshot,
      groups: [
        {
          ...validSnapshot.groups[0],
          id: 'grp_2',
          includedNodeIds: ['node_1', 'node_999'],
        },
      ],
    }

    const result = convertCatalog(snapshot)
    expect(result.report.anomalies).toContain('Group grp_2 references missing node node_999')
  })

  it('property test: converted rows satisfy D1 constraints', async () => {
    const result = convertCatalog(validSnapshot)

    // Insert into D1
    await emptyDatabase(db)
    await applyMigrations(db)

    for (const source of result.rows.sources) {
      await db.prepare(`
        INSERT INTO sources (id, name, type, enabled, encrypted_content, encrypted_url, encrypted_headers,
          refresh_interval_minutes, detected_format, warnings, last_attempt_at, last_success_at,
          last_error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        source.id, source.name, source.type, source.enabled,
        source.encrypted_content, source.encrypted_url, source.encrypted_headers,
        source.refresh_interval_minutes, source.detected_format, source.warnings,
        source.last_attempt_at, source.last_success_at, source.last_error_code,
        source.created_at, source.updated_at
      ).run()
    }

    for (const node of result.rows.nodes) {
      await db.prepare(`
        INSERT INTO nodes (id, protocol, display_name, server, port, credentials, tls, transport, plugin,
          extensions, fingerprint, source_ids, enabled, retained, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        node.id, node.protocol, node.display_name, node.server, node.port,
        node.credentials, node.tls, node.transport, node.plugin,
        node.extensions, node.fingerprint, node.source_ids,
        node.enabled, node.retained, node.sort_order,
        node.created_at, node.updated_at
      ).run()
    }

    for (const variant of result.rows.node_raw_variants) {
      await db.prepare(`
        INSERT INTO node_raw_variants (node_id, source_id, format, raw, extensions)
        VALUES (?, ?, ?, ?, ?)
      `).bind(variant.node_id, variant.source_id, variant.format, variant.raw, variant.extensions).run()
    }

    for (const group of result.rows.groups) {
      await db.prepare(`
        INSERT INTO groups (id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `).bind(group.id, group.name, group.created_at, group.updated_at).run()
    }

    for (const gs of result.rows.group_sources) {
      await db.prepare(`
        INSERT INTO group_sources (group_id, source_id, position)
        VALUES (?, ?, ?)
      `).bind(gs.group_id, gs.source_id, gs.position).run()
    }

    for (const gn of result.rows.group_nodes) {
      await db.prepare(`
        INSERT INTO group_nodes (group_id, node_id, relation, position)
        VALUES (?, ?, ?, ?)
      `).bind(gn.group_id, gn.node_id, gn.relation, gn.position).run()
    }

    for (const go of result.rows.group_node_order) {
      await db.prepare(`
        INSERT INTO group_node_order (group_id, node_id, position)
        VALUES (?, ?, ?)
      `).bind(go.group_id, go.node_id, go.position).run()
    }

    // Verify counts
    const sourceCount = await db.prepare('SELECT COUNT(*) as c FROM sources').first<{ c: number }>()
    expect(sourceCount!.c).toBe(3)

    const nodeCount = await db.prepare('SELECT COUNT(*) as c FROM nodes').first<{ c: number }>()
    expect(nodeCount!.c).toBe(2)

    const variantCount = await db.prepare('SELECT COUNT(*) as c FROM node_raw_variants').first<{ c: number }>()
    expect(variantCount!.c).toBe(3)

    const groupCount = await db.prepare('SELECT COUNT(*) as c FROM groups').first<{ c: number }>()
    expect(groupCount!.c).toBe(1)

    // Verify FK constraints by checking referential integrity
    const fkCheck = await db.prepare(`
      SELECT COUNT(*) as c FROM node_raw_variants nrv
      LEFT JOIN nodes n ON nrv.node_id = n.id
      LEFT JOIN sources s ON nrv.source_id = s.id
      WHERE n.id IS NULL OR s.id IS NULL
    `).first<{ c: number }>()
    expect(fkCheck!.c).toBe(0)
  })
})