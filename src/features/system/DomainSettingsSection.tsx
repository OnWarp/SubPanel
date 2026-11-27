import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { Input } from '../../ui/Controls'
import { ArrowDown, ArrowUp, Check, CircleAlert, Clock, Minus, Plus, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import { api, peekApi, readData, ApiClientError, jsonBody } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DetailList } from '../../ui/DetailList'
import { ErrorState } from '../../ui/ErrorState'
import { FormField, FormGroup } from '../../ui/FormField'
import { InlineMessage } from '../../ui/InlineMessage'
import { Skeleton } from '../../ui/LoadingState'
import { RowActions } from '../../ui/RowActions'
import { Section } from '../../ui/Section'
import { SectionTabs } from '../../ui/SectionTabs'
import { StatusMessage } from '../../ui/StatusMessage'
import { Switch } from '../../ui/Switch'
import { OperationsFooter } from '../admin/OperationsCard'

type DomainKind = 'panel' | 'subscription'
type VerificationStatus = 'pending' | 'verified' | 'failed'
type ProbeState = 'unchecked' | 'pending' | 'ok' | 'failed'

type DomainHealth = {
  https?: unknown
  service?: unknown
  reachability?: unknown
} | null

type DomainItem = {
  id: string
  hostname: string
  purpose: DomainKind
  note: string
  enabled: boolean
  isPrimary: boolean
  verificationStatus: VerificationStatus
  health: DomainHealth
  verifiedAt: string | null
  updatedAt: string
  createdAt: string
  lastCheckAt: string | null
  lastCheckError: string | null
}

type DomainPayload = Partial<Omit<DomainItem, 'purpose' | 'verificationStatus' | 'health' | 'isPrimary'>> & {
  id?: string
  hostname?: string
  purpose?: string
  isPrimary?: boolean
  verificationStatus?: string
  health?: unknown
}

type DomainsResponse = {
  panel: DomainItem[]
  subscription: DomainItem[]
  primaryPanelDomainId: string | null
  primarySubscriptionDomainId: string | null
  restrictionEnabled: boolean
}

type PlatformItem = {
  platform: string
  displayName: string
  enabled: boolean
  sortOrder: number
}

type Challenge = { nonce: string; challengeId: string; expiresAt: string }
type DetailRequest = { kind: DomainKind; id: string; nonce: number }

const KIND_LABEL: Record<DomainKind, string> = { panel: '面板域名', subscription: '订阅域名' }
const PASSING = new Set(['ok', 'pass', 'passed', 'healthy', 'reachable', 'success', 'verified'])
const FAILING = new Set(['failed', 'fail', 'error', 'unreachable', 'unhealthy'])
const WAITING = new Set(['pending', 'checking', 'running'])

const VERIFICATION: Record<VerificationStatus | 'unknown', { label: string; icon: LucideIcon }> = {
  verified: { label: '已验证', icon: Check },
  pending: { label: '待验证', icon: Clock },
  failed: { label: '验证失败', icon: CircleAlert },
  unknown: { label: '状态未知', icon: CircleAlert },
}

const PROBE: Record<ProbeState, { label: string; icon: LucideIcon }> = {
  unchecked: { label: '未检测', icon: Minus },
  pending: { label: '检测中', icon: Clock },
  ok: { label: '正常', icon: Check },
  failed: { label: '异常', icon: CircleAlert },
}

function errorText(cause: unknown): string {
  if (cause instanceof DOMException && cause.name === 'AbortError') return ''
  if (cause instanceof ApiClientError) return cause.message
  if (cause instanceof Error && cause.message) return cause.message
  return '操作失败'
}

function formatTime(value: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function domainTabTo(kind: DomainKind, search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (kind === 'subscription') params.set('domainKind', 'subscription')
  else params.delete('domainKind')
  const next = params.toString()
  return `/system/distribution${next ? `?${next}` : ''}`
}

function verificationOf(value: string | undefined): VerificationStatus {
  return value === 'verified' || value === 'failed' || value === 'pending' ? value : 'pending'
}

/** Unknown probe payloads stay unchecked. A missing check must not look healthy. */
function readProbe(value: unknown): ProbeState {
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase()
    if (PASSING.has(key)) return 'ok'
    if (FAILING.has(key)) return 'failed'
    if (WAITING.has(key)) return 'pending'
    return 'unchecked'
  }
  if (value && typeof value === 'object') {
    const record = value as { status?: unknown; state?: unknown; ok?: unknown }
    if ('status' in record || 'state' in record) return readProbe(record.status ?? record.state)
    if (record.ok === true) return 'ok'
    if (record.ok === false) return 'failed'
  }
  return 'unchecked'
}

