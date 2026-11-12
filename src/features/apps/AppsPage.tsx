import { Apple, AppWindow, Download, ExternalLink, Globe, Laptop, Smartphone, Store, Terminal, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiClientError, type AdminSubscription } from '../../app/api'
import { EditDrawer } from '../../ui/EditDrawer'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { InlineMessage } from '../../ui/InlineMessage'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge, type StatusBadgeTone } from '../../ui/StatusBadge'

type PlatformName = 'android' | 'ios' | 'windows' | 'macos' | 'linux'
type PlatformFilter = 'all' | PlatformName

type PublicPlatform = {
  id: string
  platform: PlatformName
  version: string
  downloadUrl: string
  downloadType: string
  fileSizeKb: number | null
  officialStoreUrl: string
  officialDownloadUrl: string
  updateNotes: string
  importSupported: boolean
  importProtocol: string
  importUrlTemplate: string
  importInstructions: string
}

type PublicApp = {
  id: string
  name: string
  icon: string
  summary: string
  description: string
  category: string
  officialWebsite: string
  developer: string | null
  flags: {
    isRecommended: boolean
    isOfficial: boolean
    isPopular: boolean
  }
  platforms: PublicPlatform[]
}

type UserSubscription = Pick<AdminSubscription, 'id' | 'name' | 'enabled' | 'defaultClient' | 'links'>

type SubState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error', message: string }
  | { status: 'ready', items: UserSubscription[] }

const PLATFORM_OPTIONS: Array<{ value: PlatformFilter, label: string, icon?: LucideIcon }> = [
  { value: 'all', label: '全部' },
  { value: 'android', label: 'Android', icon: Smartphone },
  { value: 'ios', label: 'iOS', icon: Apple },
  { value: 'windows', label: 'Windows', icon: AppWindow },
  { value: 'macos', label: 'macOS', icon: Laptop },
  { value: 'linux', label: 'Linux', icon: Terminal },
]

const PLATFORM_ICON: Record<PlatformName, LucideIcon> = {
  android: Smartphone,
  ios: Apple,
  windows: AppWindow,
  macos: Laptop,
  linux: Terminal,
}

