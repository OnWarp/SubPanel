import { useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DateTimeInput, FormSelect, FormStack, Input, Textarea } from '../../ui/Controls'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EditDrawer } from '../../ui/EditDrawer'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { entitlementTemplatesPath, nodePolicyLabel, quotaLabel, termLabel, type EntitlementTemplate, type EntitlementVersion } from '../delivery/entitlement-types'
import { batchesPath, errorText, recordsPath, useRedemptionPage, type RedemptionRecord } from './api'

type Batch = {
  id: string; name: string; templateName: string; templateVersion: number; quantity: number; usedCount: number
  maxUses: number; remaining: number; redeemDeadline: number; status: 'active' | 'disabled' | 'expired'
  createdBy: string; createdAt: string; note: string
}
type Code = { id: string; tail: string; usedCount: number; maxUses: number; revoked: number }
type AdminRecord = RedemptionRecord & { userId: string; tail: string; batchName: string }
type Audit = { id: string; actor: string; action: string; createdAt: string; detail: string }
type Release = { id: string; codes: string[] }
type Pending = { title: string; description: string; path: string }

const batchStatuses = { active: '启用', disabled: '已停用', expired: '已截止' }
const auditActions: Record<string, string> = {
  'redemption.batch.create': '生成批次', 'redemption.batch.release': '发放完整码',
  'redemption.batch.disable': '停用批次', 'redemption.code.revoke': '作废单码', 'redemption.confirm': '确认兑换',
}

function date(value: string | number) { return new Date(value).toLocaleString() }

