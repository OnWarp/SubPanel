import { Ticket } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, jsonBody } from '../../app/api'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { CopyButton } from '../../ui/CopyButton'
import { Dialog } from '../../ui/Dialog'
import { DetailList } from '../../ui/DetailList'
import { ErrorState } from '../../ui/ErrorState'
import { LoadingState } from '../../ui/LoadingState'
import { PageContainer } from '../../ui/PageContainer'
import { PageHeader } from '../../ui/PageHeader'
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
  const [params] = useSearchParams()
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

  // Plans can be several instances; `?subscription=` names the one the user
  // opened from the detail page. The aggregate link stays the copy target.
  const packages = summary.source === 'plans' ? summary.packages ?? [] : []
  const focusedId = params.get('subscription')
  const focused = packages.find(item => item.instanceId === focusedId) ?? null

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
  const maskedLink = link ? `${new URL(link).origin}/s/••••••••` : ''
  return <PageContainer width="list">
    <div className="page-stack upd-page upd-subs">
    <PageHeader title="我的订阅" />
    <section className="content-section" aria-label="订阅详情">
      <DetailList items={[
        { id: 'status', label: '状态', value: <StatusPill tone={summary.status === 'active' ? 'success' : summary.status === 'expired' ? 'danger' : 'neutral'}>{subscriptionStatus[summary.status]}</StatusPill> },
        {
          id: 'expiry',
          label: packages.length > 0 ? '最近到期' : '到期时间',
          value: summary.permanent ? '长期有效' : expiry ? formatExpiryTime(Date.parse(expiry)) : '—',
        },
        ...(packages.length > 0 ? [{ id: 'aggregate', label: '可用节点', value: `${summary.nodeCount} 个` }] : []),
      ]} />
      <div className="subscription-link-section">
        <h2>{packages.length > 0 ? '聚合订阅' : '订阅链接'}</h2>
        {link ? <div className="del-link-line"><p className="del-link-text">{maskedLink}</p><CopyButton value={link} /></div>
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
    {packages.length > 0 ? <section className="content-section upd-sub-packages" aria-labelledby="sub-packages-title">
      <h2 id="sub-packages-title">套餐订阅</h2>
      <ul className="upd-sub-package-list">
        {packages.map(item => <li key={item.instanceId} className={`upd-sub-package${focused?.instanceId === item.instanceId ? ' is-focused' : ''}`}>
          <div>
            <strong>{item.name}</strong>
            <span className={`upd-plan-status is-${item.bucket === 'active' ? 'success' : item.bucket === 'expired' ? 'muted' : 'warning'}`}>
              {subscriptionStatus[item.status as keyof typeof subscriptionStatus] ?? item.status}
            </span>
          </div>
          <p>{item.permanent ? '长期有效' : item.expiresAt === null ? '—' : `到期 ${formatExpiryTime(item.expiresAt)}`} · {item.nodeCount} 个节点</p>
          <Link className="button ghost" to={`/me/plans/${encodeURIComponent(item.instanceId)}`}>查看套餐</Link>
        </li>)}
      </ul>
    </section> : null}
    <div className="upd-import-actions">
      <Button variant="primary" as="link" to="/me/plans"><Ticket size={16} aria-hidden="true" />兑换套餐</Button>
    </div>
    <Dialog open={dialog === 'import'} appearance="content" title="导入客户端" onClose={close}>
      <SubscriptionImports entries={entries} />
    </Dialog>
    <Dialog open={dialog === 'redeem'} appearance="content" title="兑换套餐" size="l" onClose={close} busy={busy}>
      {dialog === 'redeem' && <PersonalRedemptions unified onRedeemed={reload} onPending={setBusy} />}
    </Dialog>
    <Dialog open={dialog === 'share'} appearance="content" title="分享订阅" onClose={close} busy={busy}>
      {dialog === 'share' && (shareUrl ? <CopyButton value={shareUrl} label="复制分享链接" />
        : <CreateShareForm scope={{ type: 'unified' }} onCancel={close} onPending={setBusy} onCreated={(_share, url) => setShareUrl(url)} />)}
    </Dialog>
    <ConfirmDialog open={dialog === 'reset' || dialog === 'revoke'} appearance="content" title={dialog === 'reset' ? '重置订阅链接' : '撤销全部分享'}
      description={error || (dialog === 'reset' ? '旧链接将立即失效，请重新导入客户端' : '现有分享链接将失效')}
      confirmLabel={dialog === 'reset' ? '重置' : '撤销'} danger busy={busy} onClose={close}
      onConfirm={() => dialog === 'reset' ? submit(`${unifiedSubscriptionPath}/reset-token`, '旧链接已失效') : submit('/api/shares/revoke-all', '已撤销全部分享')} />
    </div>
  </PageContainer>
}

export function MySubscriptionsPage() {
  const { state, reload } = useUnifiedSubscription()
  if (state.kind === 'legacy') return <PageContainer width="list"><LegacySubscriptionsPage /></PageContainer>
  if (state.kind === 'ready') return <UnifiedDetails summary={state.summary} reload={reload} />
  return <PageContainer width="list">
    <PageHeader title="我的订阅" />
    {state.kind === 'loading' ? <LoadingState label="正在加载订阅" /> : <ErrorState message={state.message} onRetry={reload} />}
  </PageContainer>
}
