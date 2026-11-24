import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiClientError, jsonBody, type UserSummary } from '../../app/api'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { FormSelect, Input } from '../../ui/Controls'
import { DataTable } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { StatusMessage } from '../../ui/StatusMessage'
import { entitlementTemplatesPath, type EntitlementTemplate } from './entitlement-types'
import { formatExpiryTime } from './expiry'
import { SubscriptionDetailRows } from './SubscriptionDetailRows'
import { subscriptionError, type SubscriptionNode } from './unified-subscription'

type Binding = { templateId: string; expiresAt: string | null; startsAt: string; status: 'active' | 'paused' | 'revoked'; templateStatus?: EntitlementTemplate['status'] }
type BindingList = { revision: number; bindings: Binding[] }
type Change = { before: Binding | null; after: Binding }
export type AdminSubscriptionSummary = {
  expiresAt: string | null
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

function BindingEditor({ path, bindings, templates, revision, templateId, onClose, onSaved, onConflict }: {
  path: string
  bindings: Binding[]
  templates: EntitlementTemplate[]
  revision: number
  templateId: string
  onClose: () => void
  onSaved: () => void
  onConflict: () => void
}) {
  const [selected, setSelected] = useState(templateId)
  const [query, setQuery] = useState('')
  const [expiry, setExpiry] = useState('default')
  const [time, setTime] = useState('')
  const [mode, setMode] = useState('assign')
  const [previous, setPrevious] = useState('')
  const [changes, setChanges] = useState<Change[]>()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [requestId] = useState(() => crypto.randomUUID())
  const candidates = templates.filter(template => template.status === 'enabled')
  const visible = candidates.filter(template => template.id === selected || template.name.toLowerCase().includes(query.trim().toLowerCase()))
  const replacing = mode === 'replace' || mode === 'replaceAll'
  const duplicate = bindings.some(binding => binding.templateId === selected)
  const expiresAt = Date.parse(time)
  const canPreview = Boolean(selected) && (mode !== 'replace' || Boolean(previous)) && (expiry !== 'absolute' || Number.isFinite(expiresAt))
  const templatePath = `${path}/${encodeURIComponent(selected)}`
  const name = (id: string) => templates.find(template => template.id === id)?.name ?? '模板'

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
      setConfirm(false)
      onSaved()
    } catch (cause) {
      setConfirm(false)
      setConflict(cause instanceof ApiClientError && cause.code === 'BINDING_CONFLICT')
      setError(subscriptionError(cause, cause instanceof ApiClientError ? cause.message : '授权操作失败'))
    } finally {
      setBusy(false)
    }
  }

  const clearReview = () => { setChanges(undefined); setError('') }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!canPreview || conflict || busy) return
    if (changes && mode === 'replaceAll') setConfirm(true)
    else void perform(Boolean(changes))
  }

  return <>
    <Dialog open title={duplicate ? '更新绑定' : '绑定模板'} size="l" busy={busy} dirty={selected !== templateId || expiry !== 'default' || mode !== 'assign' || !!time}
      onClose={onClose} footer={<Button form="binding-form" type="submit" variant="primary" disabled={busy || conflict || !canPreview}>{changes ? '保存' : '预览影响'}</Button>}>
      <form id="binding-form" className="sp-form-stack" onSubmit={submit} onChange={clearReview}>
        <FormField label="搜索模板" htmlFor="binding-search"><Input id="binding-search" value={query} disabled={busy} onChange={event => setQuery(event.currentTarget.value)} /></FormField>
        <FormField label="模板" htmlFor="binding-template"><FormSelect id="binding-template" disabled={busy} value={selected}
          onChange={event => { setSelected(event.currentTarget.value); setPrevious(''); clearReview() }}>
          <option value="">选择模板</option>
          {visible.map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
        </FormSelect></FormField>
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
          {changes.map(({ after }) => <div key={after.templateId}><dt>{name(after.templateId)}</dt>
            <dd>{bindingState(after)}{after.status !== 'revoked' && ` · ${deadline(after.expiresAt)}`}</dd></div>)}
        </dl>}
        {conflict ? <ErrorState message="授权已更新，请刷新后重试" onRetry={onConflict} /> : error && <StatusMessage tone="error">{error}</StatusMessage>}
      </form>
    </Dialog>
    <ConfirmDialog open={confirm} title="替换全部授权" description="其他已绑定模板的授权将撤销" confirmLabel="替换全部" danger busy={busy}
      onClose={() => setConfirm(false)} onConfirm={() => perform(true)} />
  </>
}

export function useBindingDetails(userId: string) {
  const userPath = `/api/admin/users/${encodeURIComponent(userId)}`
  const path = `${userPath}/template-bindings`
  const summaryPath = `${userPath}/subscription`
  const [data, setData] = useState<{ list: BindingList; templates: EntitlementTemplate[]; summary: AdminSubscriptionSummary }>()
  const [error, setError] = useState('')
  const [legacy, setLegacy] = useState(false)
  const active = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController()
    active.current = controller
    setError('')
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
    } catch (cause) {
      if (controller.signal.aborted) return
      if (cause instanceof ApiClientError && cause.status === 404 && cause.code === 'SUBSCRIPTION_NOT_FOUND') setLegacy(true)
      else setError(subscriptionError(cause, '加载授权失败'))
    }
  }, [path, summaryPath, userId])
  useEffect(() => {
    void load()
    return () => active.current?.abort()
  }, [load])
  return { path, summaryPath, data, error, legacy, load }
}

