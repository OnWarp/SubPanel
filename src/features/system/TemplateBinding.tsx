import { useId } from 'react'
import type { SubscriptionTemplate, SubscriptionTemplateBinding, TemplateBinding as Binding } from '../../app/api'
import { FormField } from '../../ui/FormField'
import { FormSelect } from '../../ui/Controls'
import { StatusMessage } from '../../ui/StatusMessage'
import { versionLabel } from './template-display'

export function TemplateBinding({ value, onChange, options, effective, busy, error, onRetry }: {
  value: SubscriptionTemplateBinding
  onChange: (value: SubscriptionTemplateBinding) => void
  options: SubscriptionTemplate[]
  effective: Binding['effectiveTemplate']
  busy: boolean
  error: string
  onRetry: () => void
}) {
  const id = useId()
  return <div className="form-stack">
    <FormField label="附加配置" htmlFor={id}>
      <FormSelect id={id} disabled={busy || Boolean(error)} value={value.mode} onChange={(event) => {
        const mode = event.currentTarget.value
        const expectedRevision = value.expectedRevision
        if (mode === 'specific') onChange({ mode, templateId: '', expectedRevision })
        else if (mode === 'inherit' || mode === 'base') onChange({ mode, expectedRevision })
      }}>
        <option value="inherit">继承默认</option>
        <option value="base">基础配置</option>
        <option value="specific">指定模板</option>
      </FormSelect>
    </FormField>
    {value.mode === 'specific' && <FormField label="指定模板" htmlFor={`${id}-template`}>
      <FormSelect id={`${id}-template`} disabled={busy || Boolean(error)} required value={value.templateId}
        onChange={(event) => onChange({ ...value, templateId: event.currentTarget.value })}>
        <option value="">请选择已发布模板</option>
        {options.map((row) => <option key={row.id} value={row.id}>{row.name} · {versionLabel(row.publishedSequence)}</option>)}
      </FormSelect>
    </FormField>}
    {error ? <div className="template-actions"><StatusMessage tone="error">{error}</StatusMessage>
      <button className="button secondary" type="button" disabled={busy} onClick={onRetry}>重试加载附加配置</button>
    </div> : <p className="sys-hint">
      {busy ? '正在加载附加配置' : `当前生效：${effective ? `${effective.templateName} · ${versionLabel(effective.sequence)}` : '基础配置'}`}
    </p>}
  </div>
}
