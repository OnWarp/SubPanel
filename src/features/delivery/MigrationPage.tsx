import { useEffect, useState } from 'react'
import { api, ApiClientError } from '../../app/api'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'

const endpoint = '/api/admin/unified-subscription-migration'

type Inventory = {
  users: string[]
  next: string | null
  orphanSamples: string[]
  historicalCodeBatches: { batchId: string; codes: number }[]
  counts: { orphaned: number; backfilled: number; activeShares: number; unusedCodes: number }
}
type Preview = {
  userId: string
  digest: string
  blockers: string[]
  executed: boolean
  subscriptions: { id: string; duplicate: boolean; historicalVersion: boolean; future: boolean; recoverable: boolean; limited: boolean }[]
}
type Reconciliation = {
  matches: boolean
  oldNodes: number
  newNodes: number
  reasons: string[]
  mappings: { legacyId: string; templateId: string; current: number }[]
}

const reasonLabels: Record<string, string> = {
  ACCOUNT_UNAVAILABLE: '账户不可用',
  NO_LEGACY_SUBSCRIPTIONS: '没有旧订阅',
  BINDING_LIMIT: '授权数量超限',
  EXISTING_BINDINGS: '已有绑定，需人工核对',
  LEGACY_SHARE_SCOPE_REVIEW_REQUIRED: '旧分享需核对',
  PLAN_POLICY_UNVERIFIED: '计划限额待核对',
  TOKEN_UNRECOVERABLE: '旧令牌无法恢复',
  SOURCE_CHANGED: '旧订阅已更新',
  LEGACY_WINDOW_INVALID: '授权时间无效',
  RESOURCE_SCOPE_REVIEW_REQUIRED: '资源范围待核对',
  CONVERSION_OVERRIDE: '订阅采用独立转换配置',
  STATUS_DIFFERS: '状态不同',
  WINDOW_DIFFERS: '授权时间不同',
  NODES_DIFFER: '节点不同',
  FORMAT_DIFFERS: '客户端格式不同',
  NODE_DISPLAY_DIFFERS: '节点显示不同',
  MAPPING_INCOMPLETE: '迁移映射不完整',
}

export function MigrationPage() {
  const [after, setAfter] = useState('')
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [user, setUser] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<Reconciliation | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const request = new AbortController()
    void api<Inventory>(`${endpoint}?after=${encodeURIComponent(after)}`, { signal: request.signal })
      .then(setInventory)
      .catch(cause => {
        if (!request.signal.aborted) setError(cause instanceof ApiClientError ? cause.message : '无法读取迁移清单')
      })
    return () => request.abort()
  }, [after])

  async function run(action: 'preview' | 'execute' | 'reconcile') {
    setBusy(true)
    setError('')
    if (action === 'preview') {
      setPreview(null)
      setResult(null)
    }
    try {
      const path = `${endpoint}/${encodeURIComponent(user)}/${action}`
      if (action === 'preview') setPreview(await api<Preview>(path))
      else {
        if (action === 'execute' && preview) {
          await api(path, { method: 'POST', body: JSON.stringify({ confirm: true, digest: preview.digest }) })
          setPreview(current => current && { ...current, executed: true })
        }
        setResult(await api<Reconciliation>(`${endpoint}/${encodeURIComponent(user)}/reconcile`))
      }
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : '无法完成迁移操作')
      if (action === 'execute') setPreview(null)
    } finally {
      setConfirm(false)
      setBusy(false)
    }
  }

  function download() {
    const { digest: _digest, ...report } = preview ?? {}
    const url = URL.createObjectURL(new Blob([JSON.stringify({
      inventory, preview: report, reconciliation: result,
    }, null, 2)],
      { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'unified-subscription-preflight.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  return <div className="page-stack">
    <PageHeader title="订阅迁移" />
    {error && <ErrorState message={error} />}
    {!inventory && !error && <LoadingState />}
    {inventory && <section className="data-section" aria-label="迁移清单">
      <p>孤立订阅 {inventory.counts.orphaned} · 有效旧分享 {inventory.counts.activeShares} · 未用兑换码 {inventory.counts.unusedCodes}</p>
      {!!inventory.orphanSamples.length && <p>{inventory.orphanSamples.join('、')}</p>}
      {!!inventory.historicalCodeBatches.length && <p>历史版本兑换批次 {inventory.historicalCodeBatches.length}</p>}
      {!inventory.users.length && <EmptyState title="没有待预检用户">
        {inventory.counts.orphaned + inventory.counts.activeShares + inventory.counts.unusedCodes > 0 &&
          <button className="button ghost" type="button" onClick={download}>导出预检</button>}
      </EmptyState>}
      {!!inventory.users.length && <form onSubmit={event => { event.preventDefault(); void run('preview') }}>
        <label>用户 <select value={user} disabled={busy} onChange={event => {
          setUser(event.target.value)
          setPreview(null)
          setResult(null)
          setError('')
        }}>
          <option value="">选择用户</option>
          {inventory.users.map(id => <option key={id} value={id}>{id}</option>)}
        </select></label>{' '}
        <button className="button primary" disabled={!user || busy}>预检</button>{' '}
        {inventory.next && <button className="button ghost" type="button" disabled={busy} onClick={() => {
          setAfter(inventory.next!)
          setInventory(null)
          setUser('')
          setPreview(null)
          setResult(null)
          setError('')
        }}>下一页</button>}
      </form>}
    </section>}
    {preview && <section className="data-section" aria-label="预检结果">
      <h2>预检结果</h2>
      {preview.blockers.length ? <ul>{preview.blockers.map(code => <li key={code}>{reasonLabels[code] ?? code}</li>)}</ul> : <p>预检通过</p>}
      <ul>{preview.subscriptions.map(row => <li key={row.id}>{row.id}
        {row.duplicate && ' · 重复模板'}{row.historicalVersion && ' · 历史版本'}{row.future && ' · 未来生效'}
        {!row.recoverable && ' · 令牌无法恢复'}{row.limited && ' · 有计划限额'}
      </li>)}</ul>
      <button className="button ghost" type="button" onClick={download}>导出预检</button>{' '}
      {preview.executed
        ? <button className="button primary" type="button" disabled={busy} onClick={() => void run('reconcile')}>运行对账</button>
        : <button className="button primary" type="button" disabled={busy || !!preview.blockers.length} onClick={() => setConfirm(true)}>执行影子迁移</button>}
    </section>}
    {result && <section className="data-section" aria-label="对账结果">
      <h2>{result.matches ? '对账一致' : '暂缓切换'}</h2>
      <p>旧节点 {result.oldNodes} · 新节点 {result.newNodes}</p>
      <ul>{result.reasons.map(code => <li key={code}>{reasonLabels[code] ?? code}</li>)}</ul>
      <ul>{result.mappings.map(row => <li key={row.legacyId} style={{ overflowWrap: 'anywhere' }}>{row.legacyId} → {row.templateId}</li>)}</ul>
    </section>}
    <ConfirmDialog open={confirm} busy={busy} title="确认影子迁移" description={`为 ${user} 创建专属模板和授权`}
      confirmLabel="确认执行" onClose={() => setConfirm(false)} onConfirm={() => void run('execute')} />
  </div>
}