export function UserSubscriptionPlan({ user, details }: { user: UserSummary; details: ReturnType<typeof useBindingDetails> }) {
  const { data, path, summaryPath, load } = details
  const [editor, setEditor] = useState<{ templateId: string }>()
  const [action, setAction] = useState<{ mode: 'reset' | 'pause' | 'resume' | 'revoke'; templateId?: string; requestId: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState(false)
  if (details.legacy) return <p role="status">订阅授权暂未开放</p>
  if (details.error) return <ErrorState message={details.error} onRetry={() => void load()} />
  if (!data) return <LoadingState label="正在加载授权" />
  const { list, templates, summary } = data
  const bindings = list.bindings.filter(binding => binding.status !== 'revoked')
  const saved = () => { setEditor(undefined); void load() }
  const start = (mode: NonNullable<typeof action>['mode'], templateId?: string) => {
    setError('')
    setAction({ mode, templateId, requestId: crypto.randomUUID() })
  }
  async function saveAction() {
    if (!action || !data) return
    setBusy(true)
    setError('')
    const expectedRevision = data.list.revision
    try {
      if (action.mode === 'reset') {
        await api(`${summaryPath}/reset-token`, { method: 'POST', body: jsonBody({ expectedRevision }) })
      } else {
        await api(`${path}/${encodeURIComponent(action.templateId ?? '')}`, {
          method: 'PUT', body: jsonBody({ expectedRevision, mode: action.mode, requestId: action.requestId }),
        })
      }
      await load()
      setAction(undefined)
    } catch (cause) {
      setError(subscriptionError(cause, '操作失败，请重试'))
      setAction(undefined)
      if (cause instanceof ApiClientError && cause.status === 409) void load()
    } finally {
      setBusy(false)
    }
  }

  return <>
    <SubscriptionDetailRows {...summary} />
    <div className="upd-import-actions">
      <Button variant="primary" disabled={!user.enabled} onClick={() => setEditor({ templateId: '' })}>绑定模板</Button>
      {user.enabled && <Link className="button secondary" to={`/delivery/templates?owner=${encodeURIComponent(user.id)}`}>新建专属模板</Link>}
    </div>
    {error && <ErrorState message={error} onRetry={() => { setError(''); void load() }} />}
    <DataTable rows={bindings} rowKey={row => row.templateId} empty="暂无绑定模板" columns={[
      { key: 'template', header: '已绑定模板', render: row => templates.find(template => template.id === row.templateId)?.name ?? '模板' },
      { key: 'status', header: '状态', render: bindingState },
      { key: 'expiresAt', header: '到期时间', render: row => deadline(row.expiresAt) },
      { key: 'actions', header: '操作', render: row => <div className="upd-import-actions">
        <Button variant="ghost" disabled={!user.enabled || row.templateStatus !== 'enabled'} onClick={() => setEditor({ templateId: row.templateId })}>更新</Button>
        <Button variant="ghost" disabled={!user.enabled || (row.status === 'paused' && row.templateStatus !== 'enabled')}
          onClick={() => start(row.status === 'paused' ? 'resume' : 'pause', row.templateId)}>{row.status === 'paused' ? '恢复' : '暂停'}</Button>
        <Button variant="ghost" disabled={!user.enabled} onClick={() => start('revoke', row.templateId)}>撤销</Button>
      </div> },
    ]} />
    <div className="upd-import-actions">
      {summary.subscriptionUrl && <>
        <CopyButton value={summary.subscriptionUrl} label="复制统一订阅链接" />
        <Button variant="secondary" onClick={() => start('reset')}>重置链接</Button>
      </>}
      <Button variant="secondary" onClick={() => setPreview(true)}>节点预览</Button>
    </div>
    {editor && <BindingEditor path={path} templates={templates} bindings={bindings} revision={list.revision} templateId={editor.templateId}
      onClose={() => setEditor(undefined)} onSaved={saved} onConflict={saved} />}
    <Dialog open={preview} title="节点预览" onClose={() => setPreview(false)}>
      {preview && <DataTable rows={summary.nodes.map((node, index) => ({ ...node, index }))} rowKey={node => node.index} empty="暂无可用节点"
        columns={[{ key: 'name', header: '节点' }, { key: 'protocol', header: '协议' }]} />}
    </Dialog>
    <ConfirmDialog open={!!action} title={action?.mode === 'reset' ? '重置订阅链接' : '更新订阅授权'}
      description={action?.mode === 'reset' ? '旧链接将立即失效' : '确认修改此模板的授权状态'}
      danger={action?.mode === 'reset' || action?.mode === 'revoke'} busy={busy} confirmLabel="确认" onClose={() => setAction(undefined)} onConfirm={saveAction} />
  </>
}
