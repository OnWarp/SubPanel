import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, jsonBody, type CatalogResponse, type UserSummary } from '../../app/api'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { FormSelect, Input } from '../../ui/Controls'
import { DetailList, StatGroup } from '../../ui/DetailList'
import { RowActions } from '../../ui/RowActions'
import { Section } from '../../ui/Section'
import { StatusPill } from '../../ui/StatusPill'
import { DataTable } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { StatusMessage } from '../../ui/StatusMessage'
import { entitlementTemplatesPath, nodePolicyLabel, termLabel, type EntitlementConfig, type EntitlementTemplate } from './entitlement-types'
import { formatExpiryTime } from './expiry'
import { subscriptionError, type SubscriptionNode } from './unified-subscription'

type Binding = { templateId: string; expiresAt: string | null; startsAt: string; status: 'active' | 'paused' | 'revoked'; scope?: 'shared' | 'private'; templateStatus?: EntitlementTemplate['status'] }
type BindingList = { revision: number; bindings: Binding[] }
type Change = { before: Binding | null; after: Binding }
export type AdminSubscriptionSummary = {
  status: 'active' | 'pending' | 'expired' | 'disabled' | 'none'
  effectiveBindingCount: number
  expiresAt: string | null
  latestExpiresAt: string | null
  lastExpiredAt: string | null
  permanent: boolean
  nodes: SubscriptionNode[]
  subscriptionUrl: string | null
  logs: { id: string; action: string; createdAt: string }[]
}
const bindingStatus = { active: '有效', paused: '已暂停', revoked: '已撤销' }
const deadline = (date: string | null) => date ? formatExpiryTime(Date.parse(date)) : '长期有效'
const bindingState = (binding: Binding) => {
  if (binding.status !== 'active') return bindingStatus[binding.status]
  if (binding.templateStatus && binding.templateStatus !== 'enabled') return '模板已停用'
  if (Date.parse(binding.startsAt) > Date.now()) return '待生效'
  if (binding.expiresAt && Date.parse(binding.expiresAt) <= Date.now()) return '已过期'
  return bindingStatus.active
}

function templateLabel(template: EntitlementTemplate, templates: EntitlementTemplate[], binding?: Binding) {
  const sameName = templates.filter(other => other.name === template.name)
  if (sameName.length < 2) return template.name
  const scope = binding?.scope ?? (template.ownerUserId ? 'private' : 'shared')
  const label = scope === 'private' ? '专属' : '共享'
  const sameScope = sameName.filter(other => other.ownerUserId === template.ownerUserId)
  const shortId = template.id.slice(0, 8)
  const id = sameScope.some(other => other.id !== template.id && other.id.startsWith(shortId)) ? template.id : shortId
  const start = binding && formatExpiryTime(Date.parse(binding.startsAt))
  return `${template.name}（${[label, start && `生效 ${start}`, sameScope.length > 1 && id].filter(Boolean).join(' · ')}）`
}

const summaryStatus = { active: '有效', pending: '待生效', expired: '已过期', disabled: '不可用', none: '无授权' }
const actionLabel = { reset: '重置链接', pause: '暂停授权', resume: '恢复授权', revoke: '撤销授权' }

function BindingNodeScope({ config }: { config: EntitlementConfig }) {
  const [catalog, setCatalog] = useState<Pick<CatalogResponse, 'groups' | 'nodes'>>()
  useEffect(() => {
    const controller = new AbortController()
    void api<CatalogResponse>('/api/admin/catalog', { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setCatalog(result) })
      .catch(() => {})
    return () => controller.abort()
  }, [])
  const label = nodePolicyLabel(config)
  if (!catalog || (!config.groupIds.length && !config.nodeIds.length)) return label
  return <details>
    <summary>{label}</summary>
    <ul>
      {config.groupIds.map(id => <li key={`group:${id}`}>动态组 · {catalog.groups.find(group => group.id === id)?.name ?? id}</li>)}
      {config.nodeIds.map(id => <li key={`node:${id}`}>直选节点 · {catalog.nodes.find(node => node.id === id)?.displayName ?? id}</li>)}
    </ul>
  </details>
}

