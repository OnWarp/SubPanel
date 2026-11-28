import { useEffect, useMemo, useState } from 'react'
import { api, jsonBody, type CatalogGroup, type CatalogResponse } from '../../app/api'
import { Checkbox, FormSelect, Input, Textarea } from '../../ui/Controls'
import { Dialog } from '../../ui/Dialog'
import { FormField } from '../../ui/FormField'
import { SearchInput } from '../../ui/SearchInput'
import { StatusMessage } from '../../ui/StatusMessage'
import { Switch } from '../../ui/Switch'
import { DAY_SECONDS, DURATION_PRESETS, errorText, type PlanDefinition, type PlanGroup } from './model'

type DurationMode = '7' | '30' | '90' | '365' | 'custom' | 'permanent'
type Preview = { nodeCount: number; nodeGroups: PlanGroup[]; emptyGroupIds: string[] }

function durationState(seconds: number | null): { mode: DurationMode; customDays: string } {
  if (seconds === null) return { mode: 'permanent', customDays: '30' }
  const days = seconds / DAY_SECONDS
  if (Number.isInteger(days) && (DURATION_PRESETS as readonly number[]).includes(days)) {
    return { mode: String(days) as DurationMode, customDays: '30' }
  }
  return { mode: 'custom', customDays: String(Math.max(1, Math.round(days))) }
}

function durationSeconds(mode: DurationMode, customDays: string) {
  if (mode === 'permanent') return null
  const days = mode === 'custom' ? Number(customDays) : Number(mode)
  if (!Number.isInteger(days) || days <= 0) return undefined
  return days * DAY_SECONDS
}

