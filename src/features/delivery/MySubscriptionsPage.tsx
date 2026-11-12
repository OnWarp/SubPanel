import { Copy, KeyRound, QrCode, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, ApiClientError, jsonBody, type AdminSubscription } from '../../app/api'
import { copyToClipboard } from '../../app/clipboard'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { DataHeader } from '../../ui/DataHeader'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { InlineMessage } from '../../ui/InlineMessage'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { DiagnosticList } from './DiagnosticList'
import { DIAGNOSTIC_HELP } from './diagnostics'
import { EXPIRY_BADGE, formatExpiryTime, formatRemaining, getExpiryState } from './expiry'

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
}

const EMPTY_SUBSCRIPTIONS: AdminSubscription[] = []

type QrState = {
  client: string
  link: string
  dataUrl: string
  loading: boolean
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function groupSummary(groupIds: string[]): string {
  return groupIds.length ? `${groupIds.length} 个分组` : '未选择分组'
}

export function MySubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>(EMPTY_SUBSCRIPTIONS)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [tokenNotice, setTokenNotice] = useState<{ name: string; token: string; warning: string } | null>(null)
  const [qr, setQr] = useState<QrState | null>(null)
  const [primaryQr, setPrimaryQr] = useState<{ dataUrl: string; loading: boolean } | null>(null)
  const [resetOpen, setResetOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    setError('')
    try {
      const result = await api<{ subscriptions: AdminSubscription[] }>('/api/account/subscriptions')
      setSubscriptions(result.subscriptions)
      setSelectedId((current) => result.subscriptions.some((subscription) => subscription.id === current)
        ? current
        : result.subscriptions[0]?.id ?? '')
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载订阅失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const selected = useMemo(
    () => subscriptions.find((subscription) => subscription.id === selectedId) ?? null,
    [selectedId, subscriptions],
  )
  const linkEntries = selected
    ? Object.entries(selected.links).filter(([client]) => client !== 'generic')
    : []
  const diagnostics = selected ? Object.entries(selected.diagnostics) : []
  const primaryLink = selected?.links.auto || (selected ? selected.links[selected.defaultClient] ?? '' : '')
  const expiry = selected ? getExpiryState(selected) : null
  const expiryBadge = expiry ? EXPIRY_BADGE[expiry.kind] : null

  useEffect(() => {
    if (!primaryLink) {
      setPrimaryQr(null)
      return
    }
    let cancelled = false
    setPrimaryQr({ dataUrl: '', loading: true })
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(primaryLink, { width: 240, margin: 2, errorCorrectionLevel: 'M' }))
      .then((dataUrl) => {
        if (!cancelled) setPrimaryQr({ dataUrl, loading: false })
      })
      .catch(() => {
        if (cancelled) return
        setPrimaryQr(null)
        setMessage('')
        setError('二维码生成失败')
      })
    return () => { cancelled = true }
  }, [primaryLink])

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

  const showQr = async (client: string, link: string) => {
    setQr({ client, link, dataUrl: '', loading: true })
    try {
      const { default: QRCode } = await import('qrcode')
      const dataUrl = await QRCode.toDataURL(link, { width: 240, margin: 2, errorCorrectionLevel: 'M' })
      setQr((current) => current?.link === link ? { ...current, dataUrl, loading: false } : current)
    } catch {
      setQr(null)
      setMessage('')
      setError('二维码生成失败')
    }
  }

  const resetToken = async () => {
    if (!selected || busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api<{ subscription: AdminSubscription; token: string; warning: string }>(
        `/api/account/subscriptions/${selected.id}/token/reset`,
        { method: 'POST', body: jsonBody({}) },
      )
      setSubscriptions((current) => current.map((subscription) => subscription.id === result.subscription.id ? result.subscription : subscription))
      setSelectedId(result.subscription.id)
      setTokenNotice({ name: result.subscription.name, token: result.token, warning: result.warning })
      setResetOpen(false)
      setMessage('订阅令牌已重置')
    } catch (cause) {
      setError(errorMessage(cause, '重置令牌失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-stack del-user-page">
      <PageHeader title="我的订阅" description={`${subscriptions.length} 个订阅 · 选择一个订阅查看客户端链接`} actions={<label className="compact-field">
          <span className="sr-only">选择订阅</span>
          <select aria-label="选择订阅" value={selectedId} onChange={(event) => { setSelectedId(event.currentTarget.value); setTokenNotice(null); setMessage('') }} disabled={loading || subscriptions.length === 0}>
            {subscriptions.map((subscription) => <option key={subscription.id} value={subscription.id}>{subscription.name}</option>)}
          </select>
        </label>} />

      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><button className="button secondary" type="button" onClick={() => { load().catch(() => undefined) }}><RefreshCw aria-hidden="true" size={16} />重试</button></div> : null}

      <div className="del-user-column">
        {tokenNotice ? <section className="token-strip" aria-label="新订阅令牌"><div><strong>{tokenNotice.name} 的新令牌</strong><span>{tokenNotice.warning}</span></div><input aria-label="新订阅令牌" value={tokenNotice.token} readOnly /><button className="icon-button" type="button" aria-label="复制新订阅令牌" title="复制令牌" onClick={() => copyText(tokenNotice.token, '令牌已复制')}><Copy aria-hidden="true" size={17} /></button></section> : null}

        {loading && subscriptions.length === 0 ? <LoadingState label="正在加载订阅" /> : null}
        {!loading && loadError && subscriptions.length === 0 ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {!loading && !loadError && !selected ? <EmptyState title="暂无可用订阅" description="管理员创建订阅后，它会出现在这里" /> : null}
        {loadError && selected ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}

        {selected && expiry && expiryBadge ? <>
          {expiry.kind === 'expired' ? <div className="exp-alert"><InlineMessage tone="warning">订阅已过期，请联系管理员续期</InlineMessage></div> : null}
          {expiry.kind === 'pending' ? <div className="exp-alert"><InlineMessage tone="warning">{`将于 ${formatExpiryTime(expiry.startsAt)} 生效`}</InlineMessage></div> : null}
          <section className="data-section user-subscription-overview del-status-card" aria-labelledby="current-subscription-title">
            <div className="del-status-head">
              <h2 id="current-subscription-title">{selected.name}</h2>
              <span className="exp-badges">
                <StatusBadge tone={selected.enabled ? 'success' : 'muted'}>{selected.enabled ? '正常' : '已停用'}</StatusBadge>
                <StatusBadge tone={expiryBadge.tone}>{expiryBadge.label}</StatusBadge>
              </span>
            </div>
            <p className="del-status-group">{groupSummary(selected.groupIds)}</p>
            <dl className="exp-status-meta">
              <div><dt>生效时间</dt><dd>{formatExpiryTime(expiry.startsAt)}</dd></div>
              <div><dt>到期时间</dt><dd>{expiry.expiresAt === null ? '永久有效' : formatExpiryTime(expiry.expiresAt)}</dd></div>
              {expiry.expiresAt !== null ? <div><dt>剩余天数</dt><dd>{formatRemaining(expiry.remainingDays ?? 0)}</dd></div> : null}
            </dl>
            {!selected.enabled ? <StatusMessage tone="warning">此订阅已停用，链接暂时不会提供内容</StatusMessage> : null}
          </section>

          <section className="data-section del-link-card" aria-labelledby="subscription-link-title">
            <h2 id="subscription-link-title">订阅链接</h2>
            {primaryLink ? (
              <>
                <div className="del-link-line">
                  <p className="del-link-text">{primaryLink}</p>
                  <button className="button secondary" type="button" aria-label="复制订阅链接" title="复制链接" onClick={() => { copyText(primaryLink, '订阅链接已复制').catch(() => undefined) }}><Copy aria-hidden="true" size={16} />复制</button>
                </div>
                <div className="del-qr-slot">
                  {primaryQr?.loading ? <p className="del-qr-loading">正在生成二维码</p> : null}
                  {primaryQr?.dataUrl ? <img className="del-qr" src={primaryQr.dataUrl} alt="订阅二维码" /> : null}
                </div>
              </>
            ) : <p className="del-link-missing">暂无订阅链接</p>}
          </section>

          <section className="data-section user-subscription-section" aria-labelledby="client-links-title">
            <DataHeader id="client-links-title" title="客户端链接" />
            <div className="user-link-list">
              {linkEntries.map(([client, link]) => {
                const label = CLIENT_LABELS[client] ?? client
                const accessibleLabel = client === 'auto' ? '自动' : label
                return <div className="user-link-row" key={client}>
                  <div className="user-link-label"><strong>{label}</strong><span>{client === 'auto' ? '自动识别' : '专用格式'}</span></div>
                  <input aria-label={`${accessibleLabel}订阅链接`} value={link} readOnly />
                  <div className="user-link-actions"><button className="icon-button" type="button" aria-label={`复制${accessibleLabel}订阅链接`} title="复制链接" onClick={() => copyText(link, '链接已复制')}><Copy aria-hidden="true" size={16} /></button><button className="icon-button" type="button" aria-label={`显示 ${label} 二维码`} title="显示二维码" onClick={() => showQr(client, link)}><QrCode aria-hidden="true" size={16} /></button></div>
                </div>
              })}
            </div>
          </section>

          <details className="data-section user-subscription-section diagnostic-disclosure del-diagnostics">
            <summary id="diagnostics-title">兼容诊断</summary>
            {diagnostics.length ? <div className="diagnostic-list user-diagnostic-list"><p className="diagnostic-help">{DIAGNOSTIC_HELP}</p>{diagnostics.map(([client, diagnostic]) => <article key={client}><header><strong>{CLIENT_LABELS[client] ?? client}</strong><StatusBadge tone={diagnostic.available ? 'success' : 'warning'} size="sm">{diagnostic.available ? '可用' : '不可用'}</StatusBadge></header><p>输入 {diagnostic.inputNodes} · 输出 {diagnostic.outputNodes} · 跳过 {diagnostic.skippedNodes}</p>{diagnostic.diagnostics.length ? <DiagnosticList items={diagnostic.diagnostics} /> : null}</article>)}</div> : <p className="section-empty">暂无编译诊断</p>}
          </details>

          <section className="data-section del-reset" aria-labelledby="reset-token-title">
            <h2 id="reset-token-title">令牌重置</h2>
            <button className="button secondary" type="button" onClick={() => setResetOpen(true)} disabled={busy}><KeyRound aria-hidden="true" size={16} />重置订阅令牌</button>
          </section>
        </> : null}
      </div>

      <ConfirmDialog open={qr !== null} title={qr ? `${CLIENT_LABELS[qr.client] ?? qr.client} 二维码` : '订阅二维码'} description={selected?.name ?? ''} confirmLabel="复制链接" onClose={() => setQr(null)} onConfirm={() => { if (qr) { copyText(qr.link, '链接已复制').catch(() => undefined); setQr(null) } }}>
        {qr?.loading ? <p className="qr-loading" role="status">正在生成二维码</p> : qr?.dataUrl ? <img className="qr-image" src={qr.dataUrl} alt={`${CLIENT_LABELS[qr.client] ?? qr.client} 订阅二维码`} /> : null}
      </ConfirmDialog>
      <ConfirmDialog open={resetOpen} title="重置订阅令牌" description="重置后旧链接会立即失效，请重新添加到客户端" confirmLabel="确认重置" busy={busy} onClose={() => setResetOpen(false)} onConfirm={() => resetToken()} />
    </div>
  )
}