function probeOf(health: DomainHealth, key: 'https' | 'service'): ProbeState {
  if (!health || typeof health !== 'object') return 'unchecked'
  if (key === 'service') return readProbe(health.service ?? health.reachability)
  return readProbe(health[key])
}

function asHealth(value: unknown): DomainHealth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as DomainHealth
}

function asDomain(input: DomainPayload, kind: DomainKind, primaryId: string | null, base?: DomainItem | null): DomainItem | null {
  const id = input.id ?? base?.id
  const hostname = input.hostname ?? base?.hostname
  if (!id || !hostname) return null
  const purpose = input.purpose === 'panel' || input.purpose === 'subscription' ? input.purpose : base?.purpose ?? kind
  return {
    id,
    hostname,
    purpose,
    note: input.note ?? base?.note ?? '',
    enabled: typeof input.enabled === 'boolean' ? input.enabled : base?.enabled ?? false,
    isPrimary: id === primaryId || input.isPrimary === true,
    verificationStatus: input.verificationStatus ? verificationOf(input.verificationStatus) : base?.verificationStatus ?? 'pending',
    health: input.health === undefined ? base?.health ?? null : asHealth(input.health),
    verifiedAt: input.verifiedAt === undefined ? base?.verifiedAt ?? null : input.verifiedAt,
    updatedAt: input.updatedAt ?? base?.updatedAt ?? '',
    createdAt: input.createdAt ?? base?.createdAt ?? '',
    lastCheckAt: input.lastCheckAt === undefined ? base?.lastCheckAt ?? null : input.lastCheckAt,
    lastCheckError: input.lastCheckError === undefined ? base?.lastCheckError ?? null : input.lastCheckError,
  }
}

function normalizeList(items: DomainPayload[] | undefined, kind: DomainKind, primaryId: string | null) {
  const source = items ?? []
  const resolved = primaryId && source.some((item) => item.id === primaryId)
    ? primaryId
    : source.find((item) => item.isPrimary)?.id ?? null
  const normalized = source.flatMap((item) => {
    const domain = asDomain(item, kind, resolved)
    return domain ? [domain] : []
  })
  return { items: normalized, primaryId: resolved }
}

function normalizeResponse(data: {
  panel?: DomainPayload[]
  subscription?: DomainPayload[]
  primaryPanelDomainId?: string | null
  primarySubscriptionDomainId?: string | null
  restrictionEnabled?: boolean
}): DomainsResponse {
  const panel = normalizeList(data.panel, 'panel', data.primaryPanelDomainId ?? null)
  const subscription = normalizeList(data.subscription, 'subscription', data.primarySubscriptionDomainId ?? null)
  return {
    panel: panel.items,
    subscription: subscription.items,
    primaryPanelDomainId: panel.primaryId,
    primarySubscriptionDomainId: subscription.primaryId,
    restrictionEnabled: data.restrictionEnabled === true,
  }
}

function sortDomains(items: DomainItem[]): DomainItem[] {
  return [...items].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    const created = a.createdAt.localeCompare(b.createdAt)
    if (created !== 0) return created
    return a.id.localeCompare(b.id)
  })
}

function primaryIdOf(data: DomainsResponse, kind: DomainKind): string | null {
  return kind === 'panel' ? data.primaryPanelDomainId : data.primarySubscriptionDomainId
}

function withKind(current: DomainsResponse, kind: DomainKind, items: DomainItem[], primaryId: string | null): DomainsResponse {
  return kind === 'panel'
    ? { ...current, panel: items, primaryPanelDomainId: primaryId }
    : { ...current, subscription: items, primarySubscriptionDomainId: primaryId }
}

function replaceItem(items: DomainItem[], domain: DomainItem): DomainItem[] {
  return items.some((item) => item.id === domain.id)
    ? items.map((item) => item.id === domain.id ? domain : item)
    : [...items, domain]
}

function canBePrimary(item: DomainItem): boolean {
  return item.verificationStatus === 'verified' && item.enabled
}

function switchReason(item: DomainItem): string {
  if (item.isPrimary) return '请先切换主链接'
  if (item.verificationStatus !== 'verified' && !item.enabled) return '请先验证'
  return ''
}

function Mark({ status }: { status: VerificationStatus | 'unknown' }) {
  const view = VERIFICATION[status]
  const Icon = view.icon
  return <span className={`sys-domain-mark sys-domain-mark-${status}`}><Icon aria-hidden="true" size={14} />{view.label}</span>
}

function Probe({ status }: { status: ProbeState }) {
  const view = PROBE[status]
  const Icon = view.icon
  return <span className={`sys-domain-probe sys-domain-probe-${status}`}><Icon aria-hidden="true" size={14} />{view.label}</span>
}

