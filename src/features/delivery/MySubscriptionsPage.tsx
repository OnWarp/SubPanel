import { Dialog } from '../../ui/Dialog'
import { Input } from '../../ui/Controls'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import { KeyRound, RefreshCw, Share2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { subscriptionPlanLabels } from './plan-types'
import { api, ApiClientError, jsonBody, type AdminSubscription } from '../../app/api'
import { ShareDialog } from '../shares/ShareDialog'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { EmptyState } from '../../ui/EmptyState'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { Select } from '../../ui/Select'
import { InlineMessage } from '../../ui/InlineMessage'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { DiagnosticList } from './DiagnosticList'
import { CLIENT_LABELS, orderLinkEntries, pickPrimaryLink, useEnabledPlatforms } from './platforms'
import { DIAGNOSTIC_HELP } from './diagnostics'
import { EXPIRY_BADGE, formatExpiryTime, formatRemaining, getExpiryState } from './expiry'
import { SubscriptionImports } from './SubscriptionImports'

const EMPTY_SUBSCRIPTIONS: AdminSubscription[] = []

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function groupSummary(groupIds: string[]): string {
  return groupIds.length ? `${groupIds.length} 个分组` : '未选择分组'
}

export function MySubscriptionsPage() {
  const downloadsEnabled = useDownloadsEnabled()
  const [params, setParams] = useSearchParams()
  const [shareEnabled, setShareEnabled] = useState(false)
  const shareParam = shareEnabled ? params.get('share') ?? '' : ''
  const shareButtonRef = useRef<HTMLButtonElement>(null)
  const appliedShare = useRef('')
  const [subscriptions, setSubscriptions] = useState<AdminSubscription[]>(EMPTY_SUBSCRIPTIONS)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [tokenNotice, setTokenNotice] = useState<{ name: string; token: string; warning: string } | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [linkQr, setLinkQr] = useState<{ dataUrl: string; loading: boolean } | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const resetButtonRef = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    setError('')
    try {
      const result = await api<{ subscriptions: AdminSubscription[], shareEnabled: boolean }>('/api/account/subscriptions')
      setSubscriptions(result.subscriptions)
      setShareEnabled(result.shareEnabled)
      setSelectedId((current) => {
        if (result.subscriptions.some((subscription) => subscription.id === current)) return current
        const search = new URLSearchParams(window.location.search)
        const requested = (result.shareEnabled && search.get('share')) || search.get('subscription')
        if (requested && result.subscriptions.some((subscription) => subscription.id === requested)) return requested
        return result.subscriptions[0]?.id ?? ''
      })
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载订阅失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  useEffect(() => {
    if (loading || loadError || !shareParam) return
    if (!subscriptions.some((subscription) => subscription.id === shareParam)) {
      setParams((current) => {
        const next = new URLSearchParams(current)
        next.delete('share')
        return next
      }, { replace: true })
      setMessage('')
      setError('未找到要分享的订阅')
      return
    }
    if (appliedShare.current === shareParam) return
    appliedShare.current = shareParam
    setSelectedId(shareParam)
  }, [loadError, loading, setParams, shareParam, subscriptions])

  const openShare = (subscriptionId: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set('share', subscriptionId)
      return next
    }, { replace: true })
  }

  const closeShare = () => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('share')
      return next
    }, { replace: true })
  }

  useEffect(() => {
    if (!selectedId) return
    const abort = new AbortController()
    void api<{ subscription: AdminSubscription }>(`/api/me/subscriptions/${selectedId}`, { signal: abort.signal })
      .then(({ subscription }) => {
        if (!abort.signal.aborted) setSubscriptions(current => current.map(row =>
          row.id === subscription.id && row.revision <= subscription.revision ? subscription : row))
      })
      .catch(cause => {
        if (!abort.signal.aborted) setError(errorMessage(cause, '加载订阅详情失败'))
      })
    return () => abort.abort()
  }, [selectedId])

  const selected = useMemo(
    () => subscriptions.find((subscription) => subscription.id === selectedId) ?? null,
    [selectedId, subscriptions],
  )
  const platforms = useEnabledPlatforms()
  const linkEntries = selected
    ? orderLinkEntries(Object.entries(selected.links).filter(([entryClient]) => entryClient !== 'generic'), platforms)
    : []
  const diagnostics = selected ? Object.entries(selected.diagnostics) : []
  const primaryLink = selected ? pickPrimaryLink(selected.links, selected.defaultClient, platforms) : ''
  const expiry = selected ? getExpiryState(selected) : null
  const expiryBadge = expiry ? EXPIRY_BADGE[expiry.kind] : null

  useEffect(() => {
    if (!primaryLink || !qrOpen) {
      setLinkQr(null)
      return
    }
    let cancelled = false
    setLinkQr({ dataUrl: '', loading: true })
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(primaryLink, { width: 240, margin: 2, errorCorrectionLevel: 'M' }))
      .then((dataUrl) => {
        if (!cancelled) setLinkQr({ dataUrl, loading: false })
      })
      .catch(() => {
        if (cancelled) return
        setLinkQr(null)
        setMessage('')
        setError('二维码生成失败')
      })
    return () => { cancelled = true }
  }, [primaryLink, qrOpen])

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
    <div className="page-stack del-user-page upd-page upd-subs">
      <PageHero title="我的订阅" actions={<Select
          label="选择订阅"
          value={selectedId}
          options={subscriptions.map((subscription) => ({ value: subscription.id, label: subscription.name }))}
          disabled={loading || subscriptions.length === 0}
          onChange={(nextId) => {
            setSelectedId(nextId)
            setTokenNotice(null)
            setMessage('')
            if (shareParam) openShare(nextId)
          }}
        />} />

      <div className="upd-secondary-actions">
        {downloadsEnabled ? <Link className="button secondary" to="/apps">下载客户端</Link> : null}
      </div>
      {message ? <StatusMessage tone="success">{message}</StatusMessage> : null}
      {error ? <div className="inline-alert"><StatusMessage tone="error">{error}</StatusMessage><Button variant="secondary" onClick={() => { load().catch(() => undefined) }}><RefreshCw aria-hidden="true" size={16} />重试</Button></div> : null}

      <div className="del-user-column">
        {tokenNotice ? <section className="token-strip" aria-label="新订阅令牌"><div><strong>{tokenNotice.name} 的新令牌</strong><span>{tokenNotice.warning}</span></div><Input aria-label="新订阅令牌" value={tokenNotice.token} readOnly /><CopyButton iconOnly value={tokenNotice.token} label="复制令牌" /></section> : null}

        {loading && subscriptions.length === 0 ? <LoadingState label="正在加载订阅" /> : null}
        {!loading && loadError && subscriptions.length === 0 ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
        {!loading && !loadError && !selected ? <EmptyState title="暂无可用订阅" /> : null}
        {loadError && selected ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}

        {selected && expiry && expiryBadge ? <>
          {expiry.kind === 'expired' ? <div className="exp-alert"><InlineMessage tone="warning">订阅已过期，请联系管理员续期</InlineMessage></div> : null}
          {expiry.kind === 'pending' ? <div className="exp-alert"><InlineMessage tone="warning">{`将于 ${formatExpiryTime(expiry.startsAt)} 生效`}</InlineMessage></div> : null}
          <section className="upd-sub-primary" aria-labelledby="current-subscription-title">
            <div className="del-status-head">
              <h2 id="current-subscription-title">{selected.name}</h2>
              <span className="exp-badges">
                <StatusBadge tone={selected.status ? (selected.status === 'active' ? 'success' : 'muted') : selected.planState === 'active' || (selected.planState === undefined && selected.enabled) ? 'success' : 'muted'}>{selected.statusLabel ?? (selected.planState ? subscriptionPlanLabels[selected.planState] : selected.enabled ? '正常' : '已停用')}</StatusBadge>
                <StatusBadge tone={expiryBadge.tone}>{expiryBadge.label}</StatusBadge>
              </span>
              {shareEnabled ? <button ref={shareButtonRef} className="button ghost" type="button" onClick={() => openShare(selected.id)}><Share2 aria-hidden="true" size={16} />分享</button> : null}
            </div>
            <dl className="exp-status-meta">
              <div><dt>到期时间</dt><dd>{expiry.expiresAt === null ? '永久有效' : formatExpiryTime(expiry.expiresAt)}</dd></div>
              {expiry.expiresAt !== null ? <div><dt>剩余天数</dt><dd>{formatRemaining(expiry.remainingDays ?? 0)}</dd></div> : null}
              <div><dt>生效时间</dt><dd>{formatExpiryTime(expiry.startsAt)}</dd></div>
            </dl>
            {selected.linkError ? <StatusMessage tone="warning">订阅域名尚未配置，链接暂不可用，请联系管理员在系统设置中完成配置</StatusMessage> : null}
            <div className="subscription-link-section">
              <h2 id="subscription-link-title">订阅链接</h2>
              {primaryLink ? (
                <>
                  <div className="del-link-line">
                    <p className="del-link-text">{primaryLink}</p>
                    <div className="upd-import-actions">
                      <CopyButton className="upd-copy-primary" value={primaryLink} />
                    </div>
                  </div>
                  <button className="button secondary" type="button" onClick={() => setQrOpen(true)}>订阅二维码</button>
                </>
              ) : platforms.status === 'ready' && !selected.linkError ? (
                <EmptyState title="当前暂无可用的订阅入口" />
              ) : (
                <p className="del-link-missing">暂无订阅链接</p>
              )}
            </div>
          </section>

          <SubscriptionImports modal key={selected.id} entries={linkEntries
            .filter(([client]) => client !== 'auto')
            .map(([client, link]) => ({ client, link, label: platforms.names[client] ?? CLIENT_LABELS[client] ?? client }))} />

          <section className="user-subscription-overview" aria-label="订阅计划">
            <h2>订阅计划</h2>
            <p className="del-status-group">{groupSummary(selected.groupIds)}</p>
            <dl className="exp-status-meta">
              <div><dt>订阅计划</dt><dd>{selected.planName ?? '未分配计划'}</dd></div>
                <div><dt>流量额度</dt><dd>{selected.trafficGb ? `${selected.trafficGb} GB` : '不限'} · 配额定义／未强制执行</dd></div>
                <div><dt>限速</dt><dd>{selected.speedLimitMbps ? `${selected.speedLimitMbps} Mbps` : '不限'}</dd></div>
                <div><dt>设备数</dt><dd>{selected.deviceLimit || '不限'} · 配额定义／未强制执行</dd></div>
            </dl>
          </section>

          <details className="data-section user-subscription-section diagnostic-disclosure del-diagnostics">
            <summary id="diagnostics-title">兼容诊断</summary>
            {selected.formats?.length ? <dl className="key-value-rows">
              {selected.formats.filter(format => linkEntries.some(([client]) => client === format.platform)).map(format => (
                <div key={format.platform}><dt>{format.displayName}</dt><dd>{format.capabilityLabel}{format.note && ` · ${format.note}`}</dd></div>
              ))}
            </dl> : null}
            {diagnostics.length ? <div className="diagnostic-list user-diagnostic-list"><p className="diagnostic-help">{DIAGNOSTIC_HELP}</p>{diagnostics.map(([entryClient, diagnostic]) => <article key={entryClient}><header><strong>{CLIENT_LABELS[entryClient] ?? entryClient}</strong><StatusBadge tone={diagnostic.available ? 'success' : 'warning'} size="sm">{diagnostic.available ? '可用' : '不可用'}</StatusBadge></header><p>输入 {diagnostic.inputNodes} · 输出 {diagnostic.outputNodes} · 跳过 {diagnostic.skippedNodes}</p>{diagnostic.diagnostics.length ? <DiagnosticList items={diagnostic.diagnostics} /> : null}</article>)}</div> : <EmptyState title="暂无编译诊断" />}
          </details>


          <section className="data-section del-reset" aria-labelledby="reset-token-title">
            <h2 id="reset-token-title">重置订阅</h2>
            <p>重置后旧链接立即失效，请重新添加到客户端</p>
            <button ref={resetButtonRef} className="button danger" type="button" onClick={() => { setError(''); setResetOpen(true) }} disabled={busy}><KeyRound aria-hidden="true" size={16} />重置订阅令牌</button>
          </section>
        </> : null}
      </div>

      <Dialog open={qrOpen && !!primaryLink} title="订阅二维码" size="s" sensitive onClose={() => setQrOpen(false)}>
        {linkQr?.loading && <p role="status">正在生成二维码</p>}
        {linkQr?.dataUrl && <img className="del-qr" src={linkQr.dataUrl} alt="订阅二维码" />}
        {!linkQr && error && <StatusMessage tone="error">{error}</StatusMessage>}
      </Dialog>
      <ConfirmDialog open={resetOpen} title="重置订阅令牌" description="重置后旧链接会立即失效，请重新添加到客户端" confirmLabel="确认重置" danger busy={busy} returnFocusRef={resetButtonRef} onClose={() => { setError(''); setResetOpen(false) }} onConfirm={() => resetToken()}>
        {resetOpen && error && <StatusMessage tone="error">{error}</StatusMessage>}
      </ConfirmDialog>
      <ShareDialog
        subscription={subscriptions.find((subscription) => subscription.id === shareParam) ?? null}
        onClose={closeShare}
        returnFocusRef={shareButtonRef}
      />
    </div>
  )
}
