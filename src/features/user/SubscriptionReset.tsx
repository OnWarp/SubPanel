import { useEffect, useState } from 'react'
import { api, type AdminSubscription } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Select } from '../../ui/Select'
import { StatusMessage } from '../../ui/StatusMessage'

export function SubscriptionReset({ open, onClose, onUpdated }: { open: boolean; onClose: () => void; onUpdated?: () => void }) {
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>([])
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    let live = true
    setError(''); setSubscriptions([]); setId('')
    api<{ subscriptions: AdminSubscription[] }>('/api/account/subscriptions').then(r => { if (live) { setSubscriptions(r.subscriptions); setId(r.subscriptions[0]?.id ?? '') } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : '加载订阅失败') })
    return () => { live = false }
  }, [open])
  const reset = async () => {
    if (busy) return
    if (!id) { setError('请先选择可重置的订阅'); return }
    setBusy(true); setError('')
    try { await api(`/api/account/subscriptions/${encodeURIComponent(id)}/token/reset`, { method: 'POST', body: '{}' }); onUpdated?.(); onClose() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '重置订阅失败') }
    finally { setBusy(false) }
  }
  return <ConfirmDialog open={open} title="重置订阅" description="重置后旧链接会立即失效，请重新添加到客户端" confirmLabel="确认重置" danger busy={busy} onClose={onClose} onConfirm={() => { void reset() }}>
    {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
    {subscriptions.length ? <Select label="选择订阅" value={id} options={subscriptions.map(s => ({ value: s.id, label: s.name }))} onChange={setId} /> : <p>暂无可重置的订阅</p>}
  </ConfirmDialog>
}