function text(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function httpUrl(value: string | null | undefined): string | null {
  const trimmed = text(value)
  if (!/^https?:\/\//i.test(trimmed) || trimmed.length > 2048 || /[\s\\]/u.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname.length === 0) return null
    return trimmed
  } catch {
    return null
  }
}

function platformLabel(platform: PlatformName): string {
  return PLATFORM_OPTIONS.find((item) => item.value === platform)?.label ?? platform
}

function formatSize(kb: number | null | undefined): string | null {
  if (kb === null || kb === undefined || !Number.isFinite(kb) || kb < 0) return null
  if (kb < 1024) return `${kb} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${trimNumber(mb)} MB`
  return `${trimNumber(mb / 1024)} GB`
}

function trimNumber(value: number): string {
  const rounded = value.toFixed(1)
  return rounded.endsWith('.0') ? rounded.slice(0, -2) : rounded
}

function matchesQuery(app: PublicApp, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('zh-CN')
  if (!needle) return true
  const haystack = [app.name, app.summary, app.description, app.category, app.developer ?? ''].join('\n').toLocaleLowerCase('zh-CN')
  return haystack.includes(needle)
}

function primaryPlatform(app: PublicApp, filter: PlatformFilter): PublicPlatform | null {
  if (filter !== 'all') return app.platforms.find((item) => item.platform === filter) ?? null
  return app.platforms[0] ?? null
}

/** One-click import only when the administrator turned it on and left a {url} template. */
function canImport(platform: PublicPlatform): boolean {
  return platform.importSupported && platform.importUrlTemplate.includes('{url}')
}

/**
 * `{url}` is encoded when it sits inside a larger template, so the subscription
 * link survives query strings. A template that is only `{url}` stays the raw link.
 * The scheme comes from that result, never from the app name.
 */
function buildImportUrl(template: string, subscriptionUrl: string): string | null {
  const link = httpUrl(subscriptionUrl)
  const raw = template.trim()
  if (!link || !raw.includes('{url}')) return null
  const next = raw === '{url}' ? link : raw.replaceAll('{url}', encodeURIComponent(link)).trim()
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(next)?.[1]?.toLowerCase()
  if (!scheme || scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript') return null
  return next
}

function subscriptionUrl(subscription: UserSubscription): string {
  return httpUrl(subscription.links.auto) ?? httpUrl(subscription.links[subscription.defaultClient]) ?? ''
}

function subscriptionCaption(subscription: UserSubscription): string {
  return subscription.enabled ? `将导入「${subscription.name}」` : `将导入「${subscription.name}」（已停用）`
}

function AppMark({ name, icon }: { name: string, icon: string }) {
  const source = httpUrl(icon)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [source])
  const initial = Array.from(text(name))[0] ?? '应'
  return (
    <span className="appu-mark" aria-hidden="true">
      {source && !failed ? <img src={source} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <span>{initial}</span>}
    </span>
  )
}

function BadgeRow({ flags }: { flags: PublicApp['flags'] }) {
  const items: Array<{ label: string, tone: StatusBadgeTone }> = []
  if (flags.isRecommended) items.push({ label: '推荐', tone: 'warning' })
  if (flags.isOfficial) items.push({ label: '官方', tone: 'success' })
  if (flags.isPopular) items.push({ label: '热门', tone: 'danger' })
  if (!items.length) return null
  return (
    <span className="appu-badges">
      {items.map((item) => <StatusBadge key={item.label} tone={item.tone} size="xs">{item.label}</StatusBadge>)}
    </span>
  )
}

function PlatformIcons({ platforms }: { platforms: PublicPlatform[] }) {
  if (!platforms.length) return null
  const names = platforms.map((item) => platformLabel(item.platform)).join('、')
  return (
    <span className="appu-platforms-inline">
      <span className="sr-only">{`支持平台 ${names}`}</span>
      {platforms.map((item) => {
        const Icon = PLATFORM_ICON[item.platform]
        return <Icon key={item.id} aria-hidden="true" size={15} />
      })}
    </span>
  )
}

function ExternalAnchor({ href, label, ariaLabel, tone, icon: Icon }: {
  href: string
  label: string
  ariaLabel?: string
  tone: 'primary' | 'secondary'
  icon?: LucideIcon
}) {
  return (
    <a className={`button ${tone}`} href={href} target="_blank" rel="noopener noreferrer" aria-label={ariaLabel ?? `${label}（新窗口）`}>
      {Icon ? <Icon aria-hidden="true" size={16} /> : null}
      {label}
      <ExternalLink aria-hidden="true" size={14} />
    </a>
  )
}

function AppCard({ app, primary, onOpen }: {
  app: PublicApp
  primary: PublicPlatform | null
  onOpen: (app: PublicApp, focus: HTMLElement) => void
}) {
  const downloadUrl = primary ? httpUrl(primary.downloadUrl) : null
  const platformName = primary ? platformLabel(primary.platform) : ''
  return (
    <article className="appu-card">
      <button type="button" className="appu-card-open" aria-haspopup="dialog" onClick={(event) => onOpen(app, event.currentTarget)}>
        <span className="appu-card-head">
          <AppMark name={app.name} icon={app.icon} />
          <span className="appu-card-id">
            <span className="appu-name">{app.name}</span>
          </span>
        </span>
        {text(app.summary) ? <span className="appu-summary">{app.summary}</span> : null}
        <BadgeRow flags={app.flags} />
        <PlatformIcons platforms={app.platforms} />
      </button>
      {downloadUrl ? (
        <div className="appu-actions">
          <ExternalAnchor href={downloadUrl} label={`下载 ${platformName}`} ariaLabel={`下载 ${app.name} ${platformName}（新窗口）`} tone="primary" icon={Download} />
        </div>
      ) : <p className="appu-note">暂无可下载的平台</p>}
    </article>
  )
}

function AppSection({ id, title, children }: { id: string, title: string, children: ReactNode }) {
  return (
    <section className="appu-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <div className="appu-grid">{children}</div>
    </section>
  )
}

function ImportSetup({ subs, selectedId, onSelect, onRetry }: {
  subs: SubState
  selectedId: string
  onSelect: (id: string) => void
  onRetry: () => void
}) {
  if (subs.status === 'idle' || subs.status === 'loading') return <LoadingState label="正在读取订阅" />
  if (subs.status === 'error') return <ErrorState message={subs.message} onRetry={onRetry} />
  if (subs.items.length === 0) return <InlineMessage tone="warning">还没有可用订阅，暂时不能一键导入</InlineMessage>
  if (subs.items.length === 1) {
    const only = subs.items[0]
    return only ? <p className="appu-note">{subscriptionCaption(only)}</p> : null
  }
  return (
    <label className="appu-field" htmlFor="appu-subscription">
      <span>选择要导入的订阅</span>
      <select id="appu-subscription" value={selectedId} onChange={(event) => onSelect(event.currentTarget.value)}>
        {subs.items.map((item) => <option key={item.id} value={item.id}>{item.enabled ? item.name : `${item.name}（已停用）`}</option>)}
      </select>
    </label>
  )
}

function PlatformRow({ platform, subscription }: { platform: PublicPlatform, subscription: UserSubscription | null }) {
  const Icon = PLATFORM_ICON[platform.platform]
  const label = platformLabel(platform.platform)
  const downloadUrl = httpUrl(platform.downloadUrl)
  const storeUrl = httpUrl(platform.officialStoreUrl)
  const officialDownload = httpUrl(platform.officialDownloadUrl)
  const distinctOfficial = officialDownload && officialDownload !== downloadUrl ? officialDownload : null
  const size = formatSize(platform.fileSizeKb)
  const downloadType = text(platform.downloadType)
  const notes = text(platform.updateNotes)
  const instructions = text(platform.importInstructions)
  const protocol = text(platform.importProtocol)
  const importUrl = canImport(platform) && subscription ? buildImportUrl(platform.importUrlTemplate, subscriptionUrl(subscription)) : null
  const openImport = () => {
    if (!importUrl) return
    window.open(importUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <li className="appu-platform">
      <div className="appu-platform-head">
        <Icon aria-hidden="true" size={16} />
        <strong>{label}</strong>
        <span className="appu-meta">{platform.version}</span>
        {size ? <span className="appu-meta">{size}</span> : null}
        {downloadType ? <span className="appu-meta">{downloadType}</span> : null}
      </div>
      {notes ? <div className="appu-block"><p className="appu-kicker">更新说明</p><p className="appu-copy">{notes}</p></div> : null}
      <div className="appu-actions">
        {downloadUrl ? <ExternalAnchor href={downloadUrl} label="下载" ariaLabel={`下载 ${label}（新窗口）`} tone="primary" icon={Download} /> : <InlineMessage tone="warning">下载链接不可用</InlineMessage>}
        {storeUrl ? <ExternalAnchor href={storeUrl} label="官方商店" ariaLabel={`${label} 官方商店（新窗口）`} tone="secondary" icon={Store} /> : null}
        {distinctOfficial ? <ExternalAnchor href={distinctOfficial} label="官方下载" ariaLabel={`${label} 官方下载（新窗口）`} tone="secondary" /> : null}
        {importUrl ? <button className="button secondary" type="button" aria-label={`一键导入 ${label}`} onClick={openImport}>一键导入</button> : null}
      </div>
      {importUrl && protocol ? <p className="appu-note">{`导入协议：${protocol}`}</p> : null}
      {instructions ? <div className="appu-block"><p className="appu-kicker">导入说明</p><p className="appu-copy">{instructions}</p></div> : null}
    </li>
  )
}

function AppDetail({ app, subs, selectedId, onSelect, onRetry }: {
  app: PublicApp
  subs: SubState
  selectedId: string
  onSelect: (id: string) => void
  onRetry: () => void
}) {
  const website = httpUrl(app.officialWebsite)
  const description = text(app.description)
  const summary = text(app.summary)
  const developer = text(app.developer)
  const showSummary = summary && summary !== description
  const importable = app.platforms.some(canImport)
  const chosen = useMemo(() => {
    if (subs.status !== 'ready') return null
    if (subs.items.length === 1) return subs.items[0] ?? null
    return subs.items.find((item) => item.id === selectedId) ?? null
  }, [selectedId, subs])
  const missingLink = subs.status === 'ready' && subs.items.length > 0 && !(chosen && subscriptionUrl(chosen))

  return (
    <div className="appu-detail">
      <div className="appu-detail-head">
        <AppMark name={app.name} icon={app.icon} />
        <div className="appu-detail-id">
          {developer ? <span className="appu-meta">{`开发者 ${developer}`}</span> : null}
          {text(app.category) ? <span className="appu-meta">{app.category}</span> : null}
          <BadgeRow flags={app.flags} />
        </div>
      </div>
      {showSummary ? <p className="appu-lead">{summary}</p> : null}
      {website ? <div className="appu-actions"><ExternalAnchor href={website} label="官网" tone="secondary" icon={Globe} /></div> : null}
      {description ? <section className="appu-block" aria-labelledby="appu-description"><h3 id="appu-description">详细介绍</h3><p className="appu-copy">{description}</p></section> : null}
      <section className="appu-block" aria-labelledby="appu-platforms">
        <h3 id="appu-platforms">各平台下载</h3>
        {importable ? (
          <div className="appu-import">
            <ImportSetup subs={subs} selectedId={selectedId} onSelect={onSelect} onRetry={onRetry} />
            {missingLink ? <InlineMessage tone="warning">这条订阅没有可用链接</InlineMessage> : null}
          </div>
        ) : null}
        {app.platforms.length === 0 ? <EmptyState title="还没有可下载的平台" description="管理员发布平台后会出现在这里" /> : (
          <ul className="appu-platform-list">
            {app.platforms.map((platform) => <PlatformRow key={platform.id} platform={platform} subscription={chosen} />)}
          </ul>
        )}
      </section>
    </div>
  )
}

export function AppsPage() {
  const [apps, setApps] = useState<PublicApp[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [platform, setPlatform] = useState<PlatformFilter>('all')
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [subs, setSubs] = useState<SubState>({ status: 'idle' })
  const [selectedSubId, setSelectedSubId] = useState('')
  const returnFocus = useRef<HTMLElement | null>(null)
  const subsLock = useRef(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setLoadError('')
      try {
        const result = await api<{ apps: PublicApp[] }>('/api/apps')
        if (cancelled) return
        if (!Array.isArray(result.apps)) {
          setLoadError('应用列表加载失败')
          return
        }
        setApps(result.apps)
      } catch (cause) {
        if (!cancelled) setLoadError(errorMessage(cause, '应用列表加载失败'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => { cancelled = true }
  }, [reloadKey])

  const loadSubs = useCallback(async () => {
    if (subsLock.current) return
    subsLock.current = true
    setSubs({ status: 'loading' })
    try {
      const result = await api<{ subscriptions: UserSubscription[] }>('/api/account/subscriptions')
      if (!Array.isArray(result.subscriptions)) {
        setSubs({ status: 'error', message: '订阅列表加载失败' })
        return
      }
      const items = result.subscriptions
      setSubs({ status: 'ready', items })
      setSelectedSubId((current) => items.some((item) => item.id === current) ? current : items[0]?.id ?? '')
    } catch (cause) {
      setSubs({ status: 'error', message: errorMessage(cause, '订阅列表加载失败') })
    } finally {
      subsLock.current = false
    }
  }, [])

  const categories = useMemo(() => {
    const values = new Set<string>()
    for (const app of apps ?? []) {
      const name = text(app.category)
      if (name) values.add(name)
    }
    return [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  }, [apps])
  const activeCategory = category === 'all' || categories.includes(category) ? category : 'all'
  const filtered = useMemo(() => (apps ?? []).filter((app) => {
    if (platform !== 'all' && !app.platforms.some((item) => item.platform === platform)) return false
    if (activeCategory !== 'all' && text(app.category) !== activeCategory) return false
    return matchesQuery(app, query)
  }), [activeCategory, apps, platform, query])
  const recommended = filtered.filter((app) => app.flags.isRecommended)
  const rest = filtered.filter((app) => !app.flags.isRecommended)
  const detail = useMemo(() => apps?.find((app) => app.id === detailId) ?? null, [apps, detailId])

  useEffect(() => {
    if (detailId && apps && !apps.some((app) => app.id === detailId)) setDetailId(null)
  }, [apps, detailId])

  useEffect(() => {
    if (!detail?.platforms.some(canImport) || subs.status !== 'idle') return
    void loadSubs()
  }, [detail, loadSubs, subs.status])

  const openDetail = (app: PublicApp, focus: HTMLElement) => {
    returnFocus.current = focus
    setDetailId(app.id)
  }

  return (
    <div className="page-stack appu-page">
      <PageHeader title="APP 下载" description="按平台浏览客户端，或把订阅导入到支持的应用" />
      {loading && apps === null ? <LoadingState label="正在加载应用" /> : null}
      {!loading && loadError && apps === null ? <ErrorState message={loadError} onRetry={() => setReloadKey((current) => current + 1)} /> : null}
      {apps !== null && apps.length === 0 ? <EmptyState icon={Download} title="还没有可下载的应用" description="管理员发布后会出现在这里" /> : null}
      {apps !== null && apps.length > 0 ? (
        <>
          <FilterBar className="appu-filters">
            <div className="appu-chip-group" role="group" aria-labelledby="appu-platform-label">
              <span id="appu-platform-label" className="appu-chip-label">平台</span>
              {PLATFORM_OPTIONS.map((item) => {
                const Icon = item.icon
                return (
                  <FilterChip key={item.value} active={platform === item.value} onClick={() => setPlatform(item.value)}>
                    {Icon ? <Icon aria-hidden="true" size={14} /> : null}
                    {item.label}
                  </FilterChip>
                )
              })}
            </div>
            <SearchInput className="appu-search" value={query} onChange={setQuery} label="搜索应用" placeholder="搜索应用" />
            <div className="appu-chip-group" role="group" aria-labelledby="appu-category-label">
              <span id="appu-category-label" className="appu-chip-label">分类</span>
              <FilterChip active={activeCategory === 'all'} onClick={() => setCategory('all')}>全部</FilterChip>
              {categories.map((item) => <FilterChip key={item} active={activeCategory === item} onClick={() => setCategory(item)}>{item}</FilterChip>)}
            </div>
          </FilterBar>
          {recommended.length === 0 && rest.length === 0 ? <EmptyState icon={Download} title="没有符合条件的应用" description="换个平台、分类或关键词再试" /> : (
            <div className="appu-results">
              {recommended.length > 0 ? (
                <AppSection id="appu-recommended" title="推荐">
                  {recommended.map((app) => <AppCard key={app.id} app={app} primary={primaryPlatform(app, platform)} onOpen={openDetail} />)}
                </AppSection>
              ) : null}
              {rest.length > 0 ? (
                <AppSection id="appu-all" title="全部应用">
                  {rest.map((app) => <AppCard key={app.id} app={app} primary={primaryPlatform(app, platform)} onOpen={openDetail} />)}
                </AppSection>
              ) : null}
            </div>
          )}
        </>
      ) : null}
      <EditDrawer open={detail !== null} title={detail?.name ?? '应用详情'} onClose={() => setDetailId(null)} returnFocusRef={returnFocus} size="large">
        {detail ? <AppDetail app={detail} subs={subs} selectedId={selectedSubId} onSelect={setSelectedSubId} onRetry={() => { void loadSubs() }} /> : null}
      </EditDrawer>
    </div>
  )
}
