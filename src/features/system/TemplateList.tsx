import { EmptyState } from '../../ui/EmptyState'
import { useEffect, useState } from 'react'
import {
  api, peekApi, peekSubscriptionTemplates, readData, watchApi, ApiClientError, jsonBody, loadSubscriptionTemplates, loadTemplateSubscriptions, subscriptionTemplatesPath as ROOT,
  type SubscriptionTemplate, type TemplateBinding, type TemplateDefaultWrite, type TemplateDraftWrite, type TemplateReference,
  type TemplateRollback, type TemplateVersion, type TemplateVersionPage,
} from '../../app/api'
import { ResourceRowActions } from '../admin-resources/ResourceCard'
import { FormSelect, Input } from '../../ui/Controls'
import { DataHeader } from '../../ui/DataHeader'
import { Dialog } from '../../ui/Dialog'
import { FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'
import { referenceCount, templateDate, templateError, templateStatus, versionLabel } from './template-display'

type ListProps = {
  archived: boolean
  onArchived: (show: boolean) => void
  onOpen: (id: string, preview?: boolean) => void
}

type ListAction =
  | { kind: 'default'; id: string; revision: number; impact: number | null }
  | { kind: 'copy' | 'archive' | 'history'; row: SubscriptionTemplate }

async function countInherited() {
  const subscriptions = await loadTemplateSubscriptions()
  let count = 0
  // The list provides the count only when a template is already the default.
  for (let start = 0; start < subscriptions.length; start += 8) {
    const bindings = await Promise.all(subscriptions.slice(start, start + 8).map(({ id }) =>
      api<TemplateBinding>(`${ROOT}/bindings/${encodeURIComponent(id)}`)))
    count += bindings.filter((binding) => binding.mode === 'inherit').length
  }
  return count
}

export function TemplateList({ archived, onArchived, onOpen }: ListProps) {
  const [data, setData] = useState(() => peekSubscriptionTemplates())
  const [archivedRows, setArchivedRows] = useState(() => archived ? peekSubscriptionTemplates(true)?.templates : undefined)
  const [action, setAction] = useState<ListAction>()
  const [copyName, setCopyName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const toast = useToast()

  const load = async () => {
    setData(await loadSubscriptionTemplates())
    if (archived) setArchivedRows((await loadSubscriptionTemplates(true)).templates)
  }

  useEffect(() => {
    let active = true
    setLoadError('')
    setArchivedRows(archived ? peekSubscriptionTemplates(true)?.templates : undefined)
    void readData((read) => Promise.all([loadSubscriptionTemplates(false, read), archived ? loadSubscriptionTemplates(true, read) : undefined]),
      ([next, history]) => {
        if (active) { setData(next); setArchivedRows(history?.templates) }
      }).catch((cause) => { if (active) setLoadError(templateError(cause)) })
    return () => { active = false }
  }, [archived])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await operation() }
    catch (cause) {
      const refs = cause instanceof ApiClientError && cause.code === 'TEMPLATE_REFERENCED'
        ? (cause.details as { references?: TemplateReference } | undefined)?.references
        : undefined
      setError(refs ? `${templateError(cause)}（直接绑定 ${refs.directBindings}，继承默认 ${refs.inheritedCount}${refs.isDefault ? '，当前为默认配置' : ''}）` : templateError(cause))
      if (action?.kind === 'default') toast.notifyError(templateError(cause))
    } finally { setBusy(false) }
  }

  const changeDefault = (id: string) => {
    if (!data) return
    const current = data.templates.find((row) => row.id === data.defaultId)
    const pending: ListAction = { kind: 'default', id, revision: data.defaultRevision, impact: current?.references.inheritedCount ?? null }
    setAction(pending)
    setError('')
    if (pending.impact === null) void run(async () => setAction({ ...pending, impact: await countInherited() }))
  }

  const submit = () => {
    if (!action) return
    void run(async () => {
      if (action.kind === 'default') {
        const result = await api<TemplateDefaultWrite>(`${ROOT}/default`, {
          method: 'PUT', body: jsonBody({ templateId: action.id || null, expectedRevision: action.revision }),
        })
        setData((current) => current && {
          ...current, defaultId: action.id || null, defaultRevision: result.revision,
          templates: current.templates.map((row) => ({
            ...row, references: { ...row.references, isDefault: row.id === action.id, inheritedCount: row.id === action.id ? result.inheritedCount : 0 },
          })),
        })
        toast.notify('默认配置已保存')
      } else if (action.kind === 'copy') {
        const result = await api<TemplateDraftWrite>(`${ROOT}/${encodeURIComponent(action.row.id)}/copy`, {
          method: 'POST', body: jsonBody({ name: copyName }),
        })
        toast.notify('已复制为新配置')
        onOpen(result.id)
      } else if (action.kind === 'archive') {
        await api(`${ROOT}/${encodeURIComponent(action.row.id)}/archive`, {
          method: 'POST', body: jsonBody({ expectedRevision: action.row.revision }),
        })
        setData((current) => current && { ...current, templates: current.templates.filter((row) => row.id !== action.row.id) })
        toast.notify('配置已归档')
      }
      setAction(undefined)
    })
  }

  const rows = archived ? archivedRows : data?.templates
  const dialogTitle = action?.kind === 'default' ? '更改默认配置' : action?.kind === 'archive' ? '归档配置' : '复制为新配置'
  const nextDefault = action?.kind === 'default' ? data?.templates.find((row) => row.id === action.id) : undefined

  return <>
    <DataHeader title="附加配置" actions={<button className="button primary" type="button" onClick={() => onOpen('new')}>新增配置</button>} />
    <div className="template-list-controls">
      <FormField label="默认配置" htmlFor="template-default">
        <FormSelect id="template-default" value={data?.defaultId ?? ''} disabled={!data || busy} onChange={(event) => changeDefault(event.currentTarget.value)}>
          <option value="">基础配置</option>
          {data?.templates.filter((row) => row.publishedVersionId).map((row) =>
            <option key={row.id} value={row.id}>{row.name} · {versionLabel(row.publishedSequence)}</option>)}
        </FormSelect>
      </FormField>
      <button className="button secondary" type="button" onClick={() => onArchived(!archived)}>{archived ? '查看未归档' : '查看已归档'}</button>
    </div>
    {loadError ? <div className="template-actions"><StatusMessage tone="error">{loadError}</StatusMessage>
      <button className="button secondary" type="button" onClick={() => void load().then(() => setLoadError('')).catch((cause) => setLoadError(templateError(cause)))}>重试</button></div>
      : !rows ? <p role="status">正在加载附加配置</p>
      : rows.length === 0 ? <EmptyState title={archived ? '暂无已归档配置' : '暂无附加配置'}>
        {!archived && <button className="button secondary" type="button" onClick={() => onOpen('new')}>新增配置</button>}</EmptyState>
      : <table className="template-table" aria-label="附加配置列表">
        <thead><tr>{['名称', '状态', '当前发布版本', '更新时间', '引用数', '操作'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <th scope="row">{row.name}</th>
          <td data-label="状态">{templateStatus[row.status]}</td>
          <td data-label="当前发布版本">{versionLabel(row.publishedSequence)}</td>
          <td data-label="更新时间"><time dateTime={row.updatedAt}>{templateDate(row.updatedAt)}</time></td>
          <td data-label="引用数">{referenceCount(row.references)}</td>
          <td><div className="template-actions">
            <button className="button secondary" type="button" disabled={row.status === 'archived'} onClick={() => onOpen(row.id)}>编辑</button>
            <ResourceRowActions actions={[
              { label: '预览', onClick: () => onOpen(row.id, true) },
              { label: '版本历史', onClick: () => setAction({ kind: 'history', row }) },
              { label: '复制为新配置', onClick: () => { setError(''); setCopyName(`${row.name.slice(0, 124)} 副本`); setAction({ kind: 'copy', row }) } },
              { label: '归档', danger: true, disabled: row.status === 'archived', onClick: () => { setError(''); setAction({ kind: 'archive', row }) } },
            ]} />
          </div></td>
        </tr>)}</tbody>
      </table>}
    {action?.kind === 'history' && <TemplateHistory row={action.row} onClose={() => setAction(undefined)} onRollback={(version, result) => {
      setData((current) => current && { ...current, templates: current.templates.map((row) => row.id === action.row.id
        ? { ...row, publishedVersionId: version.id, publishedSequence: version.sequence, revision: result.revision, references: result.references }
        : row) })
      void load().catch((cause) => toast.notifyError(templateError(cause)))
    }} />}
    <Dialog open={Boolean(action && action.kind !== 'history')} title={dialogTitle} onClose={() => { if (!busy) setAction(undefined) }}
      footer={<>
        <button className="button secondary" type="button" disabled={busy} onClick={() => setAction(undefined)}>取消</button>
        <button className="button primary" type="button" disabled={busy || (action?.kind === 'default' && action.impact === null) || (action?.kind === 'copy' && !copyName.trim())} onClick={submit}>
          {busy ? '处理中' : dialogTitle}
        </button>
      </>}>
      {action?.kind === 'default' && <div className="form-stack">
        <p>将默认配置更改为 {nextDefault ? `${nextDefault.name} · ${versionLabel(nextDefault.publishedSequence)}` : '基础配置'}。</p>
        {action.impact === null ? <p>{busy ? '正在统计继承默认的订阅' : '无法统计继承默认的订阅'}</p> : <p>将影响 {action.impact} 条继承默认的订阅。</p>}
      </div>}
      {action?.kind === 'archive' && <p>归档「{action.row.name}」？</p>}
      {action?.kind === 'copy' && <FormField label="新配置名称" htmlFor="template-copy-name">
        <Input id="template-copy-name" maxLength={128} value={copyName} onChange={(event) => setCopyName(event.currentTarget.value)} />
      </FormField>}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
    </Dialog>
  </>
}