function BindingEditor({ path, bindings, templates, revision, templateId, refreshing, onClose, onSaved, onConflict }: {
  path: string
  bindings: Binding[]
  templates: EntitlementTemplate[]
  revision: number
  templateId: string
  refreshing: boolean
  onClose: () => void
  onSaved: () => void
  onConflict: () => Promise<boolean>
}) {
  const [selected, setSelected] = useState(templateId)
  const [query, setQuery] = useState('')
  const [expiry, setExpiry] = useState('default')
  const [time, setTime] = useState('')
  const [mode, setMode] = useState('assign')
  const [previous, setPrevious] = useState('')
  const [changes, setChanges] = useState<Change[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [requestId] = useState(() => crypto.randomUUID())
  const selectedTemplate = templates.find(template => template.id === selected)
  const candidates = templates.filter(template => template.status === 'enabled')
  const visible = candidates.filter(template => template.id === selected || template.name.toLowerCase().includes(query.trim().toLowerCase()))
  const replacing = mode === 'replace' || mode === 'replaceAll'
  const duplicate = bindings.some(binding => binding.templateId === selected)
  const expiresAt = Date.parse(time)
  const canPreview = selectedTemplate?.status === 'enabled' && (mode !== 'replace' || Boolean(previous)) && (expiry !== 'absolute' || Number.isFinite(expiresAt))
  const templatePath = `${path}/${encodeURIComponent(selected)}`
  const name = (id: string) => {
    const template = templates.find(item => item.id === id)
    return template ? templateLabel(template, templates, bindings.find(binding => binding.templateId === id)) : id
  }

  async function perform(save: boolean) {
    setBusy(true)
    setError('')
    try {
      if (!save) {
        const params = new URLSearchParams({ expectedRevision: String(revision), expiry, mode })
        if (expiry === 'absolute') params.set('time', String(expiresAt))
        if (mode === 'replace') params.set('oldTemplateId', previous)
        if (mode === 'replaceAll') params.set('confirm', 'true')
        const result = await api<{ changes: Change[] }>(`${templatePath}/preview?${params}`, { cache: 'no-store' })
        setChanges(result.changes)
        return
      }
      await api(replacing ? `${path}/replace` : templatePath, {
        method: replacing ? 'POST' : 'PUT',
        body: jsonBody({
          expectedRevision: revision, requestId, mode,
          startsAt: changes?.[0] ? Date.parse(changes[0].after.startsAt) : undefined,
          expiry: expiry === 'absolute' ? { type: expiry, expiresAt } : { type: expiry },
          ...(replacing && { newTemplateId: selected }),
          ...(mode === 'replace' && { oldTemplateId: previous }),
          ...(mode === 'replaceAll' && { confirm: true }),
        }),
      })
      onSaved()
    } catch (cause) {
      setConflict(cause instanceof ApiClientError && cause.code === 'BINDING_CONFLICT')
      setError(subscriptionError(cause, cause instanceof ApiClientError ? cause.message : '授权操作失败'))
    } finally {
      setBusy(false)
    }
  }

  const clearReview = () => { setChanges(undefined); setError('') }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canPreview || conflict || busy || refreshing) return
    void perform(Boolean(changes))
  }

  const replacingAll = Boolean(changes && mode === 'replaceAll')
  const submitLabel = !changes ? '预览影响' : replacingAll ? '替换全部'
    : duplicate && mode === 'assign' ? '确认更新' : '确认绑定'
  return <Dialog open appearance="content" title={duplicate ? '更新绑定' : '绑定模板'} size="l" busy={busy}
      dirty={selected !== templateId || expiry !== 'default' || mode !== 'assign' || !!time} onClose={onClose}
      footer={<Button form="binding-form" type="submit" variant={replacingAll ? 'danger' : 'primary'}
        disabled={busy || conflict || refreshing || !canPreview}>{submitLabel}</Button>}>
      <form id="binding-form" className="sp-form-stack" onSubmit={submit} onChange={clearReview}>
        <FormField label="搜索模板" htmlFor="binding-search"><Input id="binding-search" value={query} disabled={busy} onChange={event => setQuery(event.currentTarget.value)} /></FormField>
        <FormField label="模板" htmlFor="binding-template"><FormSelect id="binding-template" disabled={busy} value={selected}
          onChange={event => { setSelected(event.currentTarget.value); setPrevious(''); clearReview() }}>
          <option value="">选择模板</option>
          {visible.map(template => <option key={template.id} value={template.id}>{name(template.id)}</option>)}
        </FormSelect></FormField>
        {selectedTemplate && <DetailList items={[
          { id: 'duration', label: '模板默认有效期', value: termLabel(selectedTemplate.currentVersion.config) },
          { id: 'nodes', label: '节点范围', value: <BindingNodeScope config={selectedTemplate.currentVersion.config} /> },
        ]} />}
        <FormField label="有效期" htmlFor="binding-expiry"><FormSelect id="binding-expiry" value={expiry} disabled={busy} onChange={event => { setExpiry(event.currentTarget.value); clearReview() }}>
          <option value="default">模板默认</option><option value="absolute">自定义</option><option value="permanent">永久</option>
        </FormSelect></FormField>
        {expiry === 'absolute' && <FormField label="到期时间" htmlFor="binding-time"><Input id="binding-time" type="datetime-local" required value={time} disabled={busy} onChange={event => setTime(event.currentTarget.value)} /></FormField>}
        <FormField label="操作" htmlFor="binding-mode"><FormSelect id="binding-mode" value={mode} disabled={busy} onChange={event => { setMode(event.currentTarget.value); clearReview() }}>
          <option value="assign">{duplicate ? '更新现有绑定' : '追加'}</option><option value="replace">替换指定</option><option value="replaceAll">替换全部</option>
        </FormSelect></FormField>
        {mode === 'replace' && <FormField label="替换模板" htmlFor="binding-previous"><FormSelect id="binding-previous" required disabled={busy} value={previous} onChange={event => { setPrevious(event.currentTarget.value); clearReview() }}>
          <option value="">选择模板</option>{bindings.filter(binding => binding.templateId !== selected).map(binding => <option key={binding.templateId} value={binding.templateId}>{name(binding.templateId)}</option>)}
        </FormSelect></FormField>}
        {changes && <dl className="key-value-rows" aria-label="授权影响">
          {changes.map(({ before, after }) => <div key={after.templateId}><dt>{name(after.templateId)}</dt>
            <dd>{before && `${bindingState(before)} · ${deadline(before.expiresAt)} → `}
              {bindingState(after)}{after.status !== 'revoked' && ` · ${deadline(after.expiresAt)}`}</dd></div>)}
        </dl>}
        {replacingAll && <StatusMessage tone="warning">其他已绑定模板的授权将撤销</StatusMessage>}
        {conflict ? <ErrorState message="授权已更新，请刷新后重试" onRetry={() => {
          void onConflict().then(refreshed => {
            if (refreshed) { setConflict(false); clearReview() }
          })
        }} /> : error && <StatusMessage tone="error">{error}</StatusMessage>}
      </form>
    </Dialog>
}

