import { Dialog } from '../../ui/Dialog'
import { EmptyState } from '../../ui/EmptyState'
import { Input } from '../../ui/Controls'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, peekApi, readData, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorState } from '../../ui/ErrorState'
import { FormField, FormGroup } from '../../ui/FormField'
import { InlineMessage } from '../../ui/InlineMessage'
import { LoadingState } from '../../ui/LoadingState'
import { Section } from '../../ui/Section'
import { StatusMessage } from '../../ui/StatusMessage'
import { Switch } from '../../ui/Switch'
import { OperationsActions, OperationsFooter } from '../admin/OperationsCard'

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


const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  verified: '已验证',
  pending: '待验证',
  failed: '验证失败',
}

function DomainNote({ item, busy, error, onSave }: {
  item: DomainItem
  busy: boolean
  error?: string
  onSave: (note: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || saving || draft === null) return
    if (draft === item.note) {
      setDraft(null)
      return
    }
    setSaving(true)
    try {
      if (await onSave(draft)) setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  return <>
    <button className="sys-domain-note" type="button" disabled={busy} aria-label={`编辑 ${item.hostname} 备注`} onClick={() => setDraft(item.note)}>
      {item.note || '添加备注'}
    </button>
    <Dialog open={draft !== null} title="编辑域名备注" size="m" appearance="content" busy={saving} dirty={draft !== null && draft !== item.note} onClose={() => setDraft(null)}
      footer={cancel => <>
        <button className="button secondary" type="button" disabled={saving} onClick={cancel}>取消</button>
        <button className="button primary" form={`domain-note-${item.id}`} type="submit" disabled={saving}>保存备注</button>
      </>}>
      <form id={`domain-note-${item.id}`} className="form-stack" onSubmit={submit}>
        <FormField label="备注" htmlFor={`domain-note-input-${item.id}`}>
          <Input id={`domain-note-input-${item.id}`} value={draft ?? ''} maxLength={200} readOnly={saving}
            onChange={(event) => setDraft(event.currentTarget.value)} />
        </FormField>
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
      </form>
    </Dialog>
  </>
}

function DomainCard({ kind, title, description, items, primaryId, busyId, onVerify, onSetPrimary, onToggleEnabled, onSaveNote, onDelete, onAdd, operationError }: {
  kind: DomainKind
  title: string
  description: string
  items: DomainItem[]
  primaryId: string | null
  busyId: string
  onVerify: (kind: DomainKind, item: DomainItem) => void
  onSetPrimary: (kind: DomainKind, item: DomainItem) => void
  onToggleEnabled: (kind: DomainKind, item: DomainItem, enabled: boolean) => void
  onSaveNote: (kind: DomainKind, item: DomainItem, note: string) => Promise<boolean>
  onDelete: (kind: DomainKind, item: DomainItem) => void
  operationError?: string
  onAdd: (kind: DomainKind, hostname: string, note: string) => Promise<boolean>
}) {
  const [addError, setAddError] = useState('')
  const [hostname, setHostname] = useState('')
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const idPrefix = `sys-domain-${kind}`

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (adding) return
    setAddError('')
    setAdding(true)
    try {
      if (await onAdd(kind, hostname, note)) {
        setHostname('')
        setNote('')
        setExpanded(false)
      }
    } catch (cause) {
      setAddError(errorMessage(cause, '添加域名失败'))
    } finally {
      setAdding(false)
    }
  }

  return (
    <Section title={title} actions={<button className="button primary" type="button" disabled={adding} onClick={() => setExpanded(true)}>
        <Plus aria-hidden="true" size={16} />添加域名
      </button>}>
      <p className="sys-hint">{description}</p>
      <Dialog open={expanded} title="添加域名" size="m" appearance="content" busy={adding} dirty={Boolean(hostname || note)}
        onClose={() => { setHostname(''); setNote(''); setAddError(''); setExpanded(false) }}
        footer={(cancel) => <>
          <button className="button secondary" type="button" onClick={cancel}>取消</button>
          <button className="button primary" form={`${idPrefix}-add`} type="submit" disabled={adding || hostname.trim() === ''}>添加</button>
        </>}>
      <form id={`${idPrefix}-add`} className="form-stack" onSubmit={submit}>
        <FormField label="域名" htmlFor={`${idPrefix}-hostname`}>
          <Input id={`${idPrefix}-hostname`} value={hostname} placeholder="例如 panel.example.com" autoComplete="off" disabled={adding} onChange={(event) => setHostname(event.currentTarget.value)} />
        </FormField>
        <FormField label="备注" htmlFor={`${idPrefix}-note`}>
          <Input id={`${idPrefix}-note`} value={note} maxLength={200} autoComplete="off" disabled={adding} onChange={(event) => setNote(event.currentTarget.value)} />
        </FormField>
        {addError && <StatusMessage tone="error">{addError}</StatusMessage>}
      </form>
      </Dialog>
      {items.length === 0 ? <EmptyState title="暂无域名" /> : (
        <ul className="sys-domain-rows">
          {items.map((item) => {
            const isPrimary = item.id === primaryId
            const verificationLabel = VERIFICATION_LABEL[item.verificationStatus]
            const busy = busyId === item.id || busyId === 'all'
            return (
              <li className="sys-domain-row" key={item.id}>
                <div className="sys-domain-info">
                  <div className="sys-domain-identity">
                    <strong className="sys-domain-host">{item.hostname}</strong>
                    <span className={`sys-domain-dot sys-domain-dot-${item.verificationStatus}`} role="img" aria-label={verificationLabel} title={verificationLabel} />
                    {isPrimary ? <span className="sys-domain-primary">主域名</span> : null}
                  </div>
                  <div className="sys-domain-meta">
                    <DomainNote error={operationError} item={item} busy={busy} onSave={(next) => onSaveNote(kind, item, next)} />
                    <span>{item.lastCheckAt ? `最近验证 ${formatTime(item.lastCheckAt)}` : formatTime(null)}</span>
                    {item.lastCheckError ? <span className="sys-domain-error">{item.lastCheckError}</span> : null}
                  </div>
                </div>
                <div className="sys-domain-actions">
                  <Switch checked={item.enabled} disabled={busy} ariaLabel={`${item.hostname} 启用状态`} onChange={(enabled) => onToggleEnabled(kind, item, enabled)} />
                  <OperationsActions label={`${item.hostname} 更多操作`}>
                    <button className="button ghost" type="button" disabled={busy} onClick={() => onVerify(kind, item)}>验证</button>
                    {!isPrimary ? <button className="button ghost" type="button" disabled={busy || !item.enabled || item.verificationStatus !== 'verified'} onClick={() => onSetPrimary(kind, item)}>设为主域名</button> : null}
                    <div className="content-danger-zone">
                      <button className="button danger" type="button" disabled={busy || isPrimary} title={isPrimary ? '主域名不能删除' : '删除域名'} onClick={() => onDelete(kind, item)}>删除</button>
                    </div>
                  </OperationsActions>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <OperationsFooter total={items.length} unit="个域名" />
    </Section>
  )
}

export function DomainSettingsSection() {
  const [domains, setDomains] = useState<DomainsResponse | null>(() => peekApi<DomainsResponse>('/api/admin/system/domains') ?? null)
  const [platforms, setPlatforms] = useState<PlatformItem[] | null>(() => peekApi<{ platforms: PlatformItem[] }>('/api/admin/system/subscription-platforms')?.platforms ?? null)
  const [loading, setLoading] = useState(() => peekApi('/api/admin/system/domains') === undefined || peekApi('/api/admin/system/subscription-platforms') === undefined)
  const [loadError, setLoadError] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [busyId, setBusyId] = useState('')
  const [platformSaving, setPlatformSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{ kind: DomainKind; item: DomainItem } | null>(null)

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/system/domains') === undefined || peekApi('/api/admin/system/subscription-platforms') === undefined)
    setLoadError('')
    try {
      await readData((read) => Promise.all([
        read<DomainsResponse>('/api/admin/system/domains'),
        read<{ platforms: PlatformItem[] }>('/api/admin/system/subscription-platforms'),
      ]), ([domainData, platformData]) => {
        setDomains(domainData)
        setPlatforms(platformData.platforms)
        setLoading(false)
      })
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
      return true
    } catch (cause) {
      setFeedback({ tone: 'error', text: errorMessage(cause, '操作失败') })
      return false
    } finally {
      setBusyId('')
    }
  }

  const addDomain = async (kind: DomainKind, hostname: string, note: string): Promise<boolean> => {
    setFeedback(null)
    await api(`/api/admin/system/domains/${kind}`, { method: 'POST', body: jsonBody({ hostname, note: note || undefined }) })
    await reloadDomains()
    setFeedback({ tone: 'success', text: '域名已添加，验证通过后才能启用' })
    return true
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
    <Section title="域名与平台展示">
      {loading ? <LoadingState label="正在加载域名设置" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && domains ? (
        <div className="page-stack settings-fields">
          {feedback ? <InlineMessage tone={feedback.tone}>{feedback.text}</InlineMessage> : null}

          <FormGroup id="sys-domain-restriction-title" title="访问限制">
            <FormField label="域名限制">
              <Switch checked={domains.restrictionEnabled} disabled={busyId === 'all'} ariaLabel="域名限制" onChange={(enabled) => { toggleRestriction(enabled).catch(() => undefined) }} />
            </FormField>
            <p className="sys-hint">开启后，面板只接受已启用的面板域名访问，订阅与分享只接受已启用的订阅域名访问；某一类没有已启用的域名时，该类不做限制，不会把任何人锁在门外</p>
          </FormGroup>

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
            onSaveNote={(kind, item, note) => actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ note }) }), '备注已保存')}
            onDelete={(kind, item) => setPendingDelete({ kind, item })}
            operationError={feedback?.tone === 'error' ? feedback.text : undefined}
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
            onSaveNote={(kind, item, note) => actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'PATCH', body: jsonBody({ note }) }), '备注已保存')}
            onDelete={(kind, item) => setPendingDelete({ kind, item })}
            operationError={feedback?.tone === 'error' ? feedback.text : undefined}
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
        appearance="content"
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return
          const { kind, item } = pendingDelete
          setPendingDelete(null)
          actOnDomain(item, () => api(`/api/admin/system/domains/${kind}/${item.id}`, { method: 'DELETE' }), '域名已删除').catch(() => undefined)
        }}
      />
    </Section>
  )
}
