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
}

export type LocalRuleSet = { name: string; rules: string[]; revision: number; updated_at: string }
export type RuleLibraryResponse = { sources: RuleSource[]; localSets: LocalRuleSet[] }

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

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void api<RuleLibraryResponse>(ruleLibraryPath, { signal: abort.signal }).then(setLibrary)
      .catch(cause => { if (!abort.signal.aborted) setError(templateError(cause)) })
    return () => abort.abort()
  }, [open])

  const save = async (event: FormEvent, local: boolean) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api(local ? `${ruleLibraryPath}/local` : ruleLibraryPath, { method: 'POST', body: jsonBody(local
        ? { name: localName, rules: localRules.split('\n').map(rule => rule.trim()).filter(Boolean) }
        : { url: url.trim(), behavior, format }) })
      setNotice(local ? '自建规则集已保存' : '规则源已验证')
    } catch (cause) {
      setError(templateError(cause))
    } finally {
      try { setLibrary(await api<RuleLibraryResponse>(ruleLibraryPath)) }
      catch (cause) { setError(templateError(cause)) }
      setBusy(false)
    }
  }

  return <section className="data-section sys-section ops-template">
    <DataHeader title="规则库" />
    <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>规则来源</summary>
      <div className="form-stack">
        <p>系统默认包含私网直连和 MATCH 兜底</p>
        <form className="form-stack" onSubmit={event => { void save(event, true) }}>
          <FormField label="自建规则集名称" htmlFor="local-rules-name">
            <Input id="local-rules-name" value={localName} maxLength={80} required disabled={busy} onChange={event => setLocalName(event.currentTarget.value)} />
          </FormField>
          <FormField label="自建规则（每行一条）" htmlFor="local-rules-lines">
            <Textarea id="local-rules-lines" rows={4} value={localRules} maxLength={100_000} required disabled={busy} onChange={event => setLocalRules(event.currentTarget.value)} />
          </FormField>
          <div><button className="button secondary" disabled={busy} type="submit">保存自建规则集</button></div>
        </form>
        {library.localSets.map(source => <div key={source.name}>
          <button className="button secondary" type="button" onClick={() => { setLocalName(source.name); setLocalRules(source.rules.join('\n')) }}>{source.name} · v{source.revision}</button>
        </div>)}
        <form className="form-stack" onSubmit={event => { void save(event, false) }}>
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
          <div><button className="button secondary" disabled={busy} type="submit">{busy ? '正在抓取' : '单次抓取'}</button></div>
        </form>
        {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
        {error && <StatusMessage tone="error">{error}</StatusMessage>}
        {library.sources.map(source => <details key={JSON.stringify([source.url, source.behavior, source.format])}>
          <summary>{source.url}</summary>
          <p>{source.behavior} · {source.format} · {source.version ? `版本 ${source.version.slice(0, 12)}` : '待验证'}</p>
          <p>{source.last_success_at ? `最后成功 ${templateDate(source.last_success_at)}` : '暂无成功记录'}{source.error_code ? ` · ${source.error_code}` : ''}</p>
          <button className="button secondary" type="button" onClick={() => {
            setUrl(source.url); setBehavior(source.behavior); setFormat(source.format)
          }}>选用此来源</button>
        </details>)}
      </div>
    </details>
  </section>
}
