import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
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
  const [items, setItems] = useState<Notice[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<NoticeForm>(EMPTY_FORM)
  const [pendingDelete, setPendingDelete] = useState<Notice | null>(null)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ notices: Notice[] }>('/api/admin/notices')
      setItems(result.notices)
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
    <section className="data-section sys-section" aria-labelledby="sys-notices-title">
      <DataHeader
        id="sys-notices-title"
        title="公告"
        actions={<button className="button ghost" type="button" disabled={loading} onClick={() => { load().catch(() => undefined) }}>刷新</button>}
      />
      {loading ? <LoadingState label="正在加载公告" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError ? (
        <div className="sys-body">
          {items.length === 0 ? <p className="sys-hint">暂无公告</p> : (
            <ul className="sys-domain-list">
              {items.map((notice) => (
                <li key={notice.id} className="sys-domain-item ntc-admin-item">
                  <div className="ntc-admin-main">
                    <span className="ntc-admin-title">{notice.title}</span>
                    <span className="sys-invite-meta">
                      排序 {notice.sortOrder} · {notice.visible ? '显示中' : '已隐藏'} · {formatNoticeTime(notice.publishedAt)}
                    </span>
                  </div>
                  <div className="ntc-admin-actions">
                    <Switch
                      checked={notice.visible}
                      onChange={(checked) => { toggleVisible(notice, checked).catch(() => undefined) }}
                      disabled={busy}
                      ariaLabel={`${notice.visible ? '隐藏' : '显示'}公告 ${notice.title}`}
                    />
                    <button className="button ghost" type="button" disabled={busy} onClick={() => startEdit(notice)}>编辑</button>
                    <button className="button ghost" type="button" disabled={busy} onClick={() => setPendingDelete(notice)}>删除</button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form className="ntc-admin-form" onSubmit={save} noValidate>
            <h3 className="sys-subtitle">{editingId === null ? '新建公告' : '编辑公告'}</h3>
            <FormField label="标题" htmlFor="ntc-title">
              <input
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
              <textarea
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
                <input
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
                <input
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
        </div>
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
