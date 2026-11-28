import { describe, expect, it } from 'vitest'
import {
  PLATFORM_RENDERER_OPTIONS,
  addPlatform,
  buildPlatformPayload,
  hasPlatformErrors,
  movePlatform,
  removePlatform,
  rendererLabel,
  updatePlatform,
  validatePlatformDraft,
  type PlatformDraft,
  type PlatformSetting,
} from '../../../src/features/system/platform-settings'

const platforms: PlatformSetting[] = [
  { platform: 'auto', displayName: '自动识别', enabled: true, sortOrder: 0, renderer: 'auto' },
  { platform: 'mihomo', displayName: 'Mihomo', enabled: true, sortOrder: 10, renderer: 'mihomo' },
  { platform: 'singbox', displayName: 'sing-box', enabled: true, sortOrder: 20, renderer: 'singbox' },
]

function draft(overrides: Partial<PlatformDraft> = {}): PlatformDraft {
  return { platform: 'custom', displayName: '自定义', enabled: true, renderer: 'mihomo', ...overrides }
}

describe('platform key validation', () => {
  it('accepts url-safe lowercase slugs', () => {
    for (const key of ['a', 'clash-meta', 'ios17', 'a1-b2-c3']) {
      const errors = validatePlatformDraft(draft({ platform: key }), platforms)
      expect(errors.platform).toBeUndefined()
    }
  })

  it('rejects uppercase, spaces, underscores and slashes', () => {
    for (const key of ['Mihomo', 'clash meta', 'clash_meta', 'clash/meta', '中文']) {
      const errors = validatePlatformDraft(draft({ platform: key }), platforms)
      expect(errors.platform).toBe('只能使用小写字母、数字与连字符')
    }
  })

  it('rejects empty and overlong keys', () => {
    expect(validatePlatformDraft(draft({ platform: '   ' }), platforms).platform).toBe('请输入平台键')
    expect(validatePlatformDraft(draft({ platform: 'a'.repeat(65) }), platforms).platform).toBe('平台键最多 64 个字符')
  })

  it('rejects an existing key but allows keeping the edited key', () => {
    expect(validatePlatformDraft(draft({ platform: 'mihomo' }), platforms).platform).toBe('平台键已存在')
    expect(validatePlatformDraft(draft({ platform: 'mihomo' }), platforms, 'mihomo').platform).toBeUndefined()
    expect(validatePlatformDraft(draft({ platform: 'auto' }) , platforms).platform).toBe('平台键已存在')
  })

  it('trims the key before comparing duplicates', () => {
    expect(validatePlatformDraft(draft({ platform: ' mihomo ' }), platforms).platform).toBe('平台键已存在')
  })
})

describe('platform display name and renderer validation', () => {
  it('requires a non-empty display name within the length limit', () => {
    expect(validatePlatformDraft(draft({ displayName: '  ' }), platforms).displayName).toBe('请输入显示名')
    expect(validatePlatformDraft(draft({ displayName: '名'.repeat(65) }), platforms).displayName).toBe('显示名最多 64 个字符')
    expect(validatePlatformDraft(draft({ displayName: '名'.repeat(64) }), platforms).displayName).toBeUndefined()
  })

  it('offers exactly the nine supported renderers', () => {
    expect(PLATFORM_RENDERER_OPTIONS.map((option) => option.value)).toEqual([
      'mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic',
    ])
    expect(PLATFORM_RENDERER_OPTIONS.some((option) => option.value === 'auto')).toBe(false)
    expect(rendererLabel('generic')).toBe('通用')
    expect(rendererLabel('auto')).toBe('自动识别')
  })

  it('rejects an unknown or auto renderer for a normal platform', () => {
    expect(validatePlatformDraft(draft({ renderer: '' }), platforms).renderer).toBe('请选择渲染器')
    expect(validatePlatformDraft(draft({ renderer: 'auto' }), platforms).renderer).toBe('请选择渲染器')
    expect(validatePlatformDraft(draft({ renderer: 'unknown' }), platforms).renderer).toBe('请选择渲染器')
    expect(validatePlatformDraft(draft({ renderer: 'generic' }), platforms).renderer).toBeUndefined()
  })

  it('locks the auto platform to the auto renderer', () => {
    const auto = draft({ platform: 'auto', displayName: '自动识别', renderer: 'auto' })
    expect(validatePlatformDraft(auto, platforms, 'auto').renderer).toBeUndefined()
    expect(validatePlatformDraft({ ...auto, renderer: 'mihomo' }, platforms, 'auto').renderer)
      .toBe('自动识别的渲染器固定为自动识别')
  })

  it('reports whether any field failed', () => {
    expect(hasPlatformErrors({})).toBe(false)
    expect(hasPlatformErrors({ platform: 'x' })).toBe(true)
  })
})

