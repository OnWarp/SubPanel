import type { SubscriptionFetchSummary } from '../../app/api'
import { Link } from 'react-router-dom'
import { QrCode } from 'lucide-react'
import type { SubscriptionDiagnostic } from '../../app/api'
import { CopyButton } from '../../ui/CopyButton'
import { Select } from '../../ui/Select'
import { StatusBadge } from '../../ui/StatusBadge'
import { StatusMessage } from '../../ui/StatusMessage'
import { DiagnosticList } from './DiagnosticList'
import { DIAGNOSTIC_HELP } from './diagnostics'

export type SubscriptionDetailLink = { value: string; label: string }

export type SubscriptionDetailDiagnostic = {
  key: string
  label: string
  available: boolean
  summary: string
  items: SubscriptionDiagnostic['diagnostics']
}

type SubscriptionDetailRowsProps = {
  user: string
  groups: string
  plan: { name: string; traffic: string; speed: string; devices: string } | null
  links: SubscriptionDetailLink[]
  client: string
  link: string
  linkError: string
  onClient: (value: string) => void
  onCopied: () => void
  onCopyError: () => void
  onShowQr: () => void
  bindingLabel: string
  templateName: string
  version: string
  versionHref?: string
  bindingError: string
  bindingLoading: boolean
  diagnostics: SubscriptionDetailDiagnostic[]
  lifecycle?: { label: string; reason?: string | null; fix?: { label: string; href?: string } | null }
  onFix?: () => void
  expiry?: string
  authorizedNodeCount?: number
  capabilityLabel?: string | null
  formatNote?: string | null
  fetchSummary?: SubscriptionFetchSummary | null
  configVersion?: string | null
}