async function readDomainProof(hostname: string, nonce: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`https://${hostname}/.well-known/subpanel-verify?challenge=${nonce}`, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if (response.status !== 200 || !response.body) throw new Error('无法读取该域名上的验证证明')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let json = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) {
        void reader.cancel().catch(() => undefined)
        throw new Error('域名验证响应超过 4 KiB')
      }
      json += decoder.decode(value, { stream: true })
    }
    return JSON.parse(json + decoder.decode()) as unknown
  } finally {
    reader.releaseLock()
  }
}

export function DomainSettingsSection() {
  const { search } = useLocation()
  const kind: DomainKind = new URLSearchParams(search).get('domainKind') === 'subscription' ? 'subscription' : 'panel'
  const [domains, setDomains] = useState<DomainsResponse | null>(() => {
    const cached = peekApi<Parameters<typeof normalizeResponse>[0]>('/api/admin/system/domains')
    return cached ? normalizeResponse(cached) : null
  })
  const [platforms, setPlatforms] = useState<PlatformItem[] | null>(() => peekApi<{ platforms: PlatformItem[] }>('/api/admin/system/subscription-platforms')?.platforms ?? null)
  const [loading, setLoading] = useState(() => peekApi('/api/admin/system/domains') === undefined || peekApi('/api/admin/system/subscription-platforms') === undefined)
  const [loadError, setLoadError] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [kindLock, setKindLock] = useState<DomainKind | null>(null)
  const [restrictionBusy, setRestrictionBusy] = useState(false)
  const [platformSaving, setPlatformSaving] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [noteId, setNoteId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<DomainItem | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [detail, setDetail] = useState<DetailRequest | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const verifyAbortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/system/domains') === undefined || peekApi('/api/admin/system/subscription-platforms') === undefined)
    setLoadError('')
    try {
      await readData((read) => Promise.all([
        read<Parameters<typeof normalizeResponse>[0]>('/api/admin/system/domains'),
        read<{ platforms: PlatformItem[] }>('/api/admin/system/subscription-platforms'),
      ]), ([domainData, platformData]) => {
        setDomains(normalizeResponse(domainData))
        setPlatforms(platformData.platforms)
        setLoading(false)
      })
    } catch (cause) {
      setLoadError(errorText(cause) || '无法加载域名设置')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  useLayoutEffect(() => {
    const id = pendingFocus.current
    if (!id || kindLock) return
    pendingFocus.current = null
    const node = document.getElementById(id)
    if (!(node instanceof HTMLElement) || node.matches(':disabled')) return
    node.focus({ preventScroll: true })
    node.scrollIntoView({ block: 'nearest' })
  }, [domains, kindLock])

  useEffect(() => () => verifyAbortRef.current?.abort(), [])

  const rows = domains ? sortDomains(domains[kind].map((item) => ({ ...item, isPrimary: item.id === primaryIdOf(domains, kind) }))) : []
  const active = detail && domains ? domains[detail.kind].find((item) => item.id === detail.id) ?? null : null
  const noteItem = noteId && domains ? domains[kind].find((item) => item.id === noteId) ?? null : null
  const busy = kindLock === kind

  const showDetail = (nextKind: DomainKind, id: string, refresh = false) => {
    setDetail((current) => {
      if (refresh && current?.kind === nextKind && current.id === id) return { kind: nextKind, id, nonce: current.nonce + 1 }
      if (current?.kind === nextKind && current.id === id) return current
      return { kind: nextKind, id, nonce: refresh ? 1 : 0 }
    })
  }

  const reloadDomains = async () => {
    const data = await api<Parameters<typeof normalizeResponse>[0]>('/api/admin/system/domains')
    setDomains(normalizeResponse(data))
  }

  const setPrimary = async (item: DomainItem) => {
    if (!domains || item.isPrimary || !canBePrimary(item) || busy) return
    const previousItems = domains[kind]
    const previousPrimary = primaryIdOf(domains, kind)
    pendingFocus.current = `domain-primary-${item.id}`
    setKindLock(kind)
    setFeedback(null)
    setDomains((current) => current ? withKind(current, kind, current[kind].map((entry) => ({ ...entry, isPrimary: entry.id === item.id })), item.id) : current)
    try {
      const result = await api<{ domain?: DomainPayload }>(`/api/admin/system/domains/${kind}/${item.id}/primary`, { method: 'POST', body: jsonBody({}) })
      setDomains((current) => {
        if (!current) return current
        const domain = result.domain ? asDomain(result.domain, kind, item.id, item) : null
        const next = domain ?? { ...item, isPrimary: true }
        const items = replaceItem(current[kind], { ...next, isPrimary: true }).map((entry) => ({ ...entry, isPrimary: entry.id === item.id }))
        return withKind(current, kind, items, item.id)
      })
      setFeedback({ tone: 'success', text: '主链接已更新' })
    } catch (cause) {
      setDomains((current) => current ? withKind(current, kind, previousItems, previousPrimary) : current)
      const text = errorText(cause)
      if (text) setFeedback({ tone: 'error', text })
    } finally {
      setKindLock(null)
    }
  }

  const setEnabled = async (item: DomainItem, enabled: boolean) => {
    if (!domains || busy || item.isPrimary || (item.verificationStatus !== 'verified' && !item.enabled)) return
    const previousItems = domains[kind]
    const previousPrimary = primaryIdOf(domains, kind)
    pendingFocus.current = `domain-enabled-${item.id}`
    setKindLock(kind)
    setFeedback(null)
    setDomains((current) => current ? withKind(current, kind, current[kind].map((entry) => entry.id === item.id ? { ...entry, enabled } : entry), primaryIdOf(current, kind)) : current)
    try {
      const result = await api<{ domain?: DomainPayload }>(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ enabled }) })
      setDomains((current) => {
        if (!current) return current
        const primaryId = primaryIdOf(current, kind)
        const domain = result.domain ? asDomain(result.domain, kind, primaryId, { ...item, enabled }) : null
        const next = domain ?? { ...item, enabled }
        return withKind(current, kind, replaceItem(current[kind], { ...next, isPrimary: next.id === primaryId }), primaryId)
      })
      setFeedback({ tone: 'success', text: enabled ? '域名已启用' : '域名已停用' })
    } catch (cause) {
      setDomains((current) => current ? withKind(current, kind, previousItems, previousPrimary) : current)
      const text = errorText(cause)
      if (text) setFeedback({ tone: 'error', text })
    } finally {
      setKindLock(null)
    }
  }

  const saveNote = async (item: DomainItem, note: string): Promise<string | null> => {
    setKindLock(kind)
    setFeedback(null)
    try {
      const result = await api<{ domain?: DomainPayload }>(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ note }) })
      setDomains((current) => {
        if (!current) return current
        const primaryId = primaryIdOf(current, kind)
        const domain = result.domain ? asDomain(result.domain, kind, primaryId, { ...item, note }) : null
        const next = domain ?? { ...item, note }
        return withKind(current, kind, replaceItem(current[kind], { ...next, isPrimary: next.id === primaryId }), primaryId)
      })
      setNoteId(null)
      setFeedback({ tone: 'success', text: '备注已保存' })
      return null
    } catch (cause) {
      return errorText(cause) || '保存备注失败'
    } finally {
      setKindLock(null)
    }
  }

  const removeDomain = async () => {
    if (!pendingDelete || pendingDelete.isPrimary) return
    const item = pendingDelete
    setKindLock(kind)
    setDeleteError('')
    setFeedback(null)
    try {
      await api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'DELETE' })
      setDomains((current) => {
        if (!current) return current
        const primaryId = primaryIdOf(current, kind)
        return withKind(current, kind, current[kind].filter((entry) => entry.id !== item.id), primaryId === item.id ? null : primaryId)
      })
      if (detail?.id === item.id) setDetail(null)
      setPendingDelete(null)
      setFeedback({ tone: 'success', text: '域名已删除' })
    } catch (cause) {
      const text = errorText(cause)
      if (text) setDeleteError(text)
    } finally {
      setKindLock(null)
    }
  }

  const addDomain = async (hostname: string, note: string) => {
    setFeedback(null)
    const body: { hostname: string; note?: string } = { hostname }
    if (note) body.note = note
    const result = await api<{ domain?: DomainPayload }>(`/api/admin/system/domains/${kind}`, { method: 'POST', body: jsonBody(body) })
    const created = result.domain ? asDomain(result.domain, kind, null) : null
    if (created) {
      setDomains((current) => {
        if (!current) return current
        const primaryId = primaryIdOf(current, kind)
        const domain = asDomain(result.domain ?? {}, kind, primaryId)
        if (!domain) return current
        return withKind(current, kind, replaceItem(current[kind], domain), primaryId)
      })
      showDetail(kind, created.id)
    } else {
      await reloadDomains()
    }
    setFeedback({ tone: 'success', text: '域名已添加，请完成验证' })
    return true
  }

  const copyLink = async (item: DomainItem) => {
    try {
      await copyToClipboard(`https://${item.hostname}`)
      setFeedback({ tone: 'success', text: '链接已复制' })
    } catch {
      setFeedback({ tone: 'error', text: '无法复制链接' })
    }
  }

  const savePlatforms = async (next: PlatformItem[]) => {
    setPlatforms(next)
    setPlatformSaving(true)
    setFeedback(null)
    try {
      const result = await api<{ platforms: PlatformItem[] }>('/api/admin/system/subscription-platforms', {
        method: 'PUT',
        body: jsonBody({ platforms: next.map((entry) => ({ platform: entry.platform, enabled: entry.enabled })) }),
      })
      setPlatforms(result.platforms)
      setFeedback({ tone: 'success', text: '平台展示设置已保存' })
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorText(cause) || '保存平台展示设置失败' })
      await load()
    } finally {
      setPlatformSaving(false)
    }
  }

  const movePlatform = (index: number, direction: -1 | 1) => {
    if (!platforms) return
    const target = index + direction
    if (target < 0 || target >= platforms.length) return
    const next = [...platforms]
    const [entry] = next.splice(index, 1)
    next.splice(target, 0, entry)
    void savePlatforms(next)
  }

  const toggleRestriction = async (enabled: boolean) => {
    const previous = domains?.restrictionEnabled ?? false
    setRestrictionBusy(true)
    setFeedback(null)
    setDomains((current) => current ? { ...current, restrictionEnabled: enabled } : current)
    try {
      const result = await api<{ enabled?: boolean }>('/api/admin/system/domain-restriction', { method: 'PUT', body: jsonBody({ enabled }) })
      const next = typeof result.enabled === 'boolean' ? result.enabled : enabled
      setDomains((current) => current ? { ...current, restrictionEnabled: next } : current)
      setFeedback({ tone: 'success', text: next ? '域名限制已开启' : '域名限制已关闭' })
    } catch (cause) {
      setDomains((current) => current ? { ...current, restrictionEnabled: previous } : current)
      setFeedback({ tone: 'error', text: errorText(cause) || '保存域名限制开关失败' })
    } finally {
      setRestrictionBusy(false)
    }
  }

  return (
    <Section title="域名管理">
      {feedback ? <InlineMessage tone={feedback.tone}>{feedback.text}</InlineMessage> : null}
      {domains ? (
        <FormGroup id="sys-domain-restriction-title" title="访问限制">
          <FormField label="域名限制">
            <Switch checked={domains.restrictionEnabled} disabled={restrictionBusy} ariaLabel="域名限制" onChange={(enabled) => { toggleRestriction(enabled).catch(() => undefined) }} />
          </FormField>
          <p className="sys-hint">开启后，面板只接受已启用的面板域名访问，订阅与分享只接受已启用的订阅域名访问；某一类没有已启用的域名时，该类不做限制，不会把任何人锁在门外</p>
        </FormGroup>
      ) : null}
      {domains ? (
        <FormGroup id="sys-platform-title" title="订阅平台展示" hint="关闭的平台不会出现在用户的订阅页与首页入口中，订阅内容生成不受影响">
          {platforms ? (
            <ul className="dom-platform-list">
              {platforms.map((entry, index) => (
                <li className="dom-platform-row" key={entry.platform}>
                  <span className="dom-platform-name"><strong>{entry.displayName}</strong><span>{entry.platform}</span></span>
                  <span className="dom-platform-actions">
                    <button className="icon-button" type="button" aria-label={`上移 ${entry.displayName}`} disabled={platformSaving || index === 0} onClick={() => movePlatform(index, -1)}><ArrowUp aria-hidden="true" size={16} /></button>
                    <button className="icon-button" type="button" aria-label={`下移 ${entry.displayName}`} disabled={platformSaving || index === platforms.length - 1} onClick={() => movePlatform(index, 1)}><ArrowDown aria-hidden="true" size={16} /></button>
                    <Switch checked={entry.enabled} disabled={platformSaving} ariaLabel={`${entry.displayName} 展示`} onChange={(enabled) => { void savePlatforms(platforms.map((item) => item.platform === entry.platform ? { ...item, enabled } : item)) }} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </FormGroup>
      ) : null}

      <SectionTabs label="域名用途" variant="detail" activeTo={domainTabTo(kind, search)} tabs={[
        { to: domainTabTo('panel', search), label: '面板域名' },
        { to: domainTabTo('subscription', search), label: '订阅域名' },
      ]} />
      <section className="sys-domain-panel" aria-label={KIND_LABEL[kind]}>
        <div className="sys-domain-panel-head">
          <p className="sys-hint">{kind === 'panel' ? '主链接用于邀请链接等面板绝对链接' : '订阅链接与分享链接都使用主订阅域名生成，备用域名不会出现在任何链接里'}</p>
          <button className="button primary" type="button" disabled={busy} onClick={() => setAddOpen(true)}><Plus aria-hidden="true" size={16} />添加域名</button>
        </div>
        {loading && !domains ? (
          <div className="sys-domain-skeleton" role="status" aria-label="正在加载域名">
            <Skeleton /><Skeleton /><Skeleton />
          </div>
        ) : null}
        {!loading && loadError && !domains ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {domains && rows.length === 0 ? <EmptyState title="暂无域名" /> : null}
        {domains && rows.length > 0 ? (
          <div role="radiogroup" aria-label={`${KIND_LABEL[kind]}主链接`} aria-busy={busy || undefined}>
            <ul className="sys-domain-rows">
              {rows.map((item) => {
                const reason = switchReason(item)
                const reasonId = `domain-switch-reason-${item.id}`
                const eligible = canBePrimary(item)
                return (
                  <li className="sys-domain-row" key={item.id} aria-busy={busy || undefined}>
                    <div className="sys-domain-identity">
                      <strong className="sys-domain-host">{item.hostname}</strong>
                      <Mark status={item.verificationStatus} />
                      {item.note ? <span className="sys-domain-note-text">{item.note}</span> : null}
                    </div>
                    <div className="sys-domain-controls">
                      <label className="sys-domain-primary-choice">
                        <input
                          id={`domain-primary-${item.id}`}
                          type="radio"
                          name={`domain-primary-${kind}`}
                          value={item.id}
                          checked={item.isPrimary}
                          disabled={busy || !eligible}
                          aria-label={eligible ? `${item.hostname} 主链接` : `${item.hostname} 主链接，需先验证并启用`}
                          onChange={() => { setPrimary(item).catch(() => undefined) }}
                        />
                        <span>主链接</span>
                      </label>
                      <span className="sys-domain-switch">
                        <Switch
                          id={`domain-enabled-${item.id}`}
                          checked={item.enabled}
                          disabled={busy || item.isPrimary || (item.verificationStatus !== 'verified' && !item.enabled)}
                          ariaLabel={reason ? `${item.hostname} 启用，${reason}` : `${item.hostname} 启用`}
                          describedBy={reason ? reasonId : undefined}
                          onChange={(enabled) => { setEnabled(item, enabled).catch(() => undefined) }}
                        />
                        {reason ? <span className="sys-domain-lock-reason" id={reasonId}>{reason}</span> : null}
                      </span>
                      <RowActions label={`${item.hostname} 更多操作`} actions={[
                        { label: '复制链接', disabled: busy, onClick: () => { copyLink(item).catch(() => undefined) } },
                        { label: '编辑备注', disabled: busy, onClick: () => setNoteId(item.id) },
                        { label: '重新验证', disabled: busy, onClick: () => showDetail(kind, item.id, true) },
                        { label: '查看详情', disabled: busy, onClick: () => showDetail(kind, item.id) },
                        {
                          label: '删除',
                          danger: true,
                          disabled: busy || item.isPrimary,
                          accessibleLabel: item.isPrimary ? `删除 ${item.hostname}，主链接不能删除，请先切换主链接` : `删除 ${item.hostname}`,
                          onClick: () => { if (!item.isPrimary) { setDeleteError(''); setPendingDelete(item) } },
                        },
                      ]} />
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
        {domains ? <OperationsFooter total={rows.length} unit="个域名" /> : null}
      </section>

      <AddDomainDialog open={addOpen} kind={kind} onClose={() => setAddOpen(false)} onAdd={addDomain} />
      <NoteDialog item={noteItem} busy={busy} onClose={() => setNoteId(null)} onSave={saveNote} />
      <DomainDetail
        key={detail ? `${detail.id}:${detail.nonce}` : undefined}
        item={active}
        request={active ? detail : null}
        onClose={() => { verifyAbortRef.current?.abort(); setDetail(null) }}
        onFailure={reloadDomains}
        verifyAbortRef={verifyAbortRef}
        onVerified={(domain) => {
          setDomains((current) => {
            if (!current || !detail) return current
            const primaryId = domain.isPrimary ? domain.id : primaryIdOf(current, detail.kind)
            const items = replaceItem(current[detail.kind], { ...domain, isPrimary: domain.id === primaryId })
              .map((entry) => ({ ...entry, isPrimary: entry.id === primaryId }))
            return withKind(current, detail.kind, items, primaryId)
          })
          setFeedback({ tone: 'success', text: domain.verificationStatus === 'verified' ? '验证已通过' : '验证结果已更新' })
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除域名"
        description={pendingDelete ? `删除 ${pendingDelete.hostname} 后，使用该域名的旧链接将停止服务。此操作只移除应用层授权，不会自动删除 Cloudflare DNS 记录或 Worker 绑定` : ''}
        confirmLabel="确认删除"
        danger
        busy={busy}
        appearance="content"
        onClose={() => { if (!busy) { setPendingDelete(null); setDeleteError('') } }}
        onConfirm={() => { removeDomain().catch(() => undefined) }}
      >
        {deleteError ? <StatusMessage tone="error">{deleteError}</StatusMessage> : null}
      </ConfirmDialog>
    </Section>
  )
}

function AddDomainDialog({ open, kind, onClose, onAdd }: {
  open: boolean
  kind: DomainKind
  onClose: () => void
  onAdd: (hostname: string, note: string) => Promise<boolean>
}) {
  const [hostname, setHostname] = useState('')
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const idPrefix = `sys-domain-${kind}`

  useEffect(() => {
    if (open) return
    setHostname('')
    setNote('')
    setError('')
  }, [open])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (adding || hostname.trim() === '') return
    setAdding(true)
    setError('')
    try {
      if (await onAdd(hostname.trim(), note.trim())) onClose()
    } catch (cause) {
      setError(errorText(cause) || '添加域名失败')
    } finally {
      setAdding(false)
    }
  }

  return (
    <Dialog open={open} title="添加域名" description={`将添加到${KIND_LABEL[kind]}`} size="m" appearance="content" busy={adding} dirty={Boolean(hostname || note)} onClose={() => { if (!adding) onClose() }}
      footer={(cancel) => <>
        <button className="button secondary" type="button" onClick={cancel}>取消</button>
        <button className="button primary" form={`${idPrefix}-add`} type="submit" disabled={adding || hostname.trim() === ''}>添加</button>
      </>}>
      <form id={`${idPrefix}-add`} className="form-stack" onSubmit={(event) => { submit(event).catch(() => undefined) }}>
        <FormField label="域名" htmlFor={`${idPrefix}-hostname`}>
          <Input id={`${idPrefix}-hostname`} value={hostname} placeholder="例如 panel.example.com" autoComplete="off" disabled={adding} onChange={(event) => setHostname(event.currentTarget.value)} />
        </FormField>
        <FormField label="备注" htmlFor={`${idPrefix}-note`} hint="选填，最多 200 个字符">
          <Input id={`${idPrefix}-note`} value={note} maxLength={200} autoComplete="off" disabled={adding} onChange={(event) => setNote(event.currentTarget.value)} />
        </FormField>
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      </form>
    </Dialog>
  )
}

function NoteDialog({ item, busy, onClose, onSave }: {
  item: DomainItem | null
  busy: boolean
  onClose: () => void
  onSave: (item: DomainItem, note: string) => Promise<string | null>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const current = item && draft !== null ? draft : item?.note ?? ''

  useEffect(() => {
    setDraft(null)
    setError('')
  }, [item?.id])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!item || saving || busy) return
    if (current === item.note) {
      onClose()
      return
    }
    setSaving(true)
    setError('')
    try {
      const message = await onSave(item, current)
      if (message) setError(message)
      else setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={item !== null} title="编辑域名备注" description={item ? `域名 ${item.hostname}` : undefined} size="m" appearance="content" busy={saving} dirty={item !== null && current !== item.note}
      onClose={() => { setDraft(null); onClose() }}
      footer={(cancel) => <>
        <button className="button secondary" type="button" disabled={saving} onClick={cancel}>取消</button>
        <button className="button primary" form={item ? `domain-note-${item.id}` : undefined} type="submit" disabled={saving || !item || current === item.note}>保存备注</button>
      </>}>
      {item ? (
        <form id={`domain-note-${item.id}`} className="form-stack" onSubmit={(event) => { submit(event).catch(() => undefined) }}>
          <FormField label="备注" htmlFor={`domain-note-input-${item.id}`} hint="可以清空。保存不会修改域名">
            <Input id={`domain-note-input-${item.id}`} value={draft ?? item.note} maxLength={200} disabled={saving} onChange={(event) => setDraft(event.currentTarget.value)} />
          </FormField>
          {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
        </form>
      ) : null}
    </Dialog>
  )
}

function DomainDetail({ item, request, onClose, onFailure, onVerified, verifyAbortRef }: {
  item: DomainItem | null
  request: DetailRequest | null
  onClose: () => void
  onFailure: () => Promise<void>
  onVerified: (domain: DomainItem) => void
  verifyAbortRef: { current: AbortController | null }
}) {
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  const [probeStatus, setProbeStatus] = useState<ProbeState | null>(null)

  const confirm = async () => {
    if (!item || !request || verifying) return
    const controller = new AbortController()
    verifyAbortRef.current?.abort()
    verifyAbortRef.current = controller
    setVerifying(true)
    setVerifyError('')
    setExpiresAt(null)
    setProbeStatus(null)
    const path = `/api/admin/system/domains/${request.kind}/${item.id}`
    try {
      const { challenge } = await api<{ challenge: Challenge }>(`${path}/challenge`, {
        method: 'POST',
        body: jsonBody({}),
        signal: controller.signal,
      })
      if (!challenge || !/^[A-Za-z0-9_-]{43}$/u.test(challenge.nonce) || !challenge.challengeId || !challenge.expiresAt) {
        throw new Error('服务返回了无效的验证挑战')
      }
      setExpiresAt(challenge.expiresAt)
      let verification: { proof: unknown } | { challengeId: string; reason: 'PROBE_FAILED' }
      try {
        const proof = await readDomainProof(item.hostname, challenge.nonce, controller.signal)
        verification = { proof }
      } catch {
        controller.signal.throwIfAborted()
        setProbeStatus('failed')
        verification = { challengeId: challenge.challengeId, reason: 'PROBE_FAILED' }
      }
      const result = await api<{ domain?: DomainPayload }>(`${path}/verify`, {
        method: 'POST',
        body: jsonBody(verification),
        signal: controller.signal,
      })
      const domain = result.domain ? asDomain(result.domain, request.kind, item.isPrimary ? item.id : null, item) : null
      if (!domain) throw new Error('服务返回了无效的域名状态')
      setProbeStatus('ok')
      onVerified(domain)
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiClientError && cause.code === 'VERIFY_FAILED') {
        await onFailure().catch(() => undefined)
        if (controller.signal.aborted) return
      }
      const details = cause instanceof ApiClientError ? cause.details as { reason?: string } | undefined : undefined
      const reason = details?.reason
      const messages: Record<string, string> = {
        CHALLENGE_EXPIRED: '验证挑战已过期，请重试',
        CHALLENGE_INVALID: '验证挑战已失效，请重试',
        PROOF_INVALID: '该域名返回的验证证明无效',
        INSTANCE_MISMATCH: '该域名指向另一个实例',
        PROBE_FAILED: '无法连接该域名上的验证端点',
        TIMEOUT: '验证未完成，请稍后重试',
      }
      setVerifyError(reason && Object.hasOwn(messages, reason) ? messages[reason] : errorText(cause))
    } finally {
      if (verifyAbortRef.current === controller) setVerifying(false)
    }
  }

  return (
    <Dialog open={item !== null} title={item?.hostname ?? '域名详情'} placement="end" appearance="content" size="m" className="sys-domain-drawer" onClose={onClose}
      headerStatus={item ? <Mark status={item.verificationStatus} /> : undefined}
      footer={() => (
        <button className="button primary" type="button" disabled={!item || verifying} onClick={() => { confirm().catch(() => undefined) }}>{verifying ? '正在验证' : '验证'}</button>
      )}>
      {item ? (
        <div className="form-stack">
          <div aria-live="polite">
            <DetailList items={[
              { id: 'hostname', label: '域名', value: item.hostname },
              { id: 'purpose', label: '用途', value: KIND_LABEL[item.purpose] },
              { id: 'primary', label: '主链接', value: item.isPrimary ? '是' : '否' },
              { id: 'enabled', label: '启用', value: item.enabled ? '已启用' : '未启用' },
              { id: 'note', label: '备注', value: item.note || '无' },
              { id: 'verifiedAt', label: '验证时间', value: item.verifiedAt ? formatTime(item.verifiedAt) : '未验证' },
              { id: 'https', label: 'HTTPS', value: <Probe status={probeStatus ?? probeOf(item.health, 'https')} /> },
              { id: 'service', label: '服务可达性', value: <Probe status={probeStatus ?? probeOf(item.health, 'service')} /> },
              { id: 'checked', label: '最近检查', value: item.lastCheckAt ? formatTime(item.lastCheckAt) : '未检查' },
            ]} />
          </div>
          {item.lastCheckError ? <p className="sys-domain-error">{item.lastCheckError}</p> : null}
          <section aria-label="HTTPS 验证">
            {expiresAt && verifying ? <p className="sys-hint">挑战有效期至 {formatTime(expiresAt)}</p> : null}
            {verifying ? <p role="status">正在验证域名</p> : null}
            {verifyError ? <StatusMessage tone="error">{verifyError}</StatusMessage> : null}
          </section>
        </div>
      ) : null}
    </Dialog>
  )
}