export function useBindingDetails(userId: string) {
  const userPath = `/api/admin/users/${encodeURIComponent(userId)}`
  const path = `${userPath}/template-bindings`
  const summaryPath = `${userPath}/subscription`
  const [data, setData] = useState<{ list: BindingList; templates: EntitlementTemplate[]; summary: AdminSubscriptionSummary }>()
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [legacy, setLegacy] = useState(false)
  const active = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setError('')
    setRefreshing(true)
    const init = { signal: controller.signal, cache: 'no-store' } as const
    try {
      const list = await api<BindingList>(path, init)
      const [{ templates }, summary] = await Promise.all([
        api<{ templates: EntitlementTemplate[] }>(entitlementTemplatesPath, init),
        api<AdminSubscriptionSummary>(`${summaryPath}/summary`, init),
      ])
      if (!controller.signal.aborted) {
        setLegacy(false)
        setData({ list, templates: templates.filter(template => !template.ownerUserId || template.ownerUserId === userId), summary })
      }
      return !controller.signal.aborted
    } catch (cause) {
      if (controller.signal.aborted) return false
      if (cause instanceof ApiClientError && cause.status === 404 && cause.code === 'SUBSCRIPTION_NOT_FOUND') setLegacy(true)
      else setError(subscriptionError(cause, '加载授权失败'))
      return false
    } finally {
      if (!controller.signal.aborted) setRefreshing(false)
    }
  }, [path, summaryPath, userId])
  useEffect(() => {
    void load()
    return () => active.current?.abort()
  }, [load])
  return { path, summaryPath, data, error, legacy, refreshing, load }
}

