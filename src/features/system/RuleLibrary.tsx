import { Dialog } from '../../ui/Dialog'
import { Link } from 'react-router-dom'
import { useEffect, useState, type FormEvent } from 'react'
import { api, jsonBody, subscriptionTemplatesPath } from '../../app/api'
import { DataHeader } from '../../ui/DataHeader'
import { FormField } from '../../ui/FormField'
import { Input, FormSelect, Textarea } from '../../ui/Controls'
import { StatusMessage } from '../../ui/StatusMessage'
import { templateDate, templateError } from './template-display'

const ruleLibraryPath = `${subscriptionTemplatesPath}/rule-sources`
export type RuleSource = {
  url: string
  behavior: 'domain' | 'ipcidr' | 'classical'
  format: 'yaml' | 'text'
  version: string | null
  last_success_at: string | null
  error_code: string | null
  nativeSingbox?: boolean
}

export type LocalRuleSet = { name: string; rules: string[]; revision: number; updated_at: string }
export type RuleLibraryResponse = {
  sources: RuleSource[]; localSets: LocalRuleSet[]
  hasMore?: boolean
  system?: { name: string; revision: number; rules: string[] }
}

type SourceIdentity = { type: 'system' | 'local' | 'remote'; key: string }
type Usage = {
  references: { id: string; name: string; archived: number; sequence: number; platform: string; tag: string
    mode: 'client' | 'inline'; version: string | null; changed: boolean }[]
  next: string | null
}

function RuleUsage({ source }: { source: SourceIdentity }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async (after = '') => {
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({ ...source, after })
      const page = await api<Usage>(`${ruleLibraryPath}/usage?${query}`)
      setUsage(previous => ({ ...page, references: after ? [...(previous?.references ?? []), ...page.references] : page.references }))
    } catch (cause) {
      setError(templateError(cause))
    } finally {
      setLoading(false)
    }
  }
  return <div className="form-stack">
    <div><button className="button secondary" type="button" disabled={loading} onClick={() => void load()}>
      {loading ? '正在查询' : '查看已发布配置引用'}
    </button></div>
    {error && <StatusMessage tone="error">{error}</StatusMessage>}
    {usage && (!usage.references.length ? <p>暂无已发布配置引用</p> : <ul>{usage.references.map(item =>
      <li key={JSON.stringify([item.id, item.platform, item.tag])}>
        <Link to={`/delivery/conversions?config=${encodeURIComponent(item.id)}`}>{item.name}</Link>
        {' · '}v{item.sequence} · {item.platform === 'singbox' ? 'sing-box' : 'Mihomo'} · {item.tag}
        {' · '}{item.mode === 'client' ? '客户端下载' : '发布时内嵌'}
        {item.version ? ` · 规则版本 ${item.version.slice(0, 12)}` : item.mode === 'inline' ? ' · 历史版本未记录' : ''}
        {item.changed ? ' · 来源已更新，重新发布后生效' : ''}
        {item.archived ? ' · 已归档' : ''}
      </li>,
    )}</ul>)}
    {usage?.next && <div><button className="button secondary" type="button" disabled={loading}
      onClick={() => void load(usage.next!)}>加载更多引用</button></div>}
  </div>
}

