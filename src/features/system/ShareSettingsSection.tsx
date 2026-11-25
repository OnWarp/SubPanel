import { Input, FormSelect } from '../../ui/Controls'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, peekApi, watchApi, ApiClientError } from '../../app/api'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { Section } from '../../ui/Section'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/Toast'

export type ShareSettings = {
  enabled: boolean
  createAllowed: boolean
  maxSharesPerSubscription: number
  maxActiveSharesPerUser: number
  maxValidityDays: number
  defaultAllowOriginalLink: boolean
  defaultAccessControl: 'none' | 'password'
  requireLoginDefault: boolean
  publicBaseUrl: string
}

type SettingsForm = {
  enabled: boolean
  createAllowed: boolean
  maxSharesPerSubscription: string
  maxActiveSharesPerUser: string
  maxValidityDays: string
  defaultAllowOriginalLink: boolean
  defaultAccessControl: 'none' | 'password'
  requireLoginDefault: boolean
  publicBaseUrl: string
}

type SettingsErrors = Partial<Record<'maxSharesPerSubscription' | 'maxActiveSharesPerUser' | 'maxValidityDays' | 'publicBaseUrl', string>>

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function canonicalBaseUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    if (url.pathname !== '/' && url.pathname !== '') return null
    return url.origin
  } catch {
    return null
  }
}

function toSettingsForm(settings: ShareSettings): SettingsForm {
  return {
    enabled: settings.enabled,
    createAllowed: settings.createAllowed,
    maxSharesPerSubscription: String(settings.maxSharesPerSubscription),
    maxActiveSharesPerUser: String(settings.maxActiveSharesPerUser),
    maxValidityDays: String(settings.maxValidityDays),
    defaultAllowOriginalLink: settings.defaultAllowOriginalLink,
    defaultAccessControl: settings.defaultAccessControl,
    requireLoginDefault: settings.requireLoginDefault,
    publicBaseUrl: settings.publicBaseUrl,
  }
}

function parseSettingsForm(form: SettingsForm): { settings: ShareSettings | null; errors: SettingsErrors } {
  const errors: SettingsErrors = {}
  const maxShares = Number(form.maxSharesPerSubscription)
  if (!Number.isInteger(maxShares) || maxShares < 1 || maxShares > 100) errors.maxSharesPerSubscription = '请输入 1 到 100 的整数'
  const maxActive = Number(form.maxActiveSharesPerUser)
  if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 1_000) errors.maxActiveSharesPerUser = '请输入 1 到 1000 的整数'
  const maxDays = Number(form.maxValidityDays)
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 3_650) errors.maxValidityDays = '请输入 1 到 3650 的整数'
  const publicBaseUrl = canonicalBaseUrl(form.publicBaseUrl)
  if (publicBaseUrl === null) errors.publicBaseUrl = '请输入空值或 http(s) 源站地址，例如 https://share.example.com'
  if (Object.keys(errors).length > 0) return { settings: null, errors }
  return {
    settings: {
      enabled: form.enabled,
      createAllowed: form.createAllowed,
      maxSharesPerSubscription: maxShares,
      maxActiveSharesPerUser: maxActive,
      maxValidityDays: maxDays,
      defaultAllowOriginalLink: form.defaultAllowOriginalLink,
      defaultAccessControl: form.defaultAccessControl,
      requireLoginDefault: form.requireLoginDefault,
      publicBaseUrl: publicBaseUrl ?? '',
    },
    errors,
  }
}

