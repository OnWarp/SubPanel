import { CheckCircle2, Copy, Eye, KeyRound, Pencil, Plus, QrCode, Trash2, XCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody, type AdminSubscription, type CatalogGroup, type CatalogResponse, type UserSummary } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { BatchToolbar, type BatchAction } from '../../ui/BatchToolbar'
import { DataHeader } from '../../ui/DataHeader'
import { PageHeader } from '../../ui/PageHeader'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EditDrawer } from '../../ui/EditDrawer'
import { StatusMessage } from '../../ui/StatusMessage'
import { DiagnosticList } from './DiagnosticList'
import { DIAGNOSTIC_HELP } from './diagnostics'
import { formatDate } from '../catalog/catalog-utils'
import { subscriptionCounts } from '../catalog/catalog-counts'

type SubscriptionForm = {
  userId: string
  name: string
  groupIds: string[]
  defaultClient: string
  enabled: boolean
}

type DrawerState = 'create' | { kind: 'edit' | 'details'; subscription: AdminSubscription }
type ConfirmAction = 'disable' | 'delete'

const CLIENTS = ['mihomo', 'singbox', 'surge', 'loon', 'quantumultx', 'v2rayn', 'nekobox', 'shadowrocket', 'generic'] as const
const CLIENT_LABELS: Record<string, string> = {
  auto: '自动识别',
  mihomo: 'Mihomo',
  clash: 'Clash',
  'clash-meta': 'Clash Meta',
  stash: 'Stash',
  singbox: 'sing-box',
  karing: 'Karing',
  surge: 'Surge',
  loon: 'Loon',
  quantumultx: 'Quantumult X',
  v2rayn: 'v2rayN',
  nekobox: 'NekoBox',
  shadowrocket: 'Shadowrocket',
  generic: '通用 URI',
}
const EMPTY_SUBSCRIPTIONS: AdminSubscription[] = []
const EMPTY_GROUPS: CatalogGroup[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
}