export function PlanEditor({
  plan, onClose, onSaved,
}: {
  plan: PlanDefinition | null
  onClose: () => void
  onSaved: () => void
}) {
  const initialDuration = durationState(plan?.duration_seconds ?? 30 * DAY_SECONDS)
  const [name, setName] = useState(plan?.name ?? '')
  const [description, setDescription] = useState(plan?.description ?? '')
  const [note, setNote] = useState(plan?.note ?? '')
  const [enabled, setEnabled] = useState(plan ? plan.enabled === 1 : true)
  const [mode, setMode] = useState<DurationMode>(plan ? initialDuration.mode : '30')
  const [customDays, setCustomDays] = useState(initialDuration.customDays)
  const [groupIds, setGroupIds] = useState<string[]>(plan?.nodeGroupIds ?? [])
  const [groupQuery, setGroupQuery] = useState('')
  const [groups, setGroups] = useState<CatalogGroup[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const baseline = JSON.stringify({
    name: plan?.name ?? '', description: plan?.description ?? '', note: plan?.note ?? '',
    enabled: plan ? plan.enabled === 1 : true, mode: plan ? initialDuration.mode : '30',
    customDays: initialDuration.customDays, groupIds: plan?.nodeGroupIds ?? [],
  })
  const dirty = baseline !== JSON.stringify({ name, description, note, enabled, mode, customDays, groupIds })

  useEffect(() => {
    const controller = new AbortController()
    void api<CatalogResponse>('/api/admin/catalog', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setGroups(result.groups) })
      .catch((cause) => { if (!controller.signal.aborted) setError(errorText(cause, '加载节点组失败')) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!groupIds.length) {
      setPreview(null)
      setPreviewError('')
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void api<Preview>('/api/admin/plans/preview', {
        method: 'POST', body: jsonBody({ nodeGroupIds: groupIds }), signal: controller.signal,
      }).then((result) => {
        if (controller.signal.aborted) return
        setPreview(result)
        setPreviewError('')
      }).catch((cause) => {
        if (!controller.signal.aborted) setPreviewError(errorText(cause, '无法计算节点数'))
      })
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [groupIds])

  const visibleGroups = useMemo(() => {
    const needle = groupQuery.trim().toLowerCase()
    if (!needle) return groups
    return groups.filter((group) => group.name.toLowerCase().includes(needle) || group.id.toLowerCase().includes(needle))
  }, [groupQuery, groups])

  const toggleGroup = (id: string) => {
    setGroupIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])
  }

  const save = async () => {
    const seconds = durationSeconds(mode, customDays)
    if (!name.trim()) {
      setError('请填写套餐名称')
      return
    }
    if (!groupIds.length) {
      setError('请至少选择一个节点组')
      return
    }
    if (seconds === undefined) {
      setError('请填写大于 0 的天数')
      return
    }
    setBusy(true)
    setError('')
    const body = {
      name: name.trim(), description, nodeGroupIds: groupIds, durationSeconds: seconds, enabled, remark: note.trim() || null,
    }
    try {
      if (plan) {
        await api(`/api/admin/plans/${encodeURIComponent(plan.id)}`, { method: 'PATCH', body: jsonBody({ ...body, version: plan.version }) })
      } else {
        await api('/api/admin/plans', { method: 'POST', body: jsonBody(body) })
      }
      onSaved()
    } catch (cause) {
      setError(errorText(cause, '保存套餐失败'))
    } finally {
      setBusy(false)
    }
  }

  const emptyNames = preview?.nodeGroups.filter((group) => group.empty).map((group) => group.name) ?? []

  return (
    <Dialog
      appearance="content"
      open
      size="l"
      busy={busy}
      dirty={dirty}
      title={plan ? '编辑套餐' : '新建套餐'}
      onClose={onClose}
      footer={(cancel) => <>
        <button className="button secondary" type="button" disabled={busy} onClick={cancel}>取消</button>
        <button className="button primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中' : '保存套餐'}</button>
      </>}
    >
      <div className="form-stack">
        <FormField label="名称" htmlFor="plan-name">
          <Input id="plan-name" aria-label="套餐名称" value={name} maxLength={200} required onChange={(event) => setName(event.currentTarget.value)} />
        </FormField>
        <FormField label="说明" htmlFor="plan-description">
          <Textarea id="plan-description" aria-label="套餐说明" value={description} maxLength={2000} rows={3} onChange={(event) => setDescription(event.currentTarget.value)} />
        </FormField>
        <FormField label="节点组" hintTip="同一节点出现在多个节点组时只计一次。空节点组仍可保存，分配后不会带出节点">
          <SearchInput label="搜索节点组" placeholder="搜索节点组" value={groupQuery} onChange={setGroupQuery} />
          <div className="choice-list" aria-label="节点组">
            {visibleGroups.length ? visibleGroups.map((group) => (
              <label key={group.id} className="choice-row">
                <Checkbox type="checkbox" aria-label={`节点组 ${group.name}`} checked={groupIds.includes(group.id)} onChange={() => toggleGroup(group.id)} />
                <span>{group.name}</span>
              </label>
            )) : <p className="dialog-note">暂无匹配节点组</p>}
          </div>
          <p role="status">已选 {groupIds.length} 个节点组{preview ? ` · 去重后 ${preview.nodeCount} 个节点` : ''}</p>
          {emptyNames.length > 0 ? <StatusMessage tone="warning">{`空节点组：${emptyNames.join('、')}`}</StatusMessage> : null}
          {previewError ? <StatusMessage tone="error">{previewError}</StatusMessage> : null}
        </FormField>
        <FormField label="默认时长" hintTip="分配和生成兑换码时可沿用这里的时长，也可以单独指定">
          <FormSelect aria-label="默认时长" value={mode} onChange={(event) => setMode(event.currentTarget.value as DurationMode)}>
            <option value="7">7 天</option>
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">365 天</option>
            <option value="custom">自定义天数</option>
            <option value="permanent">永久</option>
          </FormSelect>
          {mode === 'custom' ? <Input aria-label="自定义天数" inputMode="numeric" value={customDays} onChange={(event) => setCustomDays(event.currentTarget.value)} /> : null}
        </FormField>
        <Switch label="启用" checked={enabled} onChange={setEnabled} />
        <FormField label="备注" htmlFor="plan-note" hintTip="备注只给管理员看，不会出现在用户订阅里">
          <Textarea id="plan-note" aria-label="套餐备注" value={note} maxLength={2000} rows={2} onChange={(event) => setNote(event.currentTarget.value)} />
        </FormField>
        {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      </div>
    </Dialog>
  )
}
