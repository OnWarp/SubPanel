import { Pencil, Plus, Power, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../ui/DataTable'
import { EditDrawer } from '../../ui/EditDrawer'
import { ErrorState } from '../../ui/ErrorState'
import { FilterBar } from '../../ui/FilterBar'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { SearchInput } from '../../ui/SearchInput'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'
import { formatDate } from './catalog-utils'

type PlatformName = 'windows' | 'macos' | 'android' | 'ios' | 'linux'
type EnabledFilter = 'all' | 'yes' | 'no'

type AdminPlatform = {
  id: string
  appId: string
  platform: PlatformName
  downloadUrl: string
  documentationUrl: string | null
  sortOrder: number
}

type AdminApp = {
  id: string
  name: string
  description: string
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
  platforms: AdminPlatform[]
}

type AppsResponse = {
  schemaVersion: number
  revision: number
  updatedAt: string | null
  apps: AdminApp[]
}

type PlatformFormRow = {
  platform: PlatformName
  downloadUrl: string
  documentationUrl: string
  sortOrder: string
}

type AppForm = {
  name: string
  description: string
  enabled: boolean
  sortOrder: string
  platforms: PlatformFormRow[]
}

type DrawerState = { mode: 'create' } | { mode: 'edit'; app: AdminApp }

const PAGE_SIZE = 10

const PLATFORM_OPTIONS: Array<{ value: PlatformName; label: string }> = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'android', label: 'Android' },
  { value: 'ios', label: 'iOS' },
  { value: 'linux', label: 'Linux' },
]

const PLATFORM_LABEL = new Map(PLATFORM_OPTIONS.map((item) => [item.value, item.label]))
const PLATFORM_RANK = new Map(PLATFORM_OPTIONS.map((item, index) => [item.value, index]))

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function isHttpsUrl(value: string) {
  return value.startsWith('https://') && value.length <= 2048 && !/[\s\\]/.test(value)
}

function emptyPlatformRow(platform: PlatformName = 'windows'): PlatformFormRow {
  return { platform, downloadUrl: '', documentationUrl: '', sortOrder: '' }
}

function emptyForm(): AppForm {
  return { name: '', description: '', enabled: true, sortOrder: '0', platforms: [emptyPlatformRow()] }
}

function formFromApp(app: AdminApp): AppForm {
  return {
    name: app.name,
    description: app.description,
    enabled: app.enabled,
    sortOrder: String(app.sortOrder),
    platforms: [...app.platforms]
      .sort((left, right) => (PLATFORM_RANK.get(left.platform) ?? 99) - (PLATFORM_RANK.get(right.platform) ?? 99))
      .map((platform) => ({
        platform: platform.platform,
        downloadUrl: platform.downloadUrl,
        documentationUrl: platform.documentationUrl ?? '',
        sortOrder: String(platform.sortOrder),
      })),
  }
}

function validateForm(form: AppForm): string {
  if (!form.name.trim()) return '请填写 APP 名称'
  const appSort = Number(form.sortOrder)
  if (form.sortOrder.trim() === '' || !Number.isInteger(appSort) || appSort < 0 || appSort > 1_000_000) return '排序必须是 0 到 1000000 的整数'
  if (form.platforms.length === 0) return '至少配置一个平台'
  const seen = new Set<PlatformName>()
  for (const row of form.platforms) {
    if (seen.has(row.platform)) return '同一 APP 不能重复配置相同平台'
    seen.add(row.platform)
    if (!isHttpsUrl(row.downloadUrl.trim())) return `${PLATFORM_LABEL.get(row.platform)} 的下载链接必须是 https 链接`
    const doc = row.documentationUrl.trim()
    if (doc && !isHttpsUrl(doc)) return `${PLATFORM_LABEL.get(row.platform)} 的文档链接必须是 https 链接`
    if (row.sortOrder.trim() !== '') {
      const value = Number(row.sortOrder)
      if (!Number.isInteger(value) || value < 0 || value > 1_000_000) return '平台排序必须是 0 到 1000000 的整数'
    }
  }
  return ''
}