export function RuleLibrary() {
  const [library, setLibrary] = useState<RuleLibraryResponse>({ sources: [], localSets: [] })
  const [localName, setLocalName] = useState('')
  const [localRules, setLocalRules] = useState('')
  const [url, setUrl] = useState('')
  const [behavior, setBehavior] = useState('domain')
  const [format, setFormat] = useState('yaml')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState(false)
  const [editor, setEditor] = useState<'local' | 'remote' | null>(null)
  const [baseline, setBaseline] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void api<RuleLibraryResponse>(`${ruleLibraryPath}?page=${page}`, { signal: abort.signal }).then(setLibrary)
      .catch(cause => { if (!abort.signal.aborted) setError(templateError(cause)) })
    return () => abort.abort()
  }, [open, page])

  const save = async (event: FormEvent, local: boolean) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(local ? `${ruleLibraryPath}/local` : ruleLibraryPath, { method: 'POST', body: jsonBody(local
        ? { name: localName, rules: localRules.split('\n').map(rule => rule.trim()).filter(Boolean) }
        : { url: url.trim(), behavior, format }) })
      setNotice(local ? '自建规则集已保存' : '规则源已验证')
      setEditor(null)
    } catch (cause) {
      setError(templateError(cause))
    } finally {
      try { setLibrary(await api<RuleLibraryResponse>(`${ruleLibraryPath}?page=${page}`)) }
      catch (cause) { setError(templateError(cause)) }
      setBusy(false)
    }
  }

  const openLocal = (name: string, rules: string) => {
    setLocalName(name)
    setLocalRules(rules)
    setBaseline(JSON.stringify([name, rules]))
    setError('')
    setEditor('local')
  }
  const openRemote = (address: string, type: string, encoding: string) => {
    setUrl(address)
    setBehavior(type)
    setFormat(encoding)
    setBaseline(JSON.stringify([address, type, encoding]))
    setError('')
    setEditor('remote')
  }

  return <section className="data-section sys-section ops-template">
    <DataHeader title="规则库" />
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>规则来源</summary>
      <div className="form-stack">
        <h3>系统规则</h3>
        {library.system && <details>
          <summary>{library.system.name} · v{library.system.revision}</summary>
          <p>随系统发布 · 可在 Mihomo 基础编辑器插入，或在 sing-box 的 localRuleSets 中指定出站</p>
          <ul>{library.system.rules.map(rule => <li key={rule}>{rule}</li>)}</ul>
          <RuleUsage source={{ type: 'system', key: library.system.name }} />
        </details>}
        <h3>管理员自建</h3>
        <button className="button secondary" type="button" onClick={() => openLocal('', '')}>新建自建规则集</button>
        <Dialog open={editor === 'local'} title="编辑自建规则集" size="xl" busy={busy}
          dirty={editor === 'local' && baseline !== JSON.stringify([localName, localRules])} onClose={() => { setEditor(null); setError('') }}
          footer={cancel => <>
            <button className="button secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
            <button className="button primary" form="local-rule-editor" type="submit" disabled={busy}>保存自建规则集</button>
          </>}>
          <form id="local-rule-editor" className="form-stack" onSubmit={event => { void save(event, true) }}>
            <FormField label="自建规则集名称" htmlFor="local-rules-name">
              <Input id="local-rules-name" value={localName} maxLength={80} required disabled={busy} onChange={event => setLocalName(event.currentTarget.value)} />
            </FormField>
            <FormField label="自建规则（每行一条）" htmlFor="local-rules-lines">
              <Textarea id="local-rules-lines" rows={4} value={localRules} maxLength={100_000} required disabled={busy} onChange={event => setLocalRules(event.currentTarget.value)} />
            </FormField>
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
          </form>
        </Dialog>
        {library.localSets.map(source => <div key={source.name}>
          <button className="button secondary" type="button" onClick={() => { openLocal(source.name, source.rules.join('\n')) }}>{source.name} · v{source.revision}</button>
          <p>最后保存 {templateDate(source.updated_at)}</p>
          <RuleUsage key={source.revision} source={{ type: 'local', key: source.name }} />
        </div>)}
        <h3>远程规则集</h3>
        <button className="button secondary" type="button" onClick={() => openRemote('', 'domain', 'yaml')}>添加远程规则集</button>
        <Dialog open={editor === 'remote'} title="配置远程规则集" size="xl" busy={busy}
          dirty={editor === 'remote' && baseline !== JSON.stringify([url, behavior, format])} onClose={() => { setEditor(null); setError('') }}
          footer={cancel => <>
            <button className="button secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
            <button className="button primary" form="remote-rule-editor" type="submit" disabled={busy}>{busy ? '正在抓取' : '单次抓取'}</button>
          </>}>
          <form id="remote-rule-editor" className="form-stack" onSubmit={event => { void save(event, false) }}>
            <FormField label="远程规则源 HTTPS 地址" htmlFor="rule-source-url">
              <Input id="rule-source-url" type="url" value={url} maxLength={2048} required disabled={busy} onChange={event => setUrl(event.currentTarget.value)} />
            </FormField>
            <FormField label="规则类型" htmlFor="rule-source-behavior">
              <FormSelect id="rule-source-behavior" value={behavior} disabled={busy} onChange={event => setBehavior(event.currentTarget.value)}>
                <option value="domain">域名</option><option value="ipcidr">IP 段</option><option value="classical">经典规则</option>
              </FormSelect>
            </FormField>
            <FormField label="格式" htmlFor="rule-source-format">
              <FormSelect id="rule-source-format" value={format} disabled={busy} onChange={event => setFormat(event.currentTarget.value)}>
                <option value="yaml">YAML</option><option value="text">文本</option>
              </FormSelect>
            </FormField>
            <p>支持 raw.githubusercontent.com 和 cdn.jsdelivr.net 的公开文件</p>
            <p>验证 sing-box 原生规则集时，使用固定 GitHub 提交的 JSON 地址，并选择经典规则和文本</p>
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
          </form>
        </Dialog>
        {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
        {!editor && error && <StatusMessage tone="error">{error}</StatusMessage>}
        {library.sources.map(source => <details key={JSON.stringify([source.url, source.behavior, source.format])}>
          <summary>{source.url}</summary>
          <p>{source.nativeSingbox ? 'sing-box JSON' : `${source.behavior} · ${source.format}`} · {source.version ? `版本 ${source.version.slice(0, 12)}` : '待验证'}</p>
          <p>{source.last_success_at ? `最后成功 ${templateDate(source.last_success_at)}` : '暂无成功记录'}{source.error_code ? ` · ${source.error_code}` : ''}</p>
          <RuleUsage key={source.version} source={{ type: 'remote', key: JSON.stringify([source.url, source.behavior, source.format]) }} />
          <button className="button secondary" type="button" onClick={() => {
            openRemote(source.url, source.behavior, source.format)
          }}>选用此来源</button>
        </details>)}
        {(page > 1 || library.hasMore) && <div className="data-header-actions" aria-label="规则库分页">
          <button className="button secondary" type="button" disabled={busy || page === 1} onClick={() => setPage(value => value - 1)}>上一页</button>
          <span>第 {page} 页</span>
          <button className="button secondary" type="button" disabled={busy || !library.hasMore} onClick={() => setPage(value => value + 1)}>下一页</button>
        </div>}
      </div>
    </details>
  </section>
}
