import { useEffect, useMemo, useState } from 'react'
import { parse, stringify } from 'yaml'
import { FormSelect, Input, Textarea } from '../../ui/Controls'
import { FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { api, subscriptionTemplatesPath, type TemplateStructure } from '../../app/api'
import type { RuleLibraryResponse } from './RuleLibrary'

const PRIVATE_RULES = [
  'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
  'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
  'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
]

type Group = TemplateStructure['proxy-groups'][number]
type Template = TemplateStructure & { subpanel?: { client?: { dns?: { enable: boolean; nameserver?: string[] } } } }

export function BasicTemplateFields({ yaml, onChange, disabled }: { yaml: string; onChange: (value: string) => void; disabled: boolean }) {
  const template = useMemo(() => {
    try {
      const data = parse(yaml, { maxAliasCount: 0 }) as Template
      return Array.isArray(data?.['proxy-groups']) && data['proxy-groups'].every(group =>
        group && typeof group.name === 'string' && typeof group.type === 'string' && Array.isArray(group.proxies)) &&
        Array.isArray(data.rules) && data.rules.every(rule => typeof rule === 'string') ? data : null
    } catch { return null }
  }, [yaml])
  const [library, setLibrary] = useState<RuleLibraryResponse>({ sources: [], localSets: [] })
  useEffect(() => {
    const abort = new AbortController()
    void api<RuleLibraryResponse>(`${subscriptionTemplatesPath}/rule-sources`, { signal: abort.signal })
      .then(result => setLibrary({ ...result, sources: result.sources.filter(source => source.version && !source.error_code && !source.nativeSingbox) }))
      .catch(() => { /* The full rule library reports fetch errors. */ })
    return () => abort.abort()
  }, [])
  const [ruleSource, setRuleSource] = useState('custom')
  const [ruleText, setRuleText] = useState(() => template?.rules.join('\n') ?? '')
  if (!template) return <StatusMessage tone="warning">请在高级模式修复 YAML 后使用基础模式</StatusMessage>

  const save = (value: Template) => onChange(stringify(value, { lineWidth: 0 }))
  const groups = template['proxy-groups']
  const editGroup = (index: number, group: Group) => {
    // Options specific to the previous strategy become invalid after a type change.
    const next = groups[index].type === group.type ? group : { name: group.name, type: group.type, proxies: group.proxies }
    save({ ...template, 'proxy-groups': groups.map((current, item) => item === index ? next : current) })
  }
  const editRules = (text: string) => {
    setRuleText(text)
    save({ ...template, rules: text.split('\n').map(rule => rule.trim()).filter(Boolean) })
  }

  return <fieldset disabled={disabled} className="form-stack template-basic">
    <legend>Mihomo 策略与规则</legend>
    {groups.map((group, index) => <div className="form-stack" key={index}>
      <FormField label={`策略组 ${index + 1}`} htmlFor={`group-name-${index}`}>
        <Input id={`group-name-${index}`} value={group.name} onChange={event => editGroup(index, { ...group, name: event.currentTarget.value })} />
      </FormField>
      <FormField label="策略类型" htmlFor={`group-type-${index}`}>
        <FormSelect id={`group-type-${index}`} value={group.type} onChange={event => editGroup(index, { ...group, type: event.currentTarget.value as Group['type'] })}>
          <option value="select">手动选择</option><option value="url-test">URL 测速</option>
          <option value="fallback">故障转移</option><option value="load-balance">负载均衡</option>
        </FormSelect>
      </FormField>
      <FormField label="成员（逗号分隔）" htmlFor={`group-members-${index}`}>
        <Input id={`group-members-${index}`} value={group.proxies.join(',')} onChange={event => editGroup(index, { ...group, proxies: event.currentTarget.value.split(',') })} />
      </FormField>
      {groups.length > 1 && <div><button className="button secondary" type="button" onClick={() =>
        save({ ...template, 'proxy-groups': groups.filter((_, item) => item !== index) })}>移除该组</button></div>}
    </div>)}
    <div><button className="button secondary" type="button" onClick={() => {
      let number = groups.length + 1
      while (groups.some(group => group.name === `Proxy ${number}`)) number++
      save({ ...template, 'proxy-groups': [...groups, { name: `Proxy ${number}`, type: 'select', proxies: ['$SUBPANEL_NODES'] }] })
    }}>添加策略组</button></div>
    <FormField label="规则源" htmlFor="template-rule-source">
      <FormSelect id="template-rule-source" value={ruleSource} onChange={event => setRuleSource(event.currentTarget.value)}>
        <option value="custom">管理员自建规则</option><option value="default">系统默认私网规则</option>
        {library.localSets.map((source, index) => <option key={source.name} value={`local:${index}`}>{source.name} · 自建 v{source.revision}</option>)}
        {library.sources.map((source, index) => <option key={JSON.stringify(source)} value={`remote:${index}`}>{source.url.split('/').at(-1)} · 已验证远程来源</option>)}
        {Object.keys(template['rule-providers'] ?? {}).map(name => <option key={name} value={`provider:${name}`}>{name} · 远程</option>)}
      </FormSelect>
    </FormField>
    {ruleSource !== 'custom' && <div><button className="button secondary" type="button" onClick={() => {
      const rules = [...template.rules]
      const index = rules.findIndex(rule => /^MATCH\s*,/u.test(rule))
      const providers = { ...template['rule-providers'] }
      let providerName = ruleSource.slice(9)
      if (ruleSource.startsWith('remote:')) {
        const source = library.sources[Number(ruleSource.slice(7))]
        if (!source) return
        const existing = Object.entries(providers).find(([, provider]) =>
          source.url === provider.url && source.behavior === provider.behavior && source.format === (provider.format ?? 'yaml'))
        let number = Object.keys(providers).length + 1
        while (Object.hasOwn(providers, `remote-${number}`)) number++
        providerName = existing?.[0] ?? `remote-${number}`
        providers[providerName] = { type: 'http', url: source.url, behavior: source.behavior, format: source.format }
      }
      const additions = ruleSource === 'default' ? PRIVATE_RULES
        : ruleSource.startsWith('local:') ? library.localSets[Number(ruleSource.slice(6))]?.rules ?? []
        : [`RULE-SET,${providerName},${groups[0]?.name ?? 'DIRECT'}`]
      rules.splice(index < 0 ? rules.length : index, 0, ...additions.filter(rule => !rules.includes(rule)))
      setRuleText(rules.join('\n'))
      save({ ...template, rules, ...(Object.keys(providers).length && { 'rule-providers': providers }) })
    }}>插入规则</button></div>}
    <FormField label="按优先级排列的规则（每行一条）" htmlFor="template-rules" wide>
      <Textarea id="template-rules" rows={5} value={ruleText} onChange={event => editRules(event.currentTarget.value)} />
    </FormField>
    <label><input type="checkbox" checked={template.subpanel?.client?.dns?.enable ?? false} onChange={event => {
      const enable = event.currentTarget.checked
      save({ ...template, subpanel: { ...template.subpanel, client: { ...template.subpanel?.client,
        dns: { nameserver: ['https://1.1.1.1/dns-query'], ...template.subpanel?.client?.dns, enable } } } })
    }} /> 启用 Mihomo DNS</label>
  </fieldset>
}
