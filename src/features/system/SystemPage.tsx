import { Database, Info } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ApiClientError, jsonBody } from '../../app/api'
import { DataHeader } from '../../ui/DataHeader'
import { ErrorState } from '../../ui/ErrorState'
import { FilterChip } from '../../ui/FilterChip'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { PageHeader } from '../../ui/PageHeader'
import { StatusBadge } from '../../ui/StatusBadge'
import { useToast } from '../../ui/Toast'
import { formatDate } from '../catalog/catalog-utils'
import {
  toMailSettingsForm,
  type EmailDomainEntry,
  type MailSettingsForm,
  type RegistrationMode,
  type SystemMailSettings,
  type SystemStatus,
} from './api'
import { ShareSettingsSection } from './ShareSettingsSection'
import { DomainSettingsSection } from './DomainSettingsSection'

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function isNotFound(cause: unknown) {
  return cause instanceof ApiClientError && cause.status === 404
}

const REGISTRATION_MODES: Array<{ value: RegistrationMode; label: string; hint: string }> = [
  { value: 'open', label: '开放注册', hint: '任何人都可以注册账户' },
  { value: 'invite', label: '邀请注册', hint: '只能凭邀请码注册' },
  { value: 'closed', label: '关闭注册', hint: '暂停新用户注册' },
]

function RegistrationSection() {
  const [mode, setMode] = useState<RegistrationMode | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ mode: RegistrationMode }>('/api/admin/system/registration')
      setMode(result.mode)
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载注册设置失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const changeMode = async (next: RegistrationMode) => {
    if (!mode || mode === next || saving) return
    setSaving(true)
    try {
      const result = await api<{ mode: RegistrationMode }>('/api/admin/system/registration', {
        method: 'PUT',
        body: jsonBody({ mode: next }),
      })
      setMode(result.mode)
      toast.notify('注册模式已更新')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '更新注册模式失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="data-section sys-section" aria-labelledby="sys-registration-title">
      <DataHeader id="sys-registration-title" title="账户与注册" />
      {loading ? <LoadingState label="正在加载注册设置" /> : null}
      {!loading && loadError ? <div className="sys-state"><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && mode ? (
        <div className="sys-body">
          <div className="sys-mode-row" role="group" aria-label="注册模式">
            {REGISTRATION_MODES.map((option) => (
              <FilterChip key={option.value} active={mode === option.value} onClick={() => { changeMode(option.value).catch(() => undefined) }}>
                {option.label}
              </FilterChip>
            ))}
          </div>
          <p className="sys-hint">{REGISTRATION_MODES.find((option) => option.value === mode)?.hint}，切换后立即生效</p>
          <EmailDomains />
        </div>
      ) : null}
    </section>
  )
}