function BatchEditor({ onClose, onRelease }: { onClose: () => void; onRelease: (result: Release) => void }) {
  const [templates, setTemplates] = useState<EntitlementTemplate[]>()
  const [templateId, setTemplateId] = useState('')
  const [selection, setSelection] = useState<{ templateId: string; versions: EntitlementVersion[] }>()
  const [versionId, setVersionId] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [uses, setUses] = useState('1')
  const [deadline, setDeadline] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [requestKey] = useState(() => crypto.randomUUID())
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    void api<{ templates: EntitlementTemplate[] }>(`${entitlementTemplatesPath}?status=enabled`, { signal: abort.signal })
      .then((result) => { if (!abort.signal.aborted) setTemplates(result.templates.filter((item) => item.allowRedemption)) })
      .catch((cause) => { if (!abort.signal.aborted) setError(errorText(cause)) })
    return () => abort.abort()
  }, [retry])

  useEffect(() => {
    if (!templateId) return
    const abort = new AbortController()
    void api<{ versions: EntitlementVersion[] }>(`${entitlementTemplatesPath}/${templateId}/versions`, { signal: abort.signal })
      .then((result) => {
        if (abort.signal.aborted) return
        setSelection({ templateId, versions: result.versions })
        setVersionId(result.versions[0]?.id ?? '')
      })
      .catch((cause) => { if (!abort.signal.aborted) setError(errorText(cause)) })
    return () => abort.abort()
  }, [templateId, retry])

  const versions = selection?.templateId === templateId ? selection.versions : []
  const config = versions.find((item) => item.id === versionId)?.config

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !config) return
    setBusy(true)
    setError('')
    try {
      onRelease(await api<Release>(batchesPath, { method: 'POST', body: jsonBody({
        name, note, templateVersionId: versionId, quantity: Number(quantity), maxUses: Number(uses),
        redeemDeadline: Date.parse(deadline), idempotencyKey: requestKey,
      }) }))
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return <EditDrawer open title="生成兑换码" busy={busy} dirty={!!(name || note || deadline || templateId || quantity !== '1' || uses !== '1')}
    onClose={onClose} footer={<>
      <button className="button secondary" type="button" disabled={busy} onClick={onClose}>取消</button>
      <button className="button primary" type="submit" form="redemption-batch-form" disabled={busy || !config}>生成</button>
    </>}>
    <form id="redemption-batch-form" onSubmit={(event) => { void submit(event) }}>
      <fieldset disabled={busy}>
        <FormStack>
          {error && <ErrorState message={error} onRetry={() => { setError(''); setRetry((value) => value + 1) }} />}
          {!templates && !error && <LoadingState label="正在加载订阅模板" />}
          {templates?.length === 0 && <StatusMessage tone="warning">请先启用允许兑换发放的订阅模板</StatusMessage>}
          <FormField label="批次名称" htmlFor="batch-name">
            <Input id="batch-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={128} required />
          </FormField>
          <FormField label="订阅模板" htmlFor="batch-template">
            <FormSelect id="batch-template" aria-label="订阅模板" value={templateId} required disabled={busy || !templates?.length}
              onChange={(event) => { setTemplateId(event.target.value); setVersionId(''); setSelection(undefined); setError('') }}>
              <option value="">选择模板</option>
              {templates?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </FormSelect>
          </FormField>
          {templateId && <FormField label="固定版本" htmlFor="batch-version"
            hint={config ? `${termLabel(config)} · ${quotaLabel(config)} · ${nodePolicyLabel(config)}` : undefined}>
            <FormSelect id="batch-version" aria-label="固定版本" value={versionId} disabled={busy || !versions.length}
              onChange={(event) => setVersionId(event.target.value)}>
              {versions.length === 0 && <option value="">正在加载版本</option>}
              {versions.map((item) => <option key={item.id} value={item.id}>{`v${item.number}`}</option>)}
            </FormSelect>
          </FormField>}
          <FormField label="生成数量" htmlFor="batch-quantity" hint="每批最多 500 个兑换码">
            <Input id="batch-quantity" type="number" min={1} max={500} required value={quantity} onChange={(event) => setQuantity(event.target.value)} />
          </FormField>
          <FormField label="每码使用次数" htmlFor="batch-uses" hint="每个账户对同一码最多兑换一次">
            <Input id="batch-uses" type="number" min={1} max={100} required value={uses} onChange={(event) => setUses(event.target.value)} />
          </FormField>
          <FormField label="兑换截止时间" htmlFor="batch-deadline">
            <DateTimeInput id="batch-deadline" required value={deadline} onChange={(event) => setDeadline(event.target.value)} />
          </FormField>
          <FormField label="备注" htmlFor="batch-note">
            <Textarea id="batch-note" maxLength={1000} rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          </FormField>
          <p className="sp-form-hint">最多发放 {Number(quantity) * Number(uses)} 份订阅 · 完整码仅在本次生成后显示</p>
        </FormStack>
      </fieldset>
    </form>
  </EditDrawer>
}

function ReleaseDrawer({ release, onClose }: { release: Release; onClose: () => void }) {
  const [exported, setExported] = useState(false)
  function download() {
    if (exported) return
    const blob = new Blob([`code\r\n${release.codes.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `redemption-${release.id}.csv`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setExported(true)
  }
  return <EditDrawer open title="兑换码已生成" onClose={onClose} dirty={!exported}
    footer={<button className="button primary" type="button" onClick={download} disabled={exported}>{exported ? '已导出 CSV' : '导出 CSV'}</button>}>
    <FormField label="完整兑换码" htmlFor="released-codes" hint="请妥善保存，关闭后只能查看尾码">
      <Textarea id="released-codes" readOnly autoComplete="off" spellCheck={false} rows={12} value={release.codes.join('\n')} />
    </FormField>
  </EditDrawer>
}

function PagedTable<T extends { id: string }>({ path, page, onPageChange, columns, empty, refresh }:
  { path: string; page: number; onPageChange: (page: number) => void; columns: DataTableColumn<T>[]; empty: string; refresh: number }) {
  const list = useRedemptionPage<T>(path, page, refresh)
  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />
  return <DataTable columns={columns} rows={list.data?.items ?? []} rowKey={(row) => row.id} empty={empty}
    loadingLabel={list.loading ? '正在加载' : undefined}
    pagination={list.data && list.data.total > list.data.pageSize ? {
      page, pageCount: Math.ceil(list.data.total / list.data.pageSize), onPageChange, compact: true,
    } : undefined} />
}

export function AdminRedemptionsPage() {
  const [search, setSearch] = useSearchParams()
  const batchId = search.get('batch') ?? ''
  const view = search.get('view') ?? (batchId ? 'codes' : 'batches')
  const page = Math.max(1, Math.trunc(Number(search.get('page')) || 1))
  const status = search.get('status') ?? ''
  const q = search.get('q') ?? ''
  const userId = search.get('user') ?? ''
  const [editing, setEditing] = useState(false)
  const [release, setRelease] = useState<Release>()
  const [pending, setPending] = useState<Pending>()
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<{ id: string; batch?: Batch; error?: string }>()

  function update(values: Record<string, string>, replace = false) {
    setSearch((previous) => {
      const next = new URLSearchParams(previous)
      if (!('page' in values)) next.delete('page')
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value)
        else next.delete(key)
      }
      return next
    }, { replace })
  }

  useEffect(() => {
    if (!batchId) return
    const abort = new AbortController()
    void api<{ batch: Batch }>(`${batchesPath}/${encodeURIComponent(batchId)}`, { signal: abort.signal })
      .then(({ batch }) => { if (!abort.signal.aborted) setDetail({ id: batchId, batch }) })
      .catch((cause) => { if (!abort.signal.aborted) setDetail({ id: batchId, error: errorText(cause) }) })
    return () => abort.abort()
  }, [batchId, refresh])

  async function confirm() {
    if (!pending || busy) return
    setBusy(true)
    setError('')
    try {
      await api(pending.path, { method: 'POST' })
      setPending(undefined)
      setRefresh((value) => value + 1)
    } catch (cause) {
      setError(errorText(cause))
      setPending(undefined)
    } finally {
      setBusy(false)
    }
  }

  const tableProps = { page, onPageChange: (value: number) => update({ page: String(value) }), refresh }
  const current = detail?.id === batchId ? detail : undefined
  const batch = current?.batch
  const disable = (item: Batch) => setPending({
    title: '停用兑换批次', description: '停用后，此批次停止接受兑换，已发放订阅继续有效',
    path: `${batchesPath}/${item.id}/disable`,
  })

  return <div className="page-stack resource-pages redemption-admin">
    <PageHeader title="兑换码管理" actions={<button className="button primary" type="button"
      onClick={() => setEditing(true)}>生成兑换码</button>} />
    <div className="redemption-actions"><Link className="button secondary" to="/delivery/subscriptions">返回订阅管理</Link></div>
    {error && <StatusMessage tone="error">{error}</StatusMessage>}
    {batchId && (current?.error ? <ErrorState message={current.error} onRetry={() => setRefresh((value) => value + 1)} />
      : !batch ? <LoadingState label="正在加载批次" /> : <section className="data-section redemption-section">
        <h2>{batch.name}</h2>
        <p>{batch.templateName} · v{batch.templateVersion} · {batchStatuses[batch.status]}</p>
        <p>共 {batch.quantity} 码 · 已兑 {batch.usedCount} 次 · 可兑 {batch.remaining} 次</p>
        <p>兑换截止 {date(batch.redeemDeadline)}</p>
        {batch.note && <p>{batch.note}</p>}
        <div className="redemption-actions">
          <button type="button" className="button secondary" onClick={() => update({ batch: '', view: '' })}>返回批次</button>
          {batch.status === 'active' && <button type="button" className="button danger" onClick={() => disable(batch)}>停用批次</button>}
        </div>
      </section>)}
    <section className="data-section redemption-section">
      <div className="redemption-actions" aria-label="兑换管理视图">
        {(batchId ? [['codes', '兑换码'], ['records', '兑换记录'], ['audit', '审计']]
          : [['batches', '批次'], ['records', '兑换记录']]).map(([key, label]) =>
          <button type="button" key={key} className={`button ${view === key ? 'primary' : 'secondary'}`}
            aria-pressed={view === key} onClick={() => update({ view: key })}>{label}</button>)}
      </div>
      {view === 'batches' && <>
        <FilterBar>
          <Input aria-label="搜索批次" placeholder="搜索批次" value={q} maxLength={100} onChange={(event) => update({ q: event.target.value }, true)} />
          <FormSelect aria-label="批次状态" value={status} onChange={(event) => update({ status: event.target.value })}>
            <option value="">全部状态</option><option value="active">启用</option><option value="disabled">已停用</option><option value="expired">已截止</option>
          </FormSelect>
        </FilterBar>
        <PagedTable<Batch> {...tableProps} path={`${batchesPath}?${new URLSearchParams({ q, ...(status ? { status } : {}) })}`} empty="没有匹配的批次"
          columns={[
            { key: 'name', header: '批次', render: (item) => <button type="button" className="button ghost" onClick={() => update({ batch: item.id, view: 'codes' })}>{item.name}</button> },
            { key: 'version', header: '模板版本', render: (item) => `${item.templateName} · v${item.templateVersion}` },
            { key: 'quantity', header: '码数' }, { key: 'usedCount', header: '已兑次数' }, { key: 'remaining', header: '可兑次数' },
            { key: 'deadline', header: '兑换截止', render: (item) => date(item.redeemDeadline) },
            { key: 'status', header: '状态', render: (item) => <StatusBadge tone={item.status === 'active' ? 'success' : 'muted'}>{batchStatuses[item.status]}</StatusBadge> },
            { key: 'createdBy', header: '创建人' },
          ]} />
      </>}
      {view === 'codes' && batch && <PagedTable<Code> {...tableProps} path={`${batchesPath}/${batch.id}/codes`} empty="暂无兑换码" columns={[
        { key: 'tail', header: '尾码', render: (item) => <code>••••-{item.tail}</code> },
        { key: 'used', header: '使用次数', render: (item) => `${item.usedCount} / ${item.maxUses}` },
        { key: 'status', header: '状态', render: (item) => item.revoked ? '已作废' : item.usedCount >= item.maxUses ? '已用尽' : batchStatuses[batch.status] },
        { key: 'actions', header: '操作', render: (item) => !item.revoked && item.usedCount < item.maxUses && batch.status === 'active'
          ? <button type="button" className="button secondary" onClick={() => setPending({
            title: `作废尾码 ${item.tail}`, description: '作废后，此码停止接受兑换，已发放订阅继续有效',
            path: `/api/admin/redemption-codes/${item.id}/revoke`,
          })}>作废</button> : null },
      ]} />}
      {view === 'records' && <>
        <FilterBar><Input aria-label="兑换用户 ID" placeholder="按用户 ID 筛选" value={userId} maxLength={100}
          onChange={(event) => update({ user: event.target.value }, true)} /></FilterBar>
        <PagedTable<AdminRecord> {...tableProps} path={`${recordsPath}?${new URLSearchParams({
          ...(batchId ? { batchId } : {}), ...(userId.trim() ? { userId: userId.trim() } : {}),
        })}`} empty="暂无兑换记录" columns={[
          { key: 'batchName', header: '批次' }, { key: 'tail', header: '尾码' }, { key: 'userId', header: '用户' },
          { key: 'subscriptionName', header: '订阅' }, { key: 'subscriptionId', header: '订阅 ID' },
          { key: 'redeemedAt', header: '兑换时间', render: (item) => date(item.redeemedAt) },
        ]} />
      </>}
      {view === 'audit' && batch && <PagedTable<Audit> {...tableProps} path={`${batchesPath}/${batch.id}/audit`} empty="暂无审计记录" columns={[
        { key: 'action', header: '动作', render: (item) => auditActions[item.action] ?? item.action },
        { key: 'actor', header: '操作人' }, { key: 'createdAt', header: '操作时间', render: (item) => date(item.createdAt) },
        { key: 'detail', header: '详情', render: (item) => <details><summary>查看</summary><code>{item.detail}</code></details> },
      ]} />}
    </section>
    {editing && <BatchEditor onClose={() => setEditing(false)} onRelease={(result) => {
      setEditing(false)
      setRelease(result)
      setRefresh((value) => value + 1)
      update({ batch: result.id, view: 'codes' })
    }} />}
    {release && <ReleaseDrawer release={release} onClose={() => setRelease(undefined)} />}
    <ConfirmDialog open={!!pending} title={pending?.title ?? ''} description={pending?.description ?? ''}
      confirmLabel="确认" danger busy={busy} onClose={() => setPending(undefined)} onConfirm={confirm} />
  </div>
}
