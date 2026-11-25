import { Button } from '../../ui/Button'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import { api, ApiClientError, jsonBody, type CatalogResponse } from '../../app/api'
import { Checkbox, FormSelect, Input } from '../../ui/Controls'
import { AdvancedFields, FormField, FormGroup } from '../../ui/FormField'
import { DetailList } from '../../ui/DetailList'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { Dialog } from '../../ui/Dialog'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { SearchInput } from '../../ui/SearchInput'
import { FilterBar } from '../../ui/FilterBar'
import { ResourceRowActions } from '../admin-resources/ResourceCard'
import { formatDate } from '../catalog/catalog-utils'
import { NodeAssignmentPicker } from './NodeAssignmentPicker'
import {
  BYTES_PER_GIB, ENTITLEMENT_STATUS, MAX_QUOTA_GIB, TERM_UNITS, entitlementTemplatesPath, nodePolicyLabel, quotaLabel, termLabel,
  type EntitlementConfig, type EntitlementTemplate, type EntitlementVersion,
} from './entitlement-types'

type Draft = Pick<EntitlementTemplate, 'name' | 'description' | 'allowRedemption'> & { config: EntitlementConfig }
const emptyDraft: Draft = {
  name: '', description: '', allowRedemption: false,
  config: { duration: { value: 1, unit: 'month' }, quotaBytes: null, resetPolicy: 'none', groupIds: [], nodeIds: [], limits: { speedLimitMbps: 0 } },
}
type Editor = { original?: EntitlementTemplate; draft: Draft }
type History = { template: EntitlementTemplate; versions?: EntitlementVersion[]; error?: string }
type Pending = { template: EntitlementTemplate; action: 'disable' | 'archive' }
const errors = (error: unknown) => error instanceof ApiClientError ? error.message : '操作失败，请重试'

function configFields(config: EntitlementConfig, catalog: CatalogResponse | null): Record<string, string> {
  return {
    有效期: termLabel(config),
    流量额度: quotaLabel(config),
    流量重置: '不重置',
    动态分组: config.groupIds.map((id) => catalog?.groups.find((item) => item.id === id)?.name ?? id).join('、') || '无',
    指定节点: config.nodeIds.map((id) => catalog?.nodes.find((item) => item.id === id)?.displayName ?? id).join('、') || '无',
    限速: config.limits.speedLimitMbps ? `${config.limits.speedLimitMbps} Mbps` : '不限',
  }
}