export function UserSubscriptionPlan({ user, details }: { user: UserSummary; details: ReturnType<typeof useBindingDetails> }) {
  const { data, path, summaryPath, load, refreshing } = details
  const [editor, setEditor] = useState<{ templateId: string }>()
  const [action, setAction] = useState<{ mode: keyof typeof actionLabel; templateId?: string; requestId: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copyError, setCopyError] = useState(false)
  const [preview, setPreview] = useState(false)
  if (details.legacy && !data) return <p role="status">订阅授权暂未开放</p>
  if (!data) return details.error
    ? <ErrorState message={details.error} onRetry={() => void load()} />
    : <LoadingState label="正在加载授权" />

  const { list, templates, summary } = data
  const bindings = list.bindings.filter(binding => binding.status !== 'revoked')
  const boundTemplates = templates.filter(template => bindings.some(binding => binding.templateId === template.id))
  const saved = () => { setEditor(undefined); void load() }
  const bindingName = (templateId: string) => {
    const template = templates.find(item => item.id === templateId)
    return template ? templateLabel(template, boundTemplates, bindings.find(binding => binding.templateId === templateId)) : templateId
  }
  const start = (mode: NonNullable<typeof action>['mode'], templateId?: string) => {
    setError('')
    setAction({ mode, templateId, requestId: crypto.randomUUID() })
  }
  async function saveAction() {
    if (!action || busy || refreshing) return
    setBusy(true)
    setError('')
    const expectedRevision = list.revision
    try {
      if (action.mode === 'reset') {
        await api(`${summaryPath}/reset-token`, { method: 'POST', body: jsonBody({ expectedRevision }) })
      } else {
        await api(`${path}/${encodeURIComponent(action.templateId ?? '')}`, {
          method: 'PUT', body: jsonBody({ expectedRevision, mode: action.mode, requestId: action.requestId }),
        })
      }
      setAction(undefined)
      await load()
    } catch (cause) {
      setError(subscriptionError(cause, '操作失败，请重试'))
      if (cause instanceof ApiClientError && cause.status === 409) await load()
    } finally {
      setBusy(false)
    }
  }

  const expiry = summary.latestExpiresAt
    ? <>{deadline(summary.latestExpiresAt)}{summary.permanent && <small className="binding-summary-note">另有永久授权</small>}</>
    : summary.permanent ? '永久' : summary.status === 'expired' && summary.lastExpiredAt
      ? <>{summaryStatus.expired}<small className="binding-summary-note">{deadline(summary.lastExpiredAt)}</small></>
      : summary.status === 'active' ? '—' : summaryStatus[summary.status]
  const actionsUnavailable = !user.enabled || Boolean(details.error)

  return <>
    {details.error && <ErrorState message={details.error} onRetry={() => void load()} />}
    <div className="binding-summary"><StatGroup items={[
      { id: 'effective', label: '有效授权', value: summary.effectiveBindingCount },
      { id: 'nodes', label: '聚合节点', value: summary.nodes.length },
      { id: 'expiry', label: '最晚到期', value: expiry },
    ]} /></div>
    <Section title="订阅链接" actions={<div className="content-toolbar-actions binding-section-actions">
      {summary.subscriptionUrl && <CopyButton key={summary.subscriptionUrl} value={summary.subscriptionUrl}
        label="复制统一订阅链接" variant="secondary" onError={() => setCopyError(true)} onCopied={() => setCopyError(false)} />}
      <Button variant="secondary" onClick={() => setPreview(true)}>节点预览</Button>
      {summary.subscriptionUrl && <RowActions label="订阅链接更多操作" actions={[
        { label: '重置链接', danger: true, disabled: actionsUnavailable, onClick: () => start('reset') },
      ]} />}
    </div>}>
      {copyError && <StatusMessage tone="error">复制失败，请重试</StatusMessage>}
    </Section>
    <Section title="已绑定模板" actions={<div className="content-toolbar-actions binding-section-actions">
      {user.enabled && <Link className="button secondary" to={`/delivery/templates?owner=${encodeURIComponent(user.id)}`}>新建专属模板</Link>}
      <Button variant="primary" disabled={actionsUnavailable} onClick={() => setEditor({ templateId: '' })}>绑定模板</Button>
    </div>}>
      <DataTable rows={bindings} rowKey={row => row.templateId} empty="暂无绑定模板"
        refreshingLabel={refreshing ? '正在刷新授权' : undefined} columns={[
          { key: 'template', header: '模板名称', render: row => bindingName(row.templateId) },
          { key: 'status', header: '状态', render: row => {
            const status = bindingState(row)
            return <StatusPill tone={status === '有效' ? 'success' : 'neutral'}>{status}</StatusPill>
          } },
          { key: 'expiresAt', header: '到期时间', render: row => deadline(row.expiresAt) },
        ]} rowActions={row => <div className="binding-row-actions">
          <Button variant="ghost" disabled={actionsUnavailable || row.templateStatus !== 'enabled'}
            onClick={() => setEditor({ templateId: row.templateId })}>更新绑定</Button>
          <RowActions label={`${bindingName(row.templateId)}更多操作`} actions={[
            row.status === 'paused'
              ? { label: '恢复', disabled: actionsUnavailable || row.templateStatus !== 'enabled', onClick: () => start('resume', row.templateId) }
              : { label: '暂停', disabled: actionsUnavailable, onClick: () => start('pause', row.templateId) },
            { label: '撤销', danger: true, disabled: actionsUnavailable, onClick: () => start('revoke', row.templateId) },
          ]} />
        </div>} />
    </Section>
    {editor && <BindingEditor path={path} templates={templates} bindings={bindings} revision={list.revision} templateId={editor.templateId} refreshing={refreshing}
      onClose={() => setEditor(undefined)} onSaved={saved} onConflict={load} />}
    <Dialog open={preview} title="节点预览" appearance="content" placement="end" onClose={() => setPreview(false)}>
      {preview && <DataTable rows={summary.nodes.map((node, index) => ({ ...node, index }))} rowKey={node => node.index} empty="暂无可用节点"
        columns={[{ key: 'name', header: '节点' }, { key: 'protocol', header: '协议' }]} />}
    </Dialog>
    {action && <ConfirmDialog open appearance="content" title={action.mode === 'reset' ? '重置订阅链接' : actionLabel[action.mode]}
      description={action.mode === 'reset' ? '旧链接将立即失效' : `此操作仅影响该用户的 ${bindingName(action.templateId ?? '')} 授权`}
      danger={action.mode === 'reset' || action.mode === 'revoke'} busy={busy} confirmDisabled={refreshing || Boolean(details.error)}
      confirmLabel={actionLabel[action.mode]} onClose={() => setAction(undefined)} onConfirm={saveAction}>
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {details.error && <ErrorState message={details.error} onRetry={() => void load()} />}
    </ConfirmDialog>}
  </>
}
