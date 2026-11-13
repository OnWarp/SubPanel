import { ArrowDown, ArrowUp, Plus, ShieldCheck, Star, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { InlineMessage } from '../../ui/InlineMessage'
import { LoadingState } from '../../ui/LoadingState'
import { Switch } from '../../ui/Switch'
import { StatusBadge } from '../../ui/StatusBadge'

type DomainKind = 'panel' | 'subscription'
type VerificationStatus = 'pending' | 'verified' | 'failed'

type DomainItem = {
  id: string
  hostname: string
  enabled: boolean
  verificationStatus: VerificationStatus
  verifiedAt: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  note: string
  createdAt: string
  updatedAt: string
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

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function formatTime(value: string | null): string {
  if (!value) return '从未验证'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}


const VERIFICATION_BADGE: Record<VerificationStatus, { tone: 'success' | 'warning' | 'danger'; text: string }> = {
  verified: { tone: 'success', text: '已验证' },
  pending: { tone: 'warning', text: '待验证' },
  failed: { tone: 'danger', text: '验证失败' },
}

function DomainCard({ kind, title, description, items, primaryId, busyId, onVerify, onSetPrimary, onToggleEnabled, onSaveNote, onDelete, onAdd }: {
  kind: DomainKind
  title: string
  description: string
  items: DomainItem[]
  primaryId: string | null
  busyId: string
  onVerify: (kind: DomainKind, item: DomainItem) => void
  onSetPrimary: (kind: DomainKind, item: DomainItem) => void
  onToggleEnabled: (kind: DomainKind, item: DomainItem, enabled: boolean) => void
  onSaveNote: (kind: DomainKind, item: DomainItem, note: string) => void
  onDelete: (kind: DomainKind, item: DomainItem) => void
  onAdd: (kind: DomainKind, hostname: string, note: string) => Promise<boolean>
}) {
  const [hostname, setHostname] = useState('')
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  const idPrefix = `dom-${kind}`

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setAdding(true)
    try {
      if (await onAdd(kind, hostname, note)) {
        setHostname('')
        setNote('')
      }
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="dom-card">
      <h3 className="dom-card-title">{title}</h3>
      <p className="sys-hint">{description}</p>
      {items.length === 0 ? <p className="section-empty">暂无域名</p> : null}
      <ul className="dom-list">
        {items.map((item) => {
          const isPrimary = item.id === primaryId
          const badge = VERIFICATION_BADGE[item.verificationStatus]
          const draft = noteDrafts[item.id] ?? item.note
          const busy = busyId === item.id || busyId === 'all'
          return (
            <li className="dom-item" key={item.id}>
              <div className="dom-item-main">
                <strong className="dom-host">{item.hostname}</strong>
                {isPrimary ? <StatusBadge tone="success" size="sm">主域名</StatusBadge> : null}
                <StatusBadge tone={badge.tone} size="sm">{badge.text}</StatusBadge>
                <StatusBadge tone={item.enabled ? 'success' : 'warning'} size="sm">{item.enabled ? '已启用' : '已停用'}</StatusBadge>
              </div>
              <p className="dom-meta">
                最近验证 {formatTime(item.lastCheckAt)}
                {item.lastCheckError ? <span className="dom-error"> · {item.lastCheckError}</span> : null}
              </p>
              <div className="dom-note-row">
                <input
                  aria-label={`${item.hostname} 备注`}
                  value={draft}
                  maxLength={200}
                  placeholder="备注"
                  disabled={busy}
                  onChange={(event) => setNoteDrafts((current) => ({ ...current, [item.id]: event.currentTarget.value }))}
                />
                <button className="button secondary" type="button" disabled={busy || draft === item.note} onClick={() => onSaveNote(kind, item, draft)}>保存备注</button>
              </div>
              <div className="dom-actions">
                <button className="button secondary" type="button" disabled={busy} onClick={() => onVerify(kind, item)}><ShieldCheck aria-hidden="true" size={16} />验证</button>
                <button className="button secondary" type="button" disabled={busy || isPrimary || !item.enabled || item.verificationStatus !== 'verified'} onClick={() => onSetPrimary(kind, item)}><Star aria-hidden="true" size={16} />设为主域名</button>
                <Switch checked={item.enabled} disabled={busy} ariaLabel={`${item.hostname} 启用状态`} onChange={(enabled) => onToggleEnabled(kind, item, enabled)} />
                <button className="button danger" type="button" disabled={busy || isPrimary} title={isPrimary ? '主域名不能删除' : '删除域名'} onClick={() => onDelete(kind, item)}><Trash2 aria-hidden="true" size={16} />删除</button>
              </div>
            </li>
          )
        })}
      </ul>
      <form className="dom-add-form" onSubmit={submit}>
        <FormField label="域名" htmlFor={`${idPrefix}-hostname`}>
          <input id={`${idPrefix}-hostname`} value={hostname} placeholder="例如 panel.example.com" autoComplete="off" disabled={adding} onChange={(event) => setHostname(event.currentTarget.value)} />
        </FormField>
        <FormField label="备注" htmlFor={`${idPrefix}-note`}>
          <input id={`${idPrefix}-note`} value={note} maxLength={200} autoComplete="off" disabled={adding} onChange={(event) => setNote(event.currentTarget.value)} />
        </FormField>
        <button className="button primary" type="submit" disabled={adding || hostname.trim() === ''}><Plus aria-hidden="true" size={16} />添加</button>
      </form>
    </div>
  )
}

export function DomainSettingsSection() {
  const [domains, setDomains] = useState<DomainsResponse | null>(null)
  const [platforms, setPlatforms] = useState<PlatformItem[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busyId, setBusyId] = useState('')
  const [platformSaving, setPlatformSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{ kind: DomainKind; item: DomainItem } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [domainData, platformData] = await Promise.all([
        api<DomainsResponse>('/api/admin/system/domains'),
        api<{ platforms: PlatformItem[] }>('/api/admin/system/subscription-platforms'),
      ])
      setDomains(domainData)
      setPlatforms(platformData.platforms)
    } catch (cause) {
      setLoadError(errorMessage(cause, '无法加载域名设置'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const reloadDomains = useCallback(async () => {
    const data = await api<DomainsResponse>('/api/admin/system/domains')
    setDomains(data)
  }, [])

  const actOnDomain = async (item: DomainItem, action: () => Promise<unknown>, successText: string) => {
    setBusyId(item.id)
    setFeedback(null)
    try {
      await action()
      await reloadDomains()
      setFeedback({ tone: 'success', text: successText })
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause, '操作失败') })
    } finally {
      setBusyId('')
    }
  }

  const addDomain = async (kind: DomainKind, hostname: string, note: string): Promise<boolean> => {
    setFeedback(null)
    try {
      await api(`/api/admin/system/domains/${kind}`, { method: 'POST', body: jsonBody({ hostname, note: note || undefined }) })
      await reloadDomains()
      setFeedback({ tone: 'success', text: '域名已添加，验证通过后才能启用' })
      return true
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause, '添加域名失败') })
      return false
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
      setFeedback({ tone: 'error', text: errorMessage(cause, '保存平台展示设置失败') })
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
    setBusyId('all')
    setFeedback(null)
    try {
      await api('/api/admin/system/domain-restriction', { method: 'PUT', body: jsonBody({ enabled }) })
      await reloadDomains()
      setFeedback({ tone: 'success', text: enabled ? '域名限制已开启' : '域名限制已关闭' })
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause, '保存域名限制开关失败') })
    } finally {
      setBusyId('')
    }
  }

  return (
    <section className="data-section sys-section" aria-labelledby="sys-domains-title">
      <DataHeader id="sys-domains-title" title="域名与平台展示" />
      {loading ? <LoadingState label="正在加载域名设置" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && domains ? (
        <div className="dom-stack">
          {feedback ? <InlineMessage tone={feedback.tone}>{feedback.text}</InlineMessage> : null}

          <div className="dom-block">
            <FormField label="域名限制">
              <Switch checked={domains.restrictionEnabled} disabled={busyId === 'all'} ariaLabel="域名限制" onChange={(enabled) => { toggleRestriction(enabled).catch(() => undefined) }} />
            </FormField>
            <p className="sys-hint">开启后，面板只接受已启用的面板域名访问，订阅与分享只接受已启用的订阅域名访问；某一类没有已启用的域名时，该类不做限制，不会把任何人锁在门外</p>
          </div>

          <div className="dom-block">
            <h3 className="dom-card-title">订阅平台展示</h3>
            <p className="sys-hint">关闭的平台不会出现在用户的订阅页与首页入口中，订阅内容生成不受影响</p>
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
          </div>

          <DomainCard
            kind="panel"
            title="面板域名"
            description="用于生成邀请链接等面板绝对链接，主面板域名会优先使用"
            items={domains.panel}
            primaryId={domains.primaryPanelDomainId}
            busyId={busyId}
            onVerify={(kind, item) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}/verify`, { method: 'POST', body: jsonBody({}) }), '验证已完成').catch(() => undefined) }}
            onSetPrimary={(kind, item) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}/primary`, { method: 'POST', body: jsonBody({}) }), '主域名已更新').catch(() => undefined) }}
            onToggleEnabled={(kind, item, enabled) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ enabled }) }), enabled ? '域名已启用' : '域名已停用').catch(() => undefined) }}
            onSaveNote={(kind, item, note) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ note }) }), '备注已保存').catch(() => undefined) }}
            onDelete={(kind, item) => setPendingDelete({ kind, item })}
            onAdd={addDomain}
          />
          <DomainCard
            kind="subscription"
            title="订阅域名"
            description="订阅链接与分享链接都使用主订阅域名生成，备用域名不会出现在任何链接里"
            items={domains.subscription}
            primaryId={domains.primarySubscriptionDomainId}
            busyId={busyId}
            onVerify={(kind, item) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}/verify`, { method: 'POST', body: jsonBody({}) }), '验证已完成').catch(() => undefined) }}
            onSetPrimary={(kind, item) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}/primary`, { method: 'POST', body: jsonBody({}) }), '主域名已更新').catch(() => undefined) }}
            onToggleEnabled={(kind, item, enabled) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ enabled }) }), enabled ? '域名已启用' : '域名已停用').catch(() => undefined) }}
            onSaveNote={(kind, item, note) => { actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ note }) }), '备注已保存').catch(() => undefined) }}
            onDelete={(kind, item) => setPendingDelete({ kind, item })}
            onAdd={addDomain}
          />
        </div>
      ) : null}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除域名"
        description={pendingDelete ? `确定删除 ${pendingDelete.item.hostname} 吗` : ''}
        confirmLabel="确认删除"
        busy={busyId !== ''}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return
          const { kind, item } = pendingDelete
          setPendingDelete(null)
          actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'DELETE' }), '域名已删除').catch(() => undefined)
        }}
      />
    </section>
  )
}