export function EntitlementTemplatesPage() {
  const [params] = useSearchParams()
  const owner = params.get('owner')
  const navigate = useNavigate()
  const closeEditor = () => {
    setEditor(null)
    if (owner) navigate(`/users/${encodeURIComponent(owner)}?tab=subscription`)
  }
  const [templates, setTemplates] = useState<EntitlementTemplate[]>([])
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<Editor | null>(() => owner ? { draft: emptyDraft } : null)
  const [history, setHistory] = useState<History | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [quota, setQuota] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const [{ templates }, catalog] = await Promise.all([
        api<{ templates: EntitlementTemplate[] }>(entitlementTemplatesPath),
        api<CatalogResponse>('/api/admin/catalog'),
      ])
      setTemplates(templates)
      setCatalog(catalog)
    } catch (error) {
      setLoadError(errors(error))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  function openEditor(original?: EntitlementTemplate) {
    const draft = original ? {
      name: original.name, description: original.description, allowRedemption: original.allowRedemption, config: original.currentVersion.config,
    } : emptyDraft
    setError('')
    setQuota(draft.config.quotaBytes === null ? '' : String(draft.config.quotaBytes / BYTES_PER_GIB))
    setEditor({ original, draft })
  }

  function changeDraft(input: Partial<Draft>) {
    setEditor((current) => current && { ...current, draft: { ...current.draft, ...input } })
  }

  function changeConfig(input: Partial<EntitlementConfig>) {
    if (editor) changeDraft({ config: { ...editor.draft.config, ...input } })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!editor) return
    const { original, draft } = editor
    if (!draft.config.groupIds.length && !draft.config.nodeIds.length) {
      setError('请选择节点或动态分组')
      return
    }
    setError('')
    setBusy(true)
    try {
      const createPath = owner ? `/api/admin/users/${encodeURIComponent(owner)}/template-bindings/private-template` : entitlementTemplatesPath
      await api(original ? `${entitlementTemplatesPath}/${original.id}` : createPath, {
        method: original ? 'PATCH' : 'POST',
        body: jsonBody({ ...draft, expectedRevision: original?.revision }),
      })
      closeEditor()
      if (!owner) await load()
    } catch (error) {
      setError(errors(error))
    } finally {
      setBusy(false)
    }
  }

  async function mutate(template: EntitlementTemplate, action: 'enable' | 'disable' | 'archive' | 'copy') {
    const path = `${entitlementTemplatesPath}/${template.id}`
    setError('')
    setBusy(true)
    try {
      const result = await api<{ template: EntitlementTemplate }>(action === 'copy' ? `${path}/copy` : path, {
        method: action === 'copy' ? 'POST' : action === 'archive' ? 'DELETE' : 'PATCH',
        body: jsonBody(action === 'copy' ? {} : {
          expectedRevision: template.revision,
          status: action === 'archive' ? undefined : action === 'enable' ? 'enabled' : 'disabled',
        }),
      })
      setPending(null)
      await load()
      if (action === 'copy') openEditor(result.template)
    } catch (error) {
      setError(errors(error))
    } finally {
      setBusy(false)
    }
  }

  async function openHistory(template: EntitlementTemplate) {
    setHistory({ template })
    try {
      const { versions } = await api<{ versions: EntitlementVersion[] }>(`${entitlementTemplatesPath}/${template.id}/versions`)
      setHistory((current) => current?.template.id === template.id ? { template, versions } : current)
    } catch (error) {
      setHistory((current) => current?.template.id === template.id ? { template, error: errors(error) } : current)
    }
  }

  const columns: DataTableColumn<EntitlementTemplate>[] = [
    { key: 'name', header: '名称' },
    { key: 'resources', header: '资源数', render: ({ currentVersion: { config } }) => config.groupIds.length + config.nodeIds.length },
    { key: 'boundUserCount', header: '绑定用户数', align: 'right' },
    { key: 'term', header: '默认时长', render: ({ currentVersion }) => termLabel(currentVersion.config) },
    { key: 'status', header: '状态', render: ({ status }) => <StatusBadge tone={status === 'enabled' ? 'success' : 'muted'} size="sm">{ENTITLEMENT_STATUS[status]}</StatusBadge> },
    { key: 'actions', header: '操作', align: 'right', render: (template) =>
      <ResourceRowActions actions={[
        ...(template.status === 'archived' ? [] : [
          { label: '编辑', onClick: () => openEditor(template) },
          { label: template.status === 'enabled' ? '停用' : '启用', onClick: () => {
            if (template.status === 'enabled') { setError(''); setPending({ template, action: 'disable' }) }
            else void mutate(template, 'enable')
          } },
          { label: '归档', onClick: () => { setError(''); setPending({ template, action: 'archive' }) } },
        ]),
        { label: '复制', onClick: () => { void mutate(template, 'copy') } },
        { label: '版本历史', onClick: () => { void openHistory(template) } },
      ].map((action) => ({ ...action, disabled: busy }))} /> },
  ]
  const draft = editor?.draft
  const config = draft?.config
  const original = editor?.original
  const configChanged = !!original && JSON.stringify(config) !== JSON.stringify(original.currentVersion.config)
  const baseDraft = original ? { name: original.name, description: original.description, allowRedemption: original.allowRedemption, config: original.currentVersion.config } : emptyDraft
  const visible = templates.filter((template) => (!status || template.status === status) && template.name.toLowerCase().includes(query.trim().toLowerCase()))
  const createButton = <Button variant="primary" size="page" onClick={() => openEditor()}><Plus aria-hidden size={18} />新建模板</Button>

  return (
    <section className="page-stack del-templates-page" aria-label="订阅模板">
      <PageHeader title="权益模板" />
      {error && !editor && !pending && <StatusMessage tone="error">{error}</StatusMessage>}
      {loading ? <LoadingState label="正在加载订阅模板" /> : loadError ? <ErrorState message={loadError} onRetry={() => { void load() }} /> :
        templates.length === 0 ? <><EmptyState title="暂无订阅模板">{createButton}</EmptyState></> : <>
          <FilterBar className="del-template-filters">
            <SearchInput value={query} onChange={setQuery} label="搜索模板" placeholder="搜索模板名称" />
            <FormSelect aria-label="模板状态" value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
              <option value="">全部状态</option>
              {Object.entries(ENTITLEMENT_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </FormSelect>
            {createButton}
          </FilterBar>
          <DataTable columns={columns} rows={visible} rowKey={({ id }) => id} empty="没有匹配的订阅模板" className="del-template-table" />
        </>}
      <Dialog size="l" appearance="content" open={!!editor} title={original ? '编辑权益模板' : owner ? '新建专属模板' : '新建权益模板'} busy={busy}
        dirty={!!draft && JSON.stringify(draft) !== JSON.stringify(baseDraft)} onClose={closeEditor}
        footer={(requestClose) => <>
          {configChanged && original ? <span className="sp-form-hint" role="status">{`保存后，${original.boundUserCount} 位已绑定用户立即按最新配置交付，授权起止时间不变`}</span> : null}
          <button className="button secondary" type="button" disabled={busy} onClick={requestClose}>取消</button>
          <button className="button primary" form="entitlement-template-form" type="submit" disabled={busy}>保存模板</button>
        </>}>
        {draft && config && <form id="entitlement-template-form" className="drawer-form" onSubmit={save}>
          {!original && owner ? <p className="sp-form-hint">创建后回到订阅授权，需要再绑定才生效</p> : null}
          <FormGroup title="基本信息">
            <FormField label="模板名称" htmlFor="entitlement-name"><Input id="entitlement-name" required maxLength={128} value={draft.name}
              onChange={(event) => changeDraft({ name: event.currentTarget.value })} /></FormField>
            <FormField label="管理员备注" htmlFor="entitlement-description"><Input id="entitlement-description" maxLength={2000} value={draft.description}
              onChange={(event) => changeDraft({ description: event.currentTarget.value })} /></FormField>
          </FormGroup>
          <FormGroup title="有效期与流量">
            <div className="content-form-grid">
              <FormField label="期限" htmlFor="entitlement-duration"><Input id="entitlement-duration" required type="number" min={1} max={36_500} step={1}
                value={config.duration.value || ''} onChange={(event) => changeConfig({ duration: { ...config.duration, value: Number(event.currentTarget.value) } })} /></FormField>
              <FormField label="单位" htmlFor="entitlement-unit"><FormSelect id="entitlement-unit" value={config.duration.unit}
                onChange={(event) => changeConfig({ duration: { ...config.duration, unit: event.currentTarget.value as keyof typeof TERM_UNITS } })}>
                {Object.entries(TERM_UNITS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
              </FormSelect></FormField>
            </div>
            <FormField label="流量 GiB" htmlFor="entitlement-quota" hint="留空为不限，只记录额度且不重置"><Input id="entitlement-quota" type="number" min={1 / BYTES_PER_GIB} max={MAX_QUOTA_GIB} step="any"
              value={quota} onChange={(event) => {
                const value = event.currentTarget.value
                setQuota(value)
                changeConfig({ quotaBytes: value ? Math.round(Number(value) * BYTES_PER_GIB) : null })
              }} /></FormField>
          </FormGroup>
          <FormGroup title="节点分配">
            <fieldset className="choice-section"><legend>动态分组</legend>
              <div className="choice-list">{catalog?.groups.map((group) => <label className="choice-row" key={group.id}>
                <Checkbox checked={config.groupIds.includes(group.id)} aria-label={`使用分组 ${group.name}`} onChange={() => changeConfig({
                  groupIds: config.groupIds.includes(group.id) ? config.groupIds.filter((id) => id !== group.id) : [...config.groupIds, group.id],
                })} /><span>{group.name}</span>
              </label>)}</div>
              {!catalog?.groups.length && <p className="drawer-note">暂无分组</p>}
            </fieldset>
            <NodeAssignmentPicker nodes={catalog?.nodes ?? []} selected={config.nodeIds} onChange={(nodeIds) => changeConfig({ nodeIds })} />
          </FormGroup>
          <AdvancedFields label="高级限制">
            <FormField label="限速 Mbps" htmlFor="entitlement-speed" hint="0 为不限，仅适用部分 Hysteria 客户端">
              <Input id="entitlement-speed" type="number" min={0} max={1_000_000} step={1} value={config.limits.speedLimitMbps}
                onChange={(event) => changeConfig({ limits: { speedLimitMbps: Number(event.currentTarget.value) } })} />
            </FormField>
          </AdvancedFields>
          <FormGroup title="发放设置">
            <label className="choice-row"><Checkbox disabled={!!owner || !!original?.ownerUserId} checked={draft.allowRedemption}
              onChange={(event) => changeDraft({ allowRedemption: event.currentTarget.checked })} />开放兑换码发放</label>
          </FormGroup>
          <p className="drawer-note">{termLabel(config)} · {quotaLabel(config)} · {nodePolicyLabel(config)}</p>
          {error && <StatusMessage tone="error">{error}</StatusMessage>}
        </form>}
      </Dialog>
      <Dialog size="l" appearance="content" open={!!history} title={history ? `${history.template.name} · 版本历史` : '版本历史'} onClose={() => setHistory(null)}>
        <p className="sp-form-hint">已绑定用户读取最新版，这里只展示历史配置</p>
        {history?.error && <ErrorState message={history.error} onRetry={() => { void openHistory(history.template) }} />}
        {history && !history.versions && !history.error && <LoadingState label="正在加载版本" />}
        {history?.versions?.map((version, index, versions) => {
          const previous = versions[index + 1]
          const before = previous ? configFields(previous.config, catalog) : {}
          const fields = configFields(version.config, catalog)
          return <details className="content-version" key={version.id} open={index === 0 || undefined}>
            <summary>v{version.number} · {formatDate(version.createdAt)} · {version.subscriptionCount} 个订阅</summary>
            <p className="drawer-note">修改人 {version.createdBy}</p>
            <DetailList items={Object.entries(fields).map(([field, value]) => ({
              id: field,
              label: field,
              value: previous && before[field] !== value ? `${before[field]} → ${value}` : value,
            }))} />
          </details>
        })}
      </Dialog>
      <ConfirmDialog open={!!pending} appearance="content" title={pending?.action === 'archive' ? '归档模板' : '停用模板'}
        description={error || `将影响 ${pending?.template.boundUserCount ?? 0} 位已绑定用户`}
        confirmLabel={pending?.action === 'archive' ? '确认归档' : '确认停用'} danger busy={busy}
        onClose={() => { setPending(null); setError('') }}
        onConfirm={() => { if (pending) void mutate(pending.template, pending.action) }} />
    </section>
  )
}
