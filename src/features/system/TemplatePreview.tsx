import { useEffect, useMemo, useState } from 'react'
import { stringify } from 'yaml'
import { loadTemplateSubscriptions, type Diagnostic, type TemplatePreviewResponse, type TemplateZeroNodeReason } from '../../app/api'
import { FormSelect, Input } from '../../ui/Controls'
import { FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { DiagnosticList } from '../delivery/DiagnosticList'
import { templateError } from './template-display'

const reasons: Record<TemplateZeroNodeReason, string> = {
  disabled: '订阅已停用',
  unassigned: '订阅未分配用户',
  pending: '订阅尚未生效',
  expired: '订阅已过期',
  ownerUnavailable: '所属用户不可用',
  noPlan: '订阅没有可用计划',
  noGroupIntersection: '订阅与计划的分组没有交集',
  noEnabledNodes: '授权分组没有启用的节点',
  incompatible: '授权节点与 Mihomo 不兼容',
}

export function TemplateDiagnostics({ diagnostics, ignored }: { diagnostics: Diagnostic[]; ignored: string[] }) {
  return <>
    {ignored.length > 0 && <p>忽略字段：{ignored.join('、')}</p>}
    {diagnostics.length > 0 && <ul className="template-diagnostics">
      {diagnostics.map((item, index) => <li key={index} data-severity={item.severity}>
        {item.path && <code>{item.path}</code>}
        {item.line !== undefined && <span>第 {item.line} 行{item.column !== undefined && `第 ${item.column} 列`}</span>}
        <span>{item.message}</span>
      </li>)}
    </ul>}
  </>
}

export function TemplatePreview({ value, onChange, onPreview, pending, result, standalone, disabled, platform, onPlatform, sample, onSample }: {
  platform: string
  onPlatform: (value: string) => void
  sample: boolean
  onSample: (value: boolean) => void
  value: string
  onChange: (id: string) => void
  onPreview: () => void
  result?: TemplatePreviewResponse
  pending: boolean
  standalone: boolean
  disabled: boolean
}) {
  const [subscriptions, setSubscriptions] = useState<Awaited<ReturnType<typeof loadTemplateSubscriptions>>>()
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const abort = new AbortController()
    setError('')
    void loadTemplateSubscriptions(abort.signal).then(setSubscriptions).catch((cause) => {
      if (!abort.signal.aborted) setError(templateError(cause))
    })
    return () => abort.abort()
  }, [attempt])

  const matches = subscriptions?.filter(({ id, name }) =>
    id === value || `${name} ${id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))

  return <section className="form-stack template-preview" aria-labelledby="template-preview-title">
    <h3 id="template-preview-title">预览</h3>
    <FormField label="目标平台" htmlFor="template-platform">
      <FormSelect id="template-platform" value={platform} onChange={event => onPlatform(event.currentTarget.value)}>
        <option value="mihomo">Mihomo · 完整规则配置</option>
        <option value="singbox">sing-box · 完整规则配置</option>
        <option value="surge">Surge · 仅节点订阅</option>
        <option value="loon">Loon · 仅节点订阅</option>
        <option value="quantumultx">Quantumult X · 仅节点订阅</option>
        <option value="v2rayn">v2rayN · 仅节点订阅</option>
        <option value="nekobox">NekoBox · 仅节点订阅</option>
        <option value="shadowrocket">Shadowrocket · 仅节点订阅</option>
        <option value="generic">通用 URI · 仅节点订阅</option>
      </FormSelect>
    </FormField>
    <label><input type="checkbox" checked={sample} onChange={event => onSample(event.currentTarget.checked)} /> 使用合成节点样本</label>
    <FormField label="搜索预览订阅" htmlFor="template-subscription-search">
      <Input id="template-subscription-search" type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
    </FormField>
    <FormField label="预览订阅" htmlFor="template-subscription">
      <FormSelect id="template-subscription" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        <option value="">仅校验</option>
        {matches?.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </FormSelect>
    </FormField>
    {error ? <div className="template-actions"><StatusMessage tone="error">{error}</StatusMessage>
      <button className="button secondary" type="button" onClick={() => setAttempt(attempt + 1)}>重试加载订阅</button></div>
      : !subscriptions ? <p role="status">正在加载预览订阅</p>
      : search.trim() && !matches?.length && <p>没有匹配的订阅</p>}
    {standalone && <div><button className="button primary" type="button" disabled={disabled || pending} onClick={onPreview}>预览</button></div>}
    {pending && <p role="status">正在生成预览</p>}
    {!pending && result && <PreviewResult result={result} />}
  </section>
}

function PreviewResult({ result }: { result: TemplatePreviewResponse }) {
  const { groups, rules, ruleProviders, outputNodes, zeroNodeReason, subscriptionName } = result
  const providers = Object.entries(ruleProviders)
  const yaml = useMemo(() => stringify({
    'proxy-groups': groups,
    rules,
    ...(providers.length > 0 ? { 'rule-providers': ruleProviders } : {}),
  }, { lineWidth: 0 }), [groups, rules, ruleProviders, providers.length])

  return <div className="form-stack template-preview-result">
    {result.diagnostics.some(item => item.severity === 'error')
      ? <TemplateDiagnostics diagnostics={result.diagnostics} ignored={result.ignored} />
      : <StatusMessage tone="success">配置预览已生成</StatusMessage>}
    <p>输入 {result.inputNodes ?? 0} · 授权 {result.authorizedNodes ?? 0} · 输出 {outputNodes ?? '—'} · 跳过 {result.skippedNodes ?? 0}</p>
    <p>配置版本 {result.effectiveVersionId ?? (result.draftRevision ? `草稿修订 ${result.draftRevision}` : '基础配置')} · 渲染器 {result.rendererVersion ?? '—'}</p>
    {result.summary && <p>输出摘要 {result.summary.bytes} 字节 · {result.summary.groups} 个策略组 · {result.summary.rules} 条规则</p>}
    {Boolean(result.nodeDiagnostics?.length) && <DiagnosticList items={result.nodeDiagnostics ?? []} />}
    {outputNodes === null ? <p>生产下发：选择订阅后核对</p> : <>
      <p>{subscriptionName} · 节点数 {outputNodes}</p>
      {outputNodes === 0
        ? <StatusMessage tone="error">{`生产下发受阻：${zeroNodeReason ? reasons[zeroNodeReason] ?? '无可用节点' : '无可用节点'}`}</StatusMessage>
        : <p>当前样本可生成输出</p>}
    </>}
    <details open><summary>生成配置预览</summary><pre tabIndex={0}>{result.body ?? yaml}</pre></details>
    <div><h4>策略组（{groups.length}）</h4>
      {groups.map((group) => <details key={group.name}>
        <summary>{group.name} · {group.type} · {group.proxies.length} 个成员</summary>
        <ul>{group.proxies.map((member) => <li key={member}>{member}</li>)}</ul>
      </details>)}
    </div>
    <div><h4>规则（{rules.length}）</h4>
      {rules.length > 0 && <ol>{rules.map((rule, index) => <li key={index}><code>{rule}</code></li>)}</ol>}
    </div>
    <div><h4>规则集（{providers.length}）</h4>
      {providers.map(([name, provider]) => <details key={name}>
        <summary>{name} · {provider.behavior} · {provider.format ?? 'yaml'}</summary>
        <dl><dt>来源</dt><dd>{provider.url}</dd>{provider.path && <><dt>路径</dt><dd>{provider.path}</dd></>}</dl>
      </details>)}
    </div>
  </div>
}