function TemplateHistory({ row, onClose, onRollback }: {
  row: SubscriptionTemplate
  onClose: () => void
  onRollback: (version: TemplateVersion, result: TemplateRollback) => void
}) {
  const [page, setPage] = useState(1)
  const path = `${ROOT}/${encodeURIComponent(row.id)}/versions?page=${page}&pageSize=20`
  const [result, setResult] = useState(() => peekApi<TemplateVersionPage>(path))
  const [selected, setSelected] = useState<TemplateVersion>()
  const [current, setCurrent] = useState({ id: row.publishedVersionId, revision: row.revision })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    const abort = new AbortController()
    void watchApi<TemplateVersionPage>(path, setResult, { signal: abort.signal }).catch((cause) => { if (!abort.signal.aborted) setError(templateError(cause)) })
    return () => abort.abort()
  }, [path])

  const rollback = async () => {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      const next = await api<TemplateRollback>(`${ROOT}/${encodeURIComponent(row.id)}/rollback`, {
        method: 'POST', body: jsonBody({ versionId: selected.id, expectedRevision: current.revision }),
      })
      setCurrent({ id: next.versionId, revision: next.revision })
      setSelected(undefined)
      onRollback(selected, next)
      toast.notify(`已回退至 ${versionLabel(selected.sequence)}`)
    } catch (cause) { setError(templateError(cause)) }
    finally { setBusy(false) }
  }

  return <Dialog open title={`${row.name} · 版本历史`} onClose={() => { if (!busy) onClose() }}
    footer={selected && <>
      <button className="button secondary" type="button" disabled={busy} onClick={() => setSelected(undefined)}>取消回退</button>
      <button className="button primary" type="button" disabled={busy} onClick={() => void rollback()}>确认回退至 {versionLabel(selected.sequence)}</button>
    </>}>
    {error && <StatusMessage tone="error">{error}</StatusMessage>}
    {!result && !error && <p role="status">正在加载版本</p>}
    {result?.total === 0 && <p>暂无发布版本</p>}
    {result && <div className="form-stack">
      {result.versions.map((version) => <div className="template-history-row" key={version.id}>
        <span>{versionLabel(version.sequence)} · {templateDate(version.createdAt)}</span>
        {version.id === current.id ? <span>当前发布</span> : row.status !== 'archived' &&
          <button className="button secondary" type="button" disabled={busy || Boolean(selected)} onClick={() => { setError(''); setSelected(version) }}>回退</button>}
      </div>)}
      {result.total > result.pageSize && <div className="template-actions">
        <button className="button secondary" type="button" disabled={busy || page === 1} onClick={() => { setError(''); setResult(undefined); setPage(page - 1) }}>上一页</button>
        <button className="button secondary" type="button" disabled={busy || page * result.pageSize >= result.total} onClick={() => { setError(''); setResult(undefined); setPage(page + 1) }}>下一页</button>
      </div>}
      {selected && <p>将生效版本切换为 {versionLabel(selected.sequence)}，影响 {referenceCount(row.references)} 条订阅。</p>}
    </div>}
  </Dialog>
}