export function AppsPage() {
  const [catalog, setCatalog] = useState<AppsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all')
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [form, setForm] = useState<AppForm>(emptyForm)
  const [drawerError, setDrawerError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<AdminApp | null>(null)
  const [busy, setBusy] = useState(false)
  const createButton = useRef<HTMLButtonElement>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setError('')
    try {
      const next = await api<AppsResponse>('/api/admin/apps')
      setCatalog(next)
      return next
    } catch (cause) {
      setError(errorMessage(cause, '加载 APP 失败'))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const apps = useMemo(() => [...(catalog?.apps ?? [])].sort((left, right) => left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name, 'zh-CN')
    || left.id.localeCompare(right.id)), [catalog])

  const filtered = useMemo(() => apps.filter((app) => {
    const text = `${app.name} ${app.description}`.toLowerCase()
    if (query.trim() && !text.includes(query.trim().toLowerCase())) return false
    if (enabledFilter === 'yes' && !app.enabled) return false
    if (enabledFilter === 'no' && app.enabled) return false
    return true
  }), [apps, enabledFilter, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page])

  useEffect(() => { setPage(1) }, [enabledFilter, query])
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  const openCreate = () => {
    setForm(emptyForm())
    setDrawerError('')
    setDrawer({ mode: 'create' })
  }

  const openEdit = (app: AdminApp) => {
    setForm(formFromApp(app))
    setDrawerError('')
    setDrawer({ mode: 'edit', app })
  }

  const closeDrawer = () => {
    if (busy) return
    setDrawer(null)
    setDrawerError('')
  }

  const updateRow = (index: number, patch: Partial<PlatformFormRow>) => {
    setForm((current) => ({
      ...current,
      platforms: current.platforms.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    }))
  }

  const addRow = () => {
    setForm((current) => {
      if (current.platforms.length >= PLATFORM_OPTIONS.length) return current
      const used = new Set(current.platforms.map((row) => row.platform))
      const next = PLATFORM_OPTIONS.find((item) => !used.has(item.value))?.value ?? 'windows'
      return { ...current, platforms: [...current.platforms, emptyPlatformRow(next)] }
    })
  }

  const removeRow = (index: number) => {
    setForm((current) => ({ ...current, platforms: current.platforms.filter((_, rowIndex) => rowIndex !== index) }))
  }

  const saveApp = async (event: FormEvent) => {
    event.preventDefault()
    const problem = validateForm(form)
    if (problem) {
      setDrawerError(problem)
      return
    }
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      enabled: form.enabled,
      sortOrder: Number(form.sortOrder),
      platforms: form.platforms.map((row) => ({
        platform: row.platform,
        downloadUrl: row.downloadUrl.trim(),
        ...(row.documentationUrl.trim() ? { documentationUrl: row.documentationUrl.trim() } : {}),
        ...(row.sortOrder.trim() !== '' ? { sortOrder: Number(row.sortOrder) } : {}),
      })),
    }
    setBusy(true)
    setDrawerError('')
    try {
      if (drawer?.mode === 'edit') {
        await api(`/api/admin/apps/${drawer.app.id}`, { method: 'PUT', body: jsonBody(body) })
        toast.notify('APP 已保存')
      } else {
        await api('/api/admin/apps', { method: 'POST', body: jsonBody(body) })
        toast.notify('APP 已添加')
      }
      setDrawer(null)
      await load()
    } catch (cause) {
      setDrawerError(errorMessage(cause, '保存 APP 失败'))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async (app: AdminApp) => {
    setBusy(true)
    try {
      await api(`/api/admin/apps/${app.id}/enabled`, { method: 'POST', body: jsonBody({ enabled: !app.enabled }) })
      toast.notify(app.enabled ? 'APP 已停用' : 'APP 已启用')
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '切换启用状态失败'))
    } finally {
      setBusy(false)
    }
  }

  const removeApp = async () => {
    if (!pendingDelete) return
    setBusy(true)
    try {
      await api(`/api/admin/apps/${pendingDelete.id}`, { method: 'DELETE' })
      toast.notify('APP 已删除')
      if (drawer?.mode === 'edit' && drawer.app.id === pendingDelete.id) setDrawer(null)
      setPendingDelete(null)
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '删除 APP 失败'))
    } finally {
      setBusy(false)
    }
  }

  const columns: Array<DataTableColumn<AdminApp>> = [
    {
      key: 'name',
      header: '名称',
      render: (app) => (
        <span className="app-identity">
          <strong>{app.name}</strong>
          {app.description ? <span className="app-desc" title={app.description}>{app.description}</span> : null}
        </span>
      ),
    },
    {
      key: 'platforms',
      header: '平台',
      render: (app) => (
        <span className="app-badges">
          {[...app.platforms]
            .sort((left, right) => (PLATFORM_RANK.get(left.platform) ?? 99) - (PLATFORM_RANK.get(right.platform) ?? 99))
            .map((platform) => <StatusBadge key={platform.id} tone="info" size="sm">{PLATFORM_LABEL.get(platform.platform)}</StatusBadge>)}
          {app.platforms.length === 0 ? <span className="app-desc">未配置</span> : null}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: '状态',
      render: (app) => <StatusBadge tone={app.enabled ? 'success' : 'muted'} size="sm">{app.enabled ? '启用' : '停用'}</StatusBadge>,
    },
    { key: 'sortOrder', header: '排序', align: 'right', render: (app) => app.sortOrder },
    { key: 'updatedAt', header: '更新时间', render: (app) => formatDate(app.updatedAt) },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (app) => (
        <span className="row-actions">
          <button className="icon-button" type="button" aria-label={`${app.enabled ? '停用' : '启用'} ${app.name}`} title={app.enabled ? '停用' : '启用'} disabled={busy} onClick={() => { toggleEnabled(app).catch(() => undefined) }}><Power aria-hidden="true" size={16} /></button>
          <button className="icon-button" type="button" aria-label={`编辑 ${app.name}`} title="编辑" disabled={busy} onClick={() => openEdit(app)}><Pencil aria-hidden="true" size={16} /></button>
          <button className="icon-button danger" type="button" aria-label={`删除 ${app.name}`} title="删除" disabled={busy} onClick={() => setPendingDelete(app)}><Trash2 aria-hidden="true" size={16} /></button>
        </span>
      ),
    },
  ]

  const description = catalog ? `${apps.length} 个 APP · 维护名称、简介与各平台下载配置` : '维护名称、简介与各平台下载配置'

  return (
    <div className="page-stack app-page">
      <PageHeader
        title="APP 管理"
        description={description}
        actions={<button ref={createButton} className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加 APP</button>}
      />
      <section className="data-section app-data" aria-label="APP 列表">
        {loading ? <LoadingState label="正在加载 APP" /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {!loading && !error ? (
          <>
            <FilterBar>
              <SearchInput className="app-search" label="搜索 APP" placeholder="搜索名称或简介" value={query} onChange={setQuery} />
              <div className="app-chip-group" role="group" aria-label="按启用筛选">
                <span className="app-chip-label">启用</span>
                <FilterChip active={enabledFilter === 'all'} onClick={() => setEnabledFilter('all')}>全部</FilterChip>
                <FilterChip active={enabledFilter === 'yes'} onClick={() => setEnabledFilter('yes')}>启用</FilterChip>
                <FilterChip active={enabledFilter === 'no'} onClick={() => setEnabledFilter('no')}>停用</FilterChip>
              </div>
            </FilterBar>
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={(app) => app.id}
              empty="没有符合筛选条件的 APP"
              pagination={filtered.length > 0 ? { page, pageCount, onPageChange: setPage } : undefined}
            />
          </>
        ) : null}
      </section>

      <EditDrawer open={drawer !== null} title={drawer?.mode === 'create' ? '添加 APP' : '编辑 APP'} busy={busy} size="large" onClose={closeDrawer} returnFocusRef={createButton}>
        <form className="app-form" autoComplete="off" onSubmit={saveApp}>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="app-form-grid">
            <FormField label="名称" htmlFor="app-name">
              <input id="app-name" value={form.name} maxLength={128} disabled={busy} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} />
            </FormField>
            <FormField label="排序" htmlFor="app-sort">
              <input id="app-sort" inputMode="numeric" value={form.sortOrder} disabled={busy} onChange={(event) => setForm({ ...form, sortOrder: event.currentTarget.value })} />
            </FormField>
            <FormField label="简介" htmlFor="app-description">
              <textarea id="app-description" className="app-span-2" rows={3} maxLength={8000} value={form.description} disabled={busy} onChange={(event) => setForm({ ...form, description: event.currentTarget.value })} />
            </FormField>
            <label className="app-flag">
              <input type="checkbox" checked={form.enabled} disabled={busy} onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })} />
              启用
            </label>
          </div>

          <div className="app-platforms">
            <div className="app-platforms-heading">
              <h3>平台配置</h3>
              <button className="button secondary" type="button" disabled={busy || form.platforms.length >= PLATFORM_OPTIONS.length} onClick={addRow}><Plus aria-hidden="true" size={15} />添加平台</button>
            </div>
            <p className="app-note">每个平台配置一个下载链接，文档链接可选；下载与文档链接都必须是 https 链接</p>
            <div className="app-platform-list">
              {form.platforms.map((row, index) => (
                <div className="app-platform-card" key={index}>
                  <FormField label="平台" htmlFor={`app-platform-${index}`}>
                    <select id={`app-platform-${index}`} value={row.platform} disabled={busy} onChange={(event) => updateRow(index, { platform: event.currentTarget.value as PlatformName })}>
                      {PLATFORM_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </FormField>
                  <FormField label="下载链接" htmlFor={`app-download-${index}`}>
                    <input id={`app-download-${index}`} value={row.downloadUrl} placeholder="https://…" disabled={busy} onChange={(event) => updateRow(index, { downloadUrl: event.currentTarget.value })} />
                  </FormField>
                  <FormField label="文档链接（可选）" htmlFor={`app-doc-${index}`}>
                    <input id={`app-doc-${index}`} value={row.documentationUrl} placeholder="https://…" disabled={busy} onChange={(event) => updateRow(index, { documentationUrl: event.currentTarget.value })} />
                  </FormField>
                  <FormField label="排序" htmlFor={`app-platform-sort-${index}`}>
                    <input id={`app-platform-sort-${index}`} inputMode="numeric" value={row.sortOrder} disabled={busy} onChange={(event) => updateRow(index, { sortOrder: event.currentTarget.value })} />
                  </FormField>
                  <button className="icon-button danger" type="button" aria-label="移除平台配置" title="移除" disabled={busy} onClick={() => removeRow(index)}><Trash2 aria-hidden="true" size={16} /></button>
                </div>
              ))}
              {form.platforms.length === 0 ? <p className="app-note">尚未配置平台，保存前至少添加一个平台</p> : null}
            </div>
          </div>

          <div className="app-form-actions">
            <button className="button secondary" type="button" onClick={closeDrawer} disabled={busy}>取消</button>
            <button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : drawer?.mode === 'create' ? '保存 APP' : '保存修改'}</button>
          </div>
        </form>
      </EditDrawer>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除 APP"
        description={pendingDelete ? `将删除「${pendingDelete.name}」及其全部平台配置，此操作无法撤销` : '将删除该 APP 及其全部平台配置'}
        confirmLabel="确认删除"
        danger
        busy={busy}
        onClose={() => { if (!busy) setPendingDelete(null) }}
        onConfirm={() => { removeApp().catch(() => undefined) }}
        returnFocusRef={createButton}
      />
    </div>
  )
}
