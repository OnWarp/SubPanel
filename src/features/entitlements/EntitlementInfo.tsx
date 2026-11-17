import { useEffect, useState } from 'react'
import { api } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { entitlementLabels, type EntitlementState } from './types'
export function EntitlementInfo({ onLoad }: { onLoad?: (value: EntitlementState) => void }) {
  const [rights, setRights] = useState<EntitlementState | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    api<EntitlementState>('/api/account/entitlement').then((value) => { if (live) { setRights(value); setError(''); onLoad?.(value) } }).catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : '加载权益失败') })
    return () => { live = false }
  }, [revision, onLoad])
  return <section className="data-section nav-status" aria-label="订阅权益">
    {error ? <ErrorState message={error} onRetry={() => setRevision((r) => r + 1)} /> : !rights ? <LoadingState label="正在加载权益" /> : <div className="nav-status-body">
      <strong>{rights.current?.plan.name ?? entitlementLabels[rights.state]}</strong>
      {rights.latest ? <dl className="nav-meta"><div><dt>计划</dt><dd>{rights.latest.plan.name}</dd></div><div><dt>到期日</dt><dd>{new Date(rights.latest.expiresAt).toLocaleString()}</dd></div><div><dt>流量配额</dt><dd>{rights.latest.plan.trafficGb ? `${rights.latest.plan.trafficGb} GB` : '不限'}（仅展示）</dd></div><div><dt>限速</dt><dd>{rights.latest.plan.speedLimitMbps ? `${rights.latest.plan.speedLimitMbps} Mbps` : '不限'}</dd></div><div><dt>设备数</dt><dd>{rights.latest.plan.deviceLimit || '不限'}（仅记录）</dd></div></dl> : null}
    </div>}
  </section>
}
