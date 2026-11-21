import { OperationsActions, OperationsFooter, OperationsHeading } from '../admin/OperationsCard'
import { DataTable } from '../../ui/DataTable'
import { StatusBadge } from '../../ui/StatusBadge'
import { Input, Textarea, DateTimeInput } from '../../ui/Controls'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/Toast'
import { formatNoticeTime, type Notice } from '../notices/types'

type NoticeForm = {
  title: string
  body: string
  sortOrder: string
  visible: boolean
  publishedAt: string
}

const EMPTY_FORM: NoticeForm = {
  title: '',
  body: '',
  sortOrder: '0',
  visible: true,
  publishedAt: '',
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function toDateTimeInput(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function NoticesSection() {
  const noticeForm = useRef<HTMLFormElement>(null)
  const [items, setItems] = useState<Notice[]>(() => peekApi<{ notices: Notice[] }>('/api/admin/notices')?.notices ?? [])
  const [loading, setLoading] = useState(() => peekApi<{ notices: Notice[] }>('/api/admin/notices') === undefined)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<NoticeForm>(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<Notice | null>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi<{ notices: Notice[] }>('/api/admin/notices') === undefined)
    setLoadError('')
    try {
      await watchApi<{ notices: Notice[] }>('/api/admin/notices', (result) => {
        setItems(result.notices)
      })
    } catch (cause) {
      setItems([])
      setLoadError(errorMessage(cause, '加载公告失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const resetForm = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  const startEdit = (notice: Notice) => {
    setEditingId(notice.id)
    setForm({
      title: notice.title,
      body: notice.body,
      sortOrder: String(notice.sortOrder),
      visible: notice.visible,
      publishedAt: toDateTimeInput(notice.publishedAt),
    })
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    const title = form.title.trim()
    const body = form.body.trim()
    if (!title || !body) {
      toast.notifyError('请填写标题和正文')
      return
    }
    const parsedOrder = Number.parseInt(form.sortOrder, 10)
    const payload: Record<string, unknown> = {
      title,
      body,
      sortOrder: Number.isFinite(parsedOrder) && parsedOrder >= 0 ? parsedOrder : 0,
      visible: form.visible,
    }
    if (form.publishedAt) payload.publishedAt = new Date(form.publishedAt).toISOString()

    setBusy(true)
    try {
      if (editingId === null) {
        await api('/api/admin/notices', { method: 'POST', body: jsonBody(payload) })
        toast.notify('公告已发布')
      } else {
        await api(`/api/admin/notices/${editingId}`, { method: 'PUT', body: jsonBody(payload) })
        toast.notify('公告已更新')
      }
      resetForm()
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存公告失败'))
    } finally {
      setBusy(false)
    }
  }

  const toggleVisible = async (notice: Notice, visible: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api<{ notice: Notice }>(`/api/admin/notices/${notice.id}`, {
        method: 'PUT',
        body: jsonBody({ visible }),
      })
      setItems((current) => current.map((item) => item.id === result.notice.id ? result.notice : item))
      toast.notify(visible ? '公告已显示' : '公告已隐藏')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '更新公告失败'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!pendingDelete || busy) return
    setBusy(true)
    try {
      await api(`/api/admin/notices/${pendingDelete.id}`, { method: 'DELETE' })
      if (editingId === pendingDelete.id) resetForm()
      setPendingDelete(null)
      toast.notify('公告已删除')
      await load()
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '删除公告失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="data-section" aria-label="公告">
      <OperationsHeading title="公告" action={
        <>
          <button className="button ghost" type="button" disabled={loading} onClick={() => { load().catch(() => undefined) }}>刷新</button>
          <button className="button primary" type="button" disabled={loading || !!loadError || busy} onClick={() => { resetForm(); noticeForm.current?.querySelector<HTMLInputElement>('#ntc-title')?.focus() }}>新建公告</button>
        </>
      } />
      {loading ? <LoadingState label="正在加载公告" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError ? (
        <>
          <DataTable rows={items} rowKey={(notice) => notice.id} empty="暂无公告" columns={[
            { key: 'title', header: '公告', render: (notice) => <strong className="ops-main">{notice.title}<span className="ops-meta">{formatNoticeTime(notice.publishedAt)}</span></strong> },
            { key: 'sortOrder', header: '排序' },
            { key: 'visible', header: '状态', render: (notice) => <StatusBadge tone={notice.visible ? 'success' : 'muted'}>{notice.visible ? '显示中' : '已隐藏'}</StatusBadge> },
            { key: 'actions', header: '操作', align: 'right', render: (notice) => (
              <OperationsActions label={`管理公告 ${notice.title}`}>
                <button className="button ghost" type="button" disabled={busy} onClick={() => { startEdit(notice); noticeForm.current?.querySelector<HTMLInputElement>('#ntc-title')?.focus() }}>编辑</button>
                <button className="button ghost" type="button" disabled={busy} onClick={() => { void toggleVisible(notice, !notice.visible) }}>{notice.visible ? '隐藏' : '显示'}</button>
                <button className="button ghost" type="button" disabled={busy} onClick={() => setPendingDelete(notice)}>删除</button>
              </OperationsActions>
            ) },
          ]} />
          <OperationsFooter total={items.length} />

          <form ref={noticeForm} className="ntc-admin-form ops-group" onSubmit={save} noValidate>
            <h3 className="sys-subtitle">{editingId === null ? '新建公告' : '编辑公告'}</h3>
            <FormField label="标题" htmlFor="ntc-title">
              <Input
                id="ntc-title"
                type="text"
                maxLength={120}
                required
                value={form.title}
                disabled={busy}
                onChange={(event) => setForm({ ...form, title: event.currentTarget.value })}
              />
            </FormField>
            <FormField label="正文" htmlFor="ntc-body">
              <Textarea
                id="ntc-body"
                rows={5}
                maxLength={20_000}
                required
                value={form.body}
                disabled={busy}
                onChange={(event) => setForm({ ...form, body: event.currentTarget.value })}
              />
            </FormField>
            <div className="sys-grid">
              <FormField label="排序（越小越靠前）" htmlFor="ntc-sort">
                <Input
                  id="ntc-sort"
                  type="number"
                  min={0}
                  max={100000}
                  step={1}
                  inputMode="numeric"
                  value={form.sortOrder}
                  disabled={busy}
                  onChange={(event) => setForm({ ...form, sortOrder: event.currentTarget.value })}
                />
              </FormField>
              <FormField label="发布时间（留空为现在）" htmlFor="ntc-published">
                <DateTimeInput
                  id="ntc-published"
                  type="datetime-local"
                  value={form.publishedAt}
                  disabled={busy}
                  onChange={(event) => setForm({ ...form, publishedAt: event.currentTarget.value })}
                />
              </FormField>
              <FormField label="显示给用户">
                <Switch
                  checked={form.visible}
                  onChange={(checked) => setForm({ ...form, visible: checked })}
                  disabled={busy}
                  ariaLabel="显示给用户"
                />
              </FormField>
            </div>
            <p className="sys-hint">用户端只显示勾选「显示给用户」的公告，按排序和发布时间排列</p>
            <div className="sys-actions">
              {editingId !== null ? <button className="button ghost" type="button" disabled={busy} onClick={resetForm}>取消编辑</button> : null}
              <button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : editingId === null ? '发布公告' : '保存修改'}</button>
            </div>
          </form>
        </>
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除公告"
        description="删除后用户端不再显示，且无法恢复"
        confirmLabel="删除公告"
        danger
        busy={busy}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { remove().catch(() => undefined) }}
      />
    </section>
  )
}