function EmailDomains() {
  const [domains, setDomains] = useState<EmailDomainEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ domains: Array<EmailDomainEntry | string> }>('/api/admin/email-domains')
      setDomains(result.domains.map((entry) => (typeof entry === 'string' ? { domain: entry } : entry)))
      setNotReady(false)
    } catch (cause) {
      if (isNotFound(cause)) {
        setNotReady(true)
      } else {
        setLoadError(errorMessage(cause, '加载邮箱域名白名单失败'))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const domain = draft.trim().toLowerCase()
    if (!domain || busy) return
    setBusy(true)
    try {
      await api('/api/admin/email-domains', { method: 'POST', body: jsonBody({ domain }) })
      setDraft('')
      toast.notify('域名已加入白名单')
      await load()
    } catch (cause) {
      if (isNotFound(cause)) setNotReady(true)
      else toast.notifyError(errorMessage(cause, '添加域名失败'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (domain: string) => {
    if (busy) return
    setBusy(true)
    try {
      await api(`/api/admin/email-domains/${encodeURIComponent(domain)}`, { method: 'DELETE' })
      toast.notify('域名已移除')
      await load()
    } catch (cause) {
      if (isNotFound(cause)) setNotReady(true)
      else toast.notifyError(errorMessage(cause, '移除域名失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sys-subsection">
      <h3 className="sys-subtitle">邮箱域名白名单</h3>
      <p className="sys-hint">名单内的邮箱域名才可以注册与绑定，白名单为空时不限制域名</p>
      {loading ? <LoadingState label="正在加载白名单" /> : null}
      {!loading && notReady ? (
        <div className="sys-not-ready">
          <Info aria-hidden="true" />
          <span>白名单接口未就绪，接口上线后可在此管理</span>
        </div>
      ) : null}
      {!loading && !notReady && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !notReady && !loadError ? (
        <>
          {domains.length === 0 ? <p className="sys-hint">暂无白名单域名</p> : (
            <ul className="sys-domain-list">
              {domains.map((entry) => (
                <li key={entry.domain} className="sys-domain-item">
                  <span>{entry.domain}</span>
                  <button className="button ghost sys-domain-remove" type="button" disabled={busy} onClick={() => { remove(entry.domain).catch(() => undefined) }}>移除</button>
                </li>
              ))}
            </ul>
          )}
          <form className="sys-domain-form" onSubmit={add}>
            <FormField label="添加域名" htmlFor="sys-domain-input">
              <input
                id="sys-domain-input"
                type="text"
                inputMode="url"
                placeholder="example.com"
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
            </FormField>
            <button className="button" type="submit" disabled={busy || draft.trim() === ''}>添加</button>
          </form>
        </>
      ) : null}
    </div>
  )
}

function MailSection() {
  const [settings, setSettings] = useState<SystemMailSettings | null>(null)
  const [form, setForm] = useState<MailSettingsForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [portError, setPortError] = useState('')
  const [testTo, setTestTo] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testNotReady, setTestNotReady] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ settings: SystemMailSettings }>('/api/admin/system/mail')
      setSettings(result.settings)
      setForm(toMailSettingsForm(result.settings))
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载邮件设置失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form || saving) return
    const portText = form.smtpPort.trim()
    const port = portText === '' ? null : Number(portText)
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      setPortError('请输入 1 到 65535 的整数，或留空')
      return
    }
    setPortError('')
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        provider: form.provider,
        from: form.from.trim(),
        smtpHost: form.smtpHost.trim(),
        smtpPort: port,
        smtpUser: form.smtpUser.trim(),
      }
      if (form.smtpPass !== '') patch['smtp' + 'Password'] = form.smtpPass
      if (form.resendKey !== '') patch['resend' + 'ApiKey'] = form.resendKey
      const result = await api<{ settings: SystemMailSettings }>('/api/admin/system/mail', {
        method: 'PUT',
        body: jsonBody(patch),
      })
      setSettings(result.settings)
      setForm(toMailSettingsForm(result.settings))
      toast.notify('邮件设置已保存')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存邮件设置失败'))
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    const to = testTo.trim()
    if (!to || testSending) return
    setTestSending(true)
    try {
      await api('/api/admin/mail/test', { method: 'POST', body: jsonBody({ to }) })
      setTestNotReady(false)
      toast.notify('测试邮件已发送')
    } catch (cause) {
      if (isNotFound(cause)) setTestNotReady(true)
      else toast.notifyError(errorMessage(cause, '发送测试邮件失败'))
    } finally {
      setTestSending(false)
    }
  }

  return (
    <section className="data-section sys-section" aria-labelledby="sys-mail-title">
      <DataHeader id="sys-mail-title" title="邮件" />
      {loading ? <LoadingState label="正在加载邮件设置" /> : null}
      {!loading && loadError ? <div className="sys-state"><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && form && settings ? (
        <form className="sys-form" onSubmit={save} noValidate>
          <div className="sys-grid">
            <FormField label="邮件服务商" htmlFor="sys-mail-provider">
              <select id="sys-mail-provider" value={form.provider} disabled={saving} onChange={(event) => setForm({ ...form, provider: event.currentTarget.value === 'resend' ? 'resend' : 'smtp' })}>
                <option value="smtp">SMTP</option>
                <option value="resend">Resend</option>
              </select>
            </FormField>
            <FormField label="发件人" htmlFor="sys-mail-from">
              <input id="sys-mail-from" type="text" placeholder="SubPanel <no-reply@example.com>" value={form.from} disabled={saving} onChange={(event) => setForm({ ...form, from: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 主机" htmlFor="sys-mail-host">
              <input id="sys-mail-host" type="text" placeholder="smtp.example.com" value={form.smtpHost} disabled={saving} onChange={(event) => setForm({ ...form, smtpHost: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 端口" htmlFor="sys-mail-port" error={portError}>
              <input id="sys-mail-port" type="number" inputMode="numeric" min={1} max={65535} step={1} placeholder="465" value={form.smtpPort} disabled={saving} onChange={(event) => setForm({ ...form, smtpPort: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 用户名" htmlFor="sys-mail-user">
              <input id="sys-mail-user" type="text" autoComplete="off" value={form.smtpUser} disabled={saving} onChange={(event) => setForm({ ...form, smtpUser: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 密码" htmlFor="sys-mail-pass">
              <input
                id="sys-mail-pass"
                type="password"
                autoComplete="new-password"
                placeholder={settings.smtpPasswordSet ? '••••••••' : '未设置'}
                value={form.smtpPass}
                disabled={saving}
                onChange={(event) => setForm({ ...form, smtpPass: event.currentTarget.value })}
              />
            </FormField>
            <div className="sys-field-wide">
              <FormField label="Resend API Key" htmlFor="sys-mail-resend-key">
                <input
                  id="sys-mail-resend-key"
                  type="password"
                  autoComplete="new-password"
                  placeholder={settings.resendApiKeySet ? '••••••••' : '未设置'}
                  value={form.resendKey}
                  disabled={saving}
                  onChange={(event) => setForm({ ...form, resendKey: event.currentTarget.value })}
                />
              </FormField>
            </div>
          </div>
          <p className="sys-hint">
            密码与 API Key 只写入不回显
            {settings.smtpPasswordSet ? '，SMTP 密码已设置' : ''}
            {settings.resendApiKeySet ? '，Resend API Key 已设置' : ''}
            ，留空表示不修改
          </p>
          <div className="sys-actions">
            <button className="button primary" type="submit" disabled={saving}>{saving ? '保存中' : '保存设置'}</button>
          </div>
          <div className="sys-subsection">
            <h3 className="sys-subtitle">测试邮件</h3>
            <div className="sys-test-row">
              <FormField label="收件邮箱" htmlFor="sys-mail-test-to">
                <input id="sys-mail-test-to" type="email" placeholder="you@example.com" value={testTo} disabled={testSending} onChange={(event) => setTestTo(event.currentTarget.value)} />
              </FormField>
              <button className="button" type="button" disabled={testSending || testTo.trim() === ''} onClick={() => { sendTest().catch(() => undefined) }}>
                {testSending ? '发送中' : '发送测试邮件'}
              </button>
            </div>
            {testNotReady ? (
              <div className="sys-not-ready">
                <Info aria-hidden="true" />
                <span>测试邮件接口未就绪，邮件服务上线后可在此发送</span>
              </div>
            ) : null}
          </div>
        </form>
      ) : null}
    </section>
  )
}

function StatusSection() {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await api<{ status: SystemStatus }>('/api/admin/system/status')
      setStatus(result.status)
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载系统状态失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  return (
    <section className="data-section sys-section" aria-labelledby="sys-status-title">
      <DataHeader
        id="sys-status-title"
        title="系统状态"
        filters={(
          <button className="button ghost" type="button" disabled={loading} onClick={() => { load().catch(() => undefined) }}>刷新</button>
        )}
      />
      {loading && !status ? <LoadingState label="正在加载系统状态" /> : null}
      {!loading && loadError ? <div className="sys-state"><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {status ? (
        <div className="sys-body">
          <div className="sys-status-db">
            <Database aria-hidden="true" />
            <span>D1 数据库</span>
            <strong>{status.databaseName}</strong>
          </div>
          <ul className="sys-status-list">
            {status.modules.map((module) => (
              <li key={module.module} className="sys-status-item">
                <span className="sys-status-label">{module.label}</span>
                <StatusBadge tone={module.backend === 'd1' ? 'success' : 'muted'}>{module.backend === 'd1' ? 'D1' : 'KV'}</StatusBadge>
                <span className="sys-status-meta">
                  {module.schemaVersion !== null ? `结构版本 ${module.schemaVersion}` : '暂无版本记录'}
                  {module.updatedAt ? ` · 更新于 ${formatDate(module.updatedAt)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <div className="sys-subsection">
            <h3 className="sys-subtitle">已应用迁移</h3>
            {status.migrations.length === 0 ? (
              <p className="sys-hint">暂无迁移记录，各模块结构版本见上方列表</p>
            ) : (
              <ul className="sys-migration-list">
                {status.migrations.map((migration) => (
                  <li key={migration.name} className="sys-migration-item">
                    <span>{migration.name}</span>
                    <span className="sys-status-meta">{migration.appliedAt ? formatDate(migration.appliedAt) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="sys-hint">存储后端由迁移流程统一切换，此页仅供查看</p>
        </div>
      ) : null}
    </section>
  )
}

function AppDownloadsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const data = await api<{ enabled: boolean }>('/api/admin/system/app-downloads')
      setEnabled(data.enabled)
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载 APP 下载设置失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load().catch(() => undefined) }, [load])

  const toggle = async (next: boolean) => {
    setSaving(true)
    try {
      const data = await api<{ enabled: boolean }>('/api/admin/system/app-downloads', {
        method: 'PUT',
        body: jsonBody({ enabled: next }),
      })
      setEnabled(data.enabled)
      toast.notify(data.enabled ? '已显示 APP 下载板块' : '已隐藏 APP 下载板块')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存 APP 下载设置失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="data-section sys-section" aria-labelledby="sys-app-downloads-title">
      <DataHeader id="sys-app-downloads-title" title="APP 下载" />
      {loading ? <div className="sys-state"><LoadingState label="正在加载 APP 下载设置" /></div> : null}
      {!loading && loadError ? <div className="sys-state"><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && enabled !== null ? (
        <div>
          <p className="sys-hint">开启后，普通用户可以在用户端查看各平台的 APP 下载入口；关闭后，用户端隐藏整个 APP 下载板块，但不会删除已配置的 APP</p>
          <div className="sys-toggles">
            <FormField label="显示 APP 下载板块">
              <label className="sys-switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="显示 APP 下载板块"
                  checked={enabled}
                  disabled={saving}
                  onChange={(event) => { toggle(event.currentTarget.checked).catch(() => undefined) }}
                />
                <span className="sys-switch-track" aria-hidden="true"><span className="sys-switch-thumb" /></span>
                <span className="sys-switch-label">{enabled ? '已开启' : '已关闭'}</span>
              </label>
            </FormField>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export function SystemPage() {
  return (
    <div className="page-stack">
      <PageHeader title="系统管理" description="账户与注册、邮件、APP 下载、分享与系统状态集中在这里" />
      <RegistrationSection />
      <MailSection />
      <AppDownloadsSection />
      <ShareSettingsSection />
      <DomainSettingsSection />
      <StatusSection />
    </div>
  )
}