export function SubscriptionDetailRows({
  user, groups, plan, links, client, link, linkError, onClient, onCopied, onCopyError, onShowQr,
  bindingLabel, templateName, version, versionHref, bindingError, bindingLoading, diagnostics,
  lifecycle, onFix, expiry, authorizedNodeCount, capabilityLabel, formatNote, fetchSummary, configVersion,
}: SubscriptionDetailRowsProps) {
  const clientLabel = links.find((entry) => entry.value === client)?.label ?? client
  return (
    <div className="subscription-details">
      <section>
        <h3 className="drawer-section-title">基本信息</h3>
        <dl className="key-value-rows">
          <div><dt>所属用户</dt><dd>{user}</dd></div>
          <div><dt>使用分组</dt><dd>{groups}</dd></div>
          {lifecycle ? <div><dt>订阅状态</dt><dd>{lifecycle.label}</dd></div> : null}
          {lifecycle?.reason ? <div><dt>状态原因</dt><dd>{lifecycle.reason}</dd></div> : null}
          {lifecycle?.fix ? <div><dt>处理</dt><dd>{lifecycle.fix.href ? <a href={lifecycle.fix.href}>{lifecycle.fix.label}</a> : <button className="button secondary" type="button" onClick={onFix}>{lifecycle.fix.label}</button>}</dd></div> : null}
          {expiry ? <div><dt>到期</dt><dd>{expiry}</dd></div> : null}
          {authorizedNodeCount !== undefined ? <div><dt>授权节点</dt><dd>{authorizedNodeCount}</dd></div> : null}
          {plan ? <>
            <div><dt>订阅计划</dt><dd>{plan.name}</dd></div>
            <div><dt>流量额度</dt><dd>{plan.traffic} · 配额定义／未强制执行</dd></div>
            <div><dt>限速</dt><dd>{plan.speed}</dd></div>
            <div><dt>设备数</dt><dd>{plan.devices} · 配额定义／未强制执行</dd></div>
          </> : null}
        </dl>
      </section>
      <section>
        <h3 className="drawer-section-title">客户端链接</h3>
        <dl className="key-value-rows">
          {links.length ? <>
            <div>
              <dt>格式</dt>
              <dd>
                <Select label="格式" value={client} onChange={onClient} options={links} />
              </dd>
            </div>
            <div>
              <dt>链接</dt>
              <dd className="subscription-link-row">
                <span className="link-url" title={link}>{link}</span>
                {capabilityLabel ? <StatusBadge tone={capabilityLabel === '完整规则配置' ? 'info' : 'muted'} size="sm">{capabilityLabel}</StatusBadge> : null}
                <CopyButton key={client} value={link} iconOnly label={`复制 ${clientLabel} 链接`} copiedLabel="链接已复制" onCopied={onCopied} onError={onCopyError} />
                <button className="icon-button" type="button" aria-label={`显示 ${clientLabel} 二维码`} title="显示二维码" onClick={onShowQr}><QrCode aria-hidden="true" size={16} /></button>
              </dd>
            </div>
          </> : <div className="key-value-note"><dt>链接</dt><dd>{linkError || '暂无客户端链接'}</dd></div>}
        </dl>
        {formatNote ? <p className="drawer-note">{formatNote}</p> : null}
      </section>
      <section>
        <h3 className="drawer-section-title">附加配置</h3>
        <dl className="key-value-rows" aria-busy={bindingLoading}>
          <div><dt>生效方式</dt><dd>{bindingLabel}</dd></div>
          <div><dt>模板</dt><dd>{templateName}</dd></div>
          <div><dt>发布版本</dt><dd>{versionHref ? <Link to={versionHref}>{version} · 查看配置诊断</Link> : version}</dd></div>
          {configVersion ? <div><dt>配置版本</dt><dd>{configVersion}</dd></div> : null}
        </dl>
        {bindingError ? <StatusMessage tone="error">{bindingError}</StatusMessage>
          : bindingLoading ? <p className="drawer-note" role="status">正在加载附加配置</p> : null}
        <details className="diagnostic-disclosure del-diagnostics">
          <summary className="drawer-section-title">兼容诊断</summary>
          {diagnostics.length ? (
            <>
              <p className="diagnostic-help key-value-note">{DIAGNOSTIC_HELP}</p>
              <div className="diagnostic-list key-value-rows">
                {diagnostics.map((diagnostic) => (
                  <article key={diagnostic.key}>
                    <header>
                      <strong>{diagnostic.label}</strong>
                      <StatusBadge tone={diagnostic.available ? 'success' : 'warning'} size="sm">{diagnostic.available ? '可用' : '不可用'}</StatusBadge>
                    </header>
                    <p>{diagnostic.summary}</p>
                    {diagnostic.items.length ? <DiagnosticList items={diagnostic.items} /> : null}
                  </article>
                ))}
              </div>
            </>
          ) : <p className="drawer-note">暂无编译诊断</p>}
        </details>
      </section>
      {fetchSummary ? <section>
        <h3 className="drawer-section-title">最近拉取</h3>
        {fetchSummary.lastFetchAt ? <dl className="key-value-rows">
          <div><dt>时间</dt><dd>{fetchSummary.lastFetchAt}</dd></div>
          <div><dt>平台</dt><dd>{fetchSummary.lastPlatform ?? '—'}</dd></div>
          <div><dt>样本结果</dt><dd>成功 {fetchSummary.success} · 失败 {fetchSummary.failure}</dd></div>
          <div><dt>状态码</dt><dd>{Object.entries(fetchSummary.statuses ?? {}).map(([code, count]) => `${code} × ${count}`).join(' · ') || '—'}</dd></div>
          {fetchSummary.durationMs && <div><dt>耗时范围</dt><dd>{fetchSummary.durationMs.min}–{fetchSummary.durationMs.max} ms</dd></div>}
          <div><dt>最近结果</dt><dd>{fetchSummary.lastOk ? '成功' : '失败'} · {fetchSummary.lastStatus}</dd></div>
        </dl> : <p className="drawer-note">还没有拉取记录</p>}
        {fetchSummary.unavailable && <p role="status">统计存储暂不可用，请稍后刷新</p>}
        {Object.keys(fetchSummary.platforms ?? {}).length > 0 && <details>
          <summary>按平台查看样本</summary>
          <dl className="key-value-rows">{Object.entries(fetchSummary.platforms).map(([platform, value]) => <div key={platform}>
            <dt>{platform}</dt><dd>成功 {value.success} · 失败 {value.failure}
              {value.durationMs && ` · ${value.durationMs.min}–${value.durationMs.max} ms`}
              {' · '}{Object.entries(value.statuses).map(([code, count]) => `${code} × ${count}`).join(' · ')}</dd>
          </div>)}</dl>
        </details>}
        <p className="drawer-note">仅统计已识别订阅的拉取，304 计为成功。记录按批写入，跨实例或重启时可能遗漏。UA 无法标识设备，拉取次数不能用于计算设备数量或代理流量</p>
      </section> : null}
    </div>
  )
}