describe('full-replace payload', () => {
  it('sends all five fields renumbered by display order', () => {
    const payload = buildPlatformPayload([
      { platform: 'singbox', displayName: 'sing-box', enabled: false, sortOrder: 70, renderer: 'singbox' },
      { platform: 'auto', displayName: '自动识别', enabled: true, sortOrder: 5, renderer: 'auto' },
      { platform: 'custom', displayName: '自定义', enabled: true, sortOrder: 99, renderer: 'generic' },
    ])
    expect(payload).toEqual({
      platforms: [
        { platform: 'singbox', displayName: 'sing-box', enabled: false, sortOrder: 0, renderer: 'singbox' },
        { platform: 'auto', displayName: '自动识别', enabled: true, sortOrder: 10, renderer: 'auto' },
        { platform: 'custom', displayName: '自定义', enabled: true, sortOrder: 20, renderer: 'generic' },
      ],
    })
  })

  it('forces the auto renderer and never emits a missing field', () => {
    const payload = buildPlatformPayload([
      { platform: 'auto', displayName: '自动识别', enabled: true, sortOrder: 0, renderer: 'mihomo' },
    ])
    expect(payload.platforms[0]).toHaveProperty('platform')
    expect(payload.platforms[0]).toHaveProperty('displayName')
    expect(payload.platforms[0]).toHaveProperty('enabled')
    expect(payload.platforms[0]).toHaveProperty('sortOrder')
    expect(payload.platforms[0].renderer).toBe('auto')
  })
})

describe('platform list operations', () => {
  it('moves an entry without mutating the source list', () => {
    const moved = movePlatform(platforms, 1, 1)
    expect(moved.map((entry) => entry.platform)).toEqual(['auto', 'singbox', 'mihomo'])
    expect(platforms.map((entry) => entry.platform)).toEqual(['auto', 'mihomo', 'singbox'])
    expect(movePlatform(platforms, 0, -1).map((entry) => entry.platform)).toEqual(['auto', 'mihomo', 'singbox'])
  })

  it('adds, renames and removes an entry', () => {
    const added = addPlatform(platforms, draft({ platform: 'ios', displayName: 'iOS', renderer: 'shadowrocket' }))
    expect(added.map((entry) => entry.platform)).toEqual(['auto', 'mihomo', 'singbox', 'ios'])
    expect(added.at(-1)?.sortOrder).toBe(30)

    const renamed = updatePlatform(added, 'ios', draft({ platform: 'ios-app', displayName: 'iOS 客户端', renderer: 'surge' }))
    expect(renamed.map((entry) => entry.platform)).toEqual(['auto', 'mihomo', 'singbox', 'ios-app'])
    expect(renamed.at(-1)).toMatchObject({ displayName: 'iOS 客户端', renderer: 'surge' })

    const removed = removePlatform(renamed, 'mihomo')
    expect(removed.map((entry) => entry.platform)).toEqual(['auto', 'singbox', 'ios-app'])
  })

  it('normalizes a draft into the stored shape', () => {
    const added = addPlatform([], draft({ platform: '  auto  ', displayName: ' 自动识别 ', renderer: 'mihomo' }))
    expect(added[0]).toMatchObject({ platform: 'auto', displayName: '自动识别', renderer: 'auto', enabled: true })
  })
})