export function ShareSettingsSection() {
  const [form, setForm] = useState<SettingsForm | null>(() => {
    const initial = peekApi<{ settings: ShareSettings }>('/api/admin/share-settings')
    return initial ? toSettingsForm(initial.settings) : null
  })
  const serverForm = useRef(form)
  const [errors, setErrors] = useState<SettingsErrors>({})
  const [loading, setLoading] = useState(() => form === null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/share-settings') === undefined)
    setLoadError('')
    try {
      await watchApi<{ settings: ShareSettings }>('/api/admin/share-settings', (result) => {
        const previous = serverForm.current
        const next = toSettingsForm(result.settings)
        serverForm.current = next
        setForm((current) => current === previous ? next : current)
      })
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载分享设置失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form || saving) return
    const parsed = parseSettingsForm(form)
    if (!parsed.settings) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      const result = await api<{ settings: ShareSettings }>('/api/admin/share-settings', {
        method: 'PUT',
        body: JSON.stringify(parsed.settings),
      })
      serverForm.current = toSettingsForm(result.settings)
      setForm(serverForm.current)
      toast.notify('分享设置已保存')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存分享设置失败'))
    } finally {
      setSaving(false)
    }
  }

  const ready = !loading && !loadError && form

  return (
    <form id="ops-share-settings" className="sys-share-settings" onSubmit={save} noValidate>
      <Section title="分享开关" actions={
        ready ? <button className="button primary" type="submit" disabled={saving}>{saving ? '保存中' : '保存设置'}</button> : undefined
      }>
        {loading ? <LoadingState label="正在加载分享设置" /> : null}
        {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
        {ready ? (
          <div className="sys-form">
            <p className="sys-hint">分享功能开关控制普通用户的分享权限，管理员仍可分享。关闭期间所有分享链接暂停访问</p>
            <div className="sys-toggles">
              <FormField label="创建分享">
                <Switch checked={form.createAllowed} disabled={saving} ariaLabel="允许创建分享" onChange={(createAllowed) => setForm({ ...form, createAllowed })} />
              </FormField>
            </div>
          </div>
        ) : null}
      </Section>
      {ready ? (
        <>
          <Section title="默认策略">
            <div className="sys-form">
              <div className="sys-toggles">
                <FormField label="默认允许原始链接">
                  <Switch checked={form.defaultAllowOriginalLink} disabled={saving} ariaLabel="默认允许原始链接" onChange={(defaultAllowOriginalLink) => setForm({ ...form, defaultAllowOriginalLink })} />
                </FormField>
                <FormField label="默认要求登录">
                  <Switch checked={form.requireLoginDefault} disabled={saving} ariaLabel="默认要求登录" onChange={(requireLoginDefault) => setForm({ ...form, requireLoginDefault })} />
                </FormField>
              </div>
              <FormField label="默认访问保护" htmlFor="sys-share-access-control">
                <FormSelect id="sys-share-access-control" value={form.defaultAccessControl} disabled={saving} onChange={(event) => setForm({ ...form, defaultAccessControl: event.currentTarget.value === 'password' ? 'password' : 'none' })}>
                  <option value="none">无访问密码</option>
                  <option value="password">访问密码</option>
                </FormSelect>
              </FormField>
              <FormField label="公网基址" htmlFor="sys-share-public-base" error={errors.publicBaseUrl}>
                <Input id="sys-share-public-base" type="url" placeholder="https://share.example.com" value={form.publicBaseUrl} disabled={saving} onChange={(event) => setForm({ ...form, publicBaseUrl: event.currentTarget.value })} />
              </FormField>
              <p className="sys-hint">公网基址留空时使用当前访问地址</p>
            </div>
          </Section>
          <Section title="分享限额">
            <div className="sys-form sys-share-limits">
              <FormField label="单订阅分享上限" htmlFor="sys-share-max-shares" error={errors.maxSharesPerSubscription}>
                <Input id="sys-share-max-shares" type="number" inputMode="numeric" min={1} max={100} step={1} value={form.maxSharesPerSubscription} disabled={saving} onChange={(event) => setForm({ ...form, maxSharesPerSubscription: event.currentTarget.value })} />
              </FormField>
              <FormField label="单用户有效分享上限" htmlFor="sys-share-max-active" error={errors.maxActiveSharesPerUser}>
                <Input id="sys-share-max-active" type="number" inputMode="numeric" min={1} max={1000} step={1} value={form.maxActiveSharesPerUser} disabled={saving} onChange={(event) => setForm({ ...form, maxActiveSharesPerUser: event.currentTarget.value })} />
              </FormField>
              <FormField label="最长有效期（天）" htmlFor="sys-share-max-days" error={errors.maxValidityDays}>
                <Input id="sys-share-max-days" type="number" inputMode="numeric" min={1} max={3650} step={1} value={form.maxValidityDays} disabled={saving} onChange={(event) => setForm({ ...form, maxValidityDays: event.currentTarget.value })} />
              </FormField>
            </div>
          </Section>
          <div className="content-danger-zone">
            <FormField label="分享功能">
              <Switch checked={form.enabled} disabled={saving} ariaLabel="分享功能" onChange={(enabled) => setForm({ ...form, enabled })} />
            </FormField>
            <p className="sys-hint">关闭后仅管理员可创建分享，所有分享链接暂停访问</p>
          </div>
        </>
      ) : null}
    </form>
  )
}