export function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>(EMPTY_SUBSCRIPTIONS)
  const [users, setUsers] = useState<UserSummary[]>([])
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [tokenNotice, setTokenNotice] = useState<{ name: string; token: string; warning: string } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [drawer, setDrawer] = useState<DrawerState | null>(null)
  const [form, setForm] = useState<SubscriptionForm>({ userId: '', name: '', groupIds: [], defaultClient: 'mihomo', enabled: true })
  const [drawerError, setDrawerError] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [progress, setProgress] = useState('')
  const [qr, setQr] = useState<{ client: string; link: string; dataUrl: string; loading: boolean } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [subscriptionResult, userResult, nextCatalog] = await Promise.all([
        api<{ subscriptions: AdminSubscription[] }>('/api/admin/subscriptions'),
        api<{ users: UserSummary[] }>('/api/admin/users'),
        api<CatalogResponse>('/api/admin/catalog'),
      ])
      setSubscriptions(subscriptionResult.subscriptions)
      setUsers(userResult.users)
      setCatalog(nextCatalog)
      setSelected((current) => new Set([...current].filter((id) => subscriptionResult.subscriptions.some((subscription) => subscription.id === id))))
    } catch (cause) {
      setError(errorMessage(cause, '加载订阅失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const groups = catalog?.groups ?? EMPTY_GROUPS
  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.username])), [users])
  const groupNames = useMemo(() => new Map(groups.map((group) => [group.id, group.name])), [groups])
  const counts = useMemo(() => new Map(subscriptions.map((subscription) => [subscription.id, subscriptionCounts(subscription, groups, catalog?.sources ?? [], catalog?.nodes ?? [])])), [catalog, groups, subscriptions])

  const openCreate = () => {
    setForm({ userId: users[0]?.id ?? '', name: '', groupIds: [], defaultClient: 'mihomo', enabled: true })
    setDrawerError('')
    setDrawer('create')
  }

  const openEdit = (subscription: AdminSubscription) => {
    setForm({ userId: subscription.userId, name: subscription.name, groupIds: [...subscription.groupIds], defaultClient: subscription.defaultClient, enabled: subscription.enabled })
    setDrawerError('')
    setDrawer({ kind: 'edit', subscription })
  }

  const closeDrawer = () => {
    if (!busy) {
      setDrawer(null)
      setQr(null)
      setDrawerError('')
    }
  }

  const showQr = async (client: string, link: string) => {
    setQr({ client, link, dataUrl: '', loading: true })
    try {
      const { default: QRCode } = await import('qrcode')
      const dataUrl = await QRCode.toDataURL(link, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      setQr({ client, link, dataUrl, loading: false })
    } catch {
      setQr(null)
      setDrawerError('二维码生成失败')
    }
  }

  const saveSubscription = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!drawer) return
    setDrawerError('')
    if (!form.userId || !form.name.trim()) {
      setDrawerError('请选择用户并填写订阅名称')
      return
    }
    setBusy(true)
    try {
      if (drawer === 'create') {
        const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>('/api/admin/subscriptions', {
          method: 'POST',
          body: jsonBody(form),
        })
        setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
        setMessage('订阅已添加')
      } else if (drawer.kind === 'edit') {
        const result = await api<{ subscription: AdminSubscription; warning: string }>(`/api/admin/subscriptions/${drawer.subscription.id}`, {
          method: 'PATCH',
          body: jsonBody({ name: form.name, groupIds: form.groupIds, defaultClient: form.defaultClient, enabled: form.enabled }),
        })
        setMessage(`订阅已更新。${result.warning}`)
      }
      setDrawer(null)
      await load()
    } catch (cause) {
      setDrawerError(errorMessage(cause, '保存订阅失败'))
    } finally {
      setBusy(false)
    }
  }

  const copyText = async (value: string, success: string) => {
    try {
      await copyToClipboard(value)
      setMessage(success)
      setError('')
    } catch {
      setMessage('')
      setError('浏览器未允许复制，请手动选择内容')
    }
  }

  const resetToken = async (subscription: AdminSubscription) => {
    if (busy) return
    setBusy(true)
    setDrawerError('')
    try {
      const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>(`/api/admin/subscriptions/${subscription.id}/token/reset`, { method: 'POST', body: '{}' })
      setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
      setDrawer({ kind: 'details', subscription: result.subscription })
      setMessage('订阅令牌已重置')
      await load()
    } catch (cause) {
      setDrawerError(errorMessage(cause, '重置令牌失败'))
    } finally {
      setBusy(false)
    }
  }

  const executeBatch = async (action: ConfirmAction | 'enable') => {
    const ids = [...selected]
    if (!ids.length) return
    setConfirmAction(null)
    setBusy(true)
    setError('')
    setMessage('')
    const failed = new Set<string>()
    let firstFailure = ''
    try {
      for (const [index, id] of ids.entries()) {
        setProgress(`正在处理 ${index + 1}/${ids.length}`)
        try {
          if (action === 'delete') await api(`/api/admin/subscriptions/${id}`, { method: 'DELETE' })
          else await api(`/api/admin/subscriptions/${id}`, { method: 'PATCH', body: jsonBody({ enabled: action === 'enable' }) })
        } catch (cause) {
          failed.add(id)
          if (!firstFailure) firstFailure = errorMessage(cause, '请求失败')
        }
      }
      await load()
      setSelected(failed)
      if (firstFailure) setError(`${failed.size} 项未完成：${firstFailure}`)
      else setMessage(action === 'delete' ? '订阅已删除' : '批量操作已完成')
    } catch (cause) {
      setError(errorMessage(cause, '批量操作失败'))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const actions: BatchAction[] = [
    { key: 'enable', label: '启用', icon: CheckCircle2, onClick: () => executeBatch('enable') },
    { key: 'disable', label: '停用', icon: XCircle, tone: 'danger', onClick: () => setConfirmAction('disable') },
    { key: 'delete', label: '删除', icon: Trash2, tone: 'danger', onClick: () => setConfirmAction('delete') },
  ]

  const details = drawer !== null && drawer !== 'create' && drawer.kind === 'details' ? drawer.subscription : null

  return (
    <div className="page-stack">
      <PageHeader title="订阅" description={`${subscriptions.length} 个订阅 · ${subscriptions.filter((subscription) => subscription.enabled).length} 个启用`} actions={<button className="button primary" type="button" onClick={openCreate}><Plus aria-hidden="true" size={17} />添加订阅</button>} />

      {tokenNotice ? <section className="token-strip" aria-label="新订阅令牌"><div><strong>{tokenNotice.name} 的新令牌</strong><span>{tokenNotice.warning}</span></div><input aria-label="新订阅令牌" value={tokenNotice.token} readOnly /><button className="icon-button" type="button" aria-label="复制新订阅令牌" title="复制令牌" onClick={() => copyText(tokenNotice.token, '令牌已复制')}><Copy aria-hidden="true" size={17} /></button></section> : null}
      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => load()}>重试</button></div> : null}
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      <section className="data-section" aria-labelledby="subscriptions-title">
        <DataHeader id="subscriptions-title" title="订阅列表" actions={<BatchToolbar selectedCount={selected.size} totalCount={subscriptions.length} onSelectAll={() => setSelected(new Set(subscriptions.map((subscription) => subscription.id)))} onClear={() => setSelected(new Set())} actions={actions} busy={busy} progress={progress} />} />
        <div className="table-scroll">
          <table>
            <thead><tr><th className="check-cell"><input type="checkbox" aria-label="选择全部订阅" checked={subscriptions.length > 0 && selected.size === subscriptions.length} disabled={busy} onChange={(event) => setSelected(event.currentTarget.checked ? new Set(subscriptions.map((subscription) => subscription.id)) : new Set())} /></th><th>名称</th><th>用户</th><th>分组数</th><th>来源数</th><th>节点数</th><th>默认客户端</th><th>状态</th><th>修订</th><th>更新时间</th><th className="align-right">操作</th></tr></thead>
            <tbody>
              {loading && subscriptions.length === 0 ? <tr><td colSpan={11} className="empty-row">正在加载订阅</td></tr> : null}
              {!loading && subscriptions.length === 0 ? <tr><td colSpan={11} className="empty-row">暂无订阅</td></tr> : null}
              {subscriptions.map((subscription) => <tr key={subscription.id}>
                <td className="check-cell"><input type="checkbox" aria-label={`选择订阅 ${subscription.name}`} checked={selected.has(subscription.id)} disabled={busy} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(subscription.id)) next.delete(subscription.id); else next.add(subscription.id); return next })} /></td>
                <td><strong>{subscription.name}</strong><span className="cell-note">{subscription.tokenPrefix}…</span></td>
                <td>{userNames.get(subscription.userId) ?? subscription.userId}</td>
                <td>{counts.get(subscription.id)?.groups ?? 0}</td>
                <td>{counts.get(subscription.id)?.sources ?? 0}</td>
                <td>{counts.get(subscription.id)?.nodes ?? 0}</td>
                <td>{CLIENT_LABELS[subscription.defaultClient] ?? subscription.defaultClient}</td>
                <td><span className={`status ${subscription.enabled ? 'success' : 'muted'}`}><i />{subscription.enabled ? '正常' : '已停用'}</span></td>
                <td>{subscription.revision}</td>
                <td>{formatDate(subscription.updatedAt)}</td>
                <td className="align-right"><span className="row-actions"><button className="icon-button" type="button" aria-label="查看详情" title="查看详情" onClick={() => { setDrawerError(''); setDrawer({ kind: 'details', subscription }) }}><Eye aria-hidden="true" size={16} /></button><button className="icon-button" type="button" aria-label="编辑" title="编辑" onClick={() => openEdit(subscription)}><Pencil aria-hidden="true" size={16} /></button><button className="icon-button danger" type="button" aria-label="删除" title="删除" onClick={() => { setSelected(new Set([subscription.id])); setConfirmAction('delete') }}><Trash2 aria-hidden="true" size={16} /></button></span></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>

      <EditDrawer open={drawer === 'create' || (drawer !== null && drawer.kind === 'edit')} title={drawer === 'create' ? '添加订阅' : '编辑订阅'} busy={busy} onClose={closeDrawer}>
        <form className="form-stack" onSubmit={saveSubscription}>
          <label className="field"><span>订阅名称</span><input aria-label="订阅名称" value={form.name} maxLength={128} onChange={(event) => setForm({ ...form, name: event.currentTarget.value })} required /></label>
          <label className="field"><span>所属用户</span><select aria-label="所属用户" value={form.userId} onChange={(event) => setForm({ ...form, userId: event.currentTarget.value })} disabled={drawer !== 'create'} required>{users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></label>
          <fieldset className="choice-section"><legend>使用分组</legend>{groups.length ? <><div className="choice-section-actions"><button className="button secondary" type="button" aria-label="全选使用分组" onClick={() => setForm((current) => ({ ...current, groupIds: groups.map((group) => group.id) }))}>全选</button><button className="button secondary" type="button" aria-label="反选使用分组" onClick={() => setForm((current) => ({ ...current, groupIds: groups.map((group) => group.id).filter((id) => !current.groupIds.includes(id)) }))}>反选</button></div><div className="choice-list">{groups.map((group) => <label key={group.id} className="choice-row"><input type="checkbox" aria-label={`使用分组 ${group.name}`} checked={form.groupIds.includes(group.id)} onChange={() => setForm((current) => ({ ...current, groupIds: toggle(current.groupIds, group.id) }))} /><span>{group.name}</span></label>)}</div></> : <p className="drawer-note">请先创建分组</p>}</fieldset>
          <label className="field"><span>默认客户端</span><select aria-label="默认客户端" value={form.defaultClient} onChange={(event) => setForm({ ...form, defaultClient: event.currentTarget.value })}>{CLIENTS.map((client) => <option key={client} value={client}>{CLIENT_LABELS[client]}</option>)}</select></label>
          <label className="toggle-field"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.currentTarget.checked })} /><span>启用订阅</span></label>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
          <div className="dialog-actions"><button className="button secondary" type="button" onClick={closeDrawer} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy}>{busy ? '保存中' : drawer === 'create' ? '保存订阅' : '保存修改'}</button></div>
        </form>
      </EditDrawer>

      <EditDrawer open={details !== null} title="订阅详情" busy={busy} size="large" onClose={closeDrawer}>
        {details ? <div className="subscription-details">
          <section><div className="detail-heading"><div><h3>{details.name}</h3><p>{userNames.get(details.userId) ?? details.userId} · {details.groupIds.map((id) => groupNames.get(id) ?? id).join('、') || '未选择分组'}</p></div><button className="button secondary" type="button" onClick={() => resetToken(details)} disabled={busy}><KeyRound aria-hidden="true" size={16} />重置令牌</button></div></section>
          <section><h3>客户端链接</h3><div className="link-list">{Object.entries(details.links).map(([client, link]) => <div key={client}><span>{CLIENT_LABELS[client] ?? client}</span><input aria-label={`${CLIENT_LABELS[client] ?? client} 链接`} value={link} readOnly /><span className="row-actions"><button className="icon-button" type="button" aria-label={`复制 ${CLIENT_LABELS[client] ?? client} 链接`} title="复制链接" onClick={() => copyText(link, `${CLIENT_LABELS[client] ?? client} 链接已复制`)}><Copy aria-hidden="true" size={16} /></button><button className="icon-button" type="button" aria-label={`显示 ${CLIENT_LABELS[client] ?? client} 二维码`} title="显示二维码" onClick={() => showQr(client, link)}><QrCode aria-hidden="true" size={16} /></button></span></div>)}</div></section>
          <details className="diagnostic-disclosure" open><summary>兼容诊断</summary>{Object.keys(details.diagnostics).length ? <div className="diagnostic-list"><p className="diagnostic-help">{DIAGNOSTIC_HELP}</p>{Object.entries(details.diagnostics).map(([client, diagnostic]) => <article key={client}><header><strong>{CLIENT_LABELS[client] ?? client}</strong><span className={`status ${diagnostic.available ? 'success' : 'warning'}`}><i />{diagnostic.available ? '可用' : '不可用'}</span></header><p>输入 {diagnostic.inputNodes} · 输出 {diagnostic.outputNodes} · 跳过 {diagnostic.skippedNodes}</p>{diagnostic.diagnostics.length ? <DiagnosticList items={diagnostic.diagnostics} /> : null}</article>)}</div> : <p className="drawer-note">暂无编译诊断</p>}</details>
          {drawerError ? <StatusMessage tone="error">{drawerError}</StatusMessage> : null}
        </div> : null}
      </EditDrawer>

      <ConfirmDialog open={qr !== null} title={qr ? `${CLIENT_LABELS[qr.client] ?? qr.client} 二维码` : '订阅二维码'} description={details?.name ?? ''} confirmLabel="复制链接" onClose={() => setQr(null)} onConfirm={() => { if (qr) { copyText(qr.link, '链接已复制').catch(() => undefined); setQr(null) } }}>
        {qr?.loading ? <p className="qr-loading" role="status">正在生成二维码</p> : qr?.dataUrl ? <img className="qr-image" src={qr.dataUrl} alt={`${CLIENT_LABELS[qr.client] ?? qr.client} 订阅二维码`} /> : null}
      </ConfirmDialog>

      <ConfirmDialog open={confirmAction !== null} title={confirmAction === 'delete' ? '删除订阅' : '停用订阅'} description={confirmAction === 'delete' ? `将删除选中的 ${selected.size} 个订阅及其已编译内容。` : `将停用选中的 ${selected.size} 个订阅，现有链接将停止提供内容。`} confirmLabel={confirmAction === 'delete' ? '确认删除' : '确认停用'} danger busy={busy} onClose={() => setConfirmAction(null)} onConfirm={() => executeBatch(confirmAction ?? 'disable')} />
    </div>
  )
}
