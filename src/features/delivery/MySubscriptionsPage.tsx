import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, jsonBody } from '../../app/api'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { Dialog } from '../../ui/Dialog'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageHero } from '../../ui/PageHero'
import { StatusPill } from '../../ui/StatusPill'
import { StatusMessage } from '../../ui/StatusMessage'
import { useDownloadsEnabled } from '../apps/downloads-visibility'
import { PersonalRedemptions } from '../redemption/PersonalRedemptions'
import { CreateShareForm } from '../shares/ShareDialog'
import { subscriptionFormatLink } from '../user/client-import'
import { formatExpiryTime } from './expiry'
import { LegacySubscriptionsPage } from './LegacySubscriptionsPage'
import { CLIENT_LABELS } from './platforms'
import { SubscriptionImports } from './SubscriptionImports'
import { subscriptionError, subscriptionStatus, unifiedSubscriptionPath, useUnifiedSubscription, type UnifiedSubscription } from './unified-subscription'

function UnifiedDetails({ summary, reload }: { summary: UnifiedSubscription; reload: () => void }) {
  const [params, setParams] = useSearchParams()
  const downloads = useDownloadsEnabled()
  const [dialog, setDialog] = useState<'import' | 'reset' | 'share' | 'revoke' | 'redeem' | null>(null)
  const [shareUrl, setShareUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [retiredLink, setRetiredLink] = useState<string | null>(null)
  const link = summary.subscriptionUrl === retiredLink ? null : summary.subscriptionUrl
  const close = () => { setDialog(null); setError('') }
  const open = (next: typeof dialog) => { setDialog(next); setShareUrl(''); setError(''); setNotice('') }

  useEffect(() => {
    if (!params.has('subscription') && !params.has('share')) return
    const next = new URLSearchParams(params)
    next.delete('subscription')
    next.delete('share')
    setParams(next, { replace: true })
  }, [params, setParams])

  async function submit(path: string, message: string) {
    setBusy(true)
    setError('')
    try {
      await api(path, { method: 'POST', body: jsonBody({}) })
      close()
      setNotice(message)
      if (path.endsWith('reset-token')) { setRetiredLink(link); reload() }
    } catch (cause) {
      setError(subscriptionError(cause, '操作失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const expiry = summary.expiresAt ?? summary.lastExpiredAt
  const entries = link ? summary.importPlatforms.map(({ platform, displayName }) => ({
    client: platform, label: displayName || CLIENT_LABELS[platform] || platform, link: subscriptionFormatLink(link, platform),
  })) : []
  return <div className="page-stack upd-page upd-subs">
    <PageHero title="我的订阅" />
    <section className="data-section" aria-label="订阅详情">
      <dl className="key-value-rows">
        <div><dt>状态</dt><dd><StatusPill tone={summary.status === 'active' ? 'success' : summary.status === 'expired' ? 'danger' : 'neutral'}>{subscriptionStatus[summary.status]}</StatusPill></dd></div>
        <div><dt>到期时间</dt><dd>{summary.permanent ? '长期有效' : expiry ? formatExpiryTime(Date.parse(expiry)) : '—'}</dd></div>
      </dl>
      <div className="subscription-link-section">
        <h2>订阅链接</h2>
        {link ? <div className="del-link-line"><p className="del-link-text">{new URL(link).origin}/s/••••••••</p><CopyButton value={link} /></div>
          : <p>订阅链接暂不可用</p>}
      </div>
      {!summary.hasAvailableNodes && <p role="status">{summary.status === 'expired' ? '订阅已过期，可兑换或联系管理员续期' : '暂无可用节点'}</p>}
      {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
      <div className="upd-import-actions">
        {entries.length > 0 && summary.hasAvailableNodes && <Button onClick={() => open('import')}>导入客户端</Button>}
        {summary.shareEnabled && summary.hasAvailableNodes && <Button variant="secondary" onClick={() => open('share')}>分享</Button>}
        {(link || summary.shareEnabled || downloads) && <details className="diagnostic-disclosure"><summary>更多</summary>
          <div className="upd-import-actions">
            {link && <Button variant="secondary" onClick={() => open('reset')}>重置链接</Button>}
            {summary.shareEnabled && <Button variant="secondary" onClick={() => open('revoke')}>撤销全部分享</Button>}
            {downloads && <Link className="button secondary" to="/apps">下载客户端</Link>}
          </div>
        </details>}
      </div>
    </section>
    <Button variant="secondary" onClick={() => open('redeem')}>兑换订阅</Button>
    <Dialog open={dialog === 'import'} title="导入客户端" onClose={close}>
      <SubscriptionImports entries={entries} />
    </Dialog>
    <Dialog open={dialog === 'redeem'} title="兑换订阅" size="l" onClose={close} busy={busy}>
      {dialog === 'redeem' && <PersonalRedemptions unified onRedeemed={reload} onPending={setBusy} />}
    </Dialog>
    <Dialog open={dialog === 'share'} title="分享订阅" onClose={close} busy={busy}>
      {dialog === 'share' && (shareUrl ? <CopyButton value={shareUrl} label="复制分享链接" />
        : <CreateShareForm scope={{ type: 'unified' }} onCancel={close} onPending={setBusy} onCreated={(_share, url) => setShareUrl(url)} />)}
    </Dialog>
    <ConfirmDialog open={dialog === 'reset' || dialog === 'revoke'} title={dialog === 'reset' ? '重置订阅链接' : '撤销全部分享'}
      description={error || (dialog === 'reset' ? '旧链接将立即失效，请重新导入客户端' : '现有分享链接将失效')}
      confirmLabel={dialog === 'reset' ? '重置' : '撤销'} danger busy={busy} onClose={close}
      onConfirm={() => dialog === 'reset' ? submit(`${unifiedSubscriptionPath}/reset-token`, '旧链接已失效') : submit('/api/shares/revoke-all', '已撤销全部分享')} />
  </div>
}

export function MySubscriptionsPage() {
  const { state, reload } = useUnifiedSubscription()
  if (state.kind === 'legacy') return <LegacySubscriptionsPage />
  if (state.kind === 'ready') return <UnifiedDetails summary={state.summary} reload={reload} />
  return <div className="page-stack"><PageHero title="我的订阅" />
    {state.kind === 'loading' ? <LoadingState label="正在加载订阅" /> : <ErrorState message={state.message} onRetry={reload} />}
  </div>
}
