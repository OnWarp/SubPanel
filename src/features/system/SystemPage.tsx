import { Input, FormSelect } from '../../ui/Controls'
import { AdminMailSection } from './AdminMailSection'
import { Database, Info } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router-dom'
import { api, peekApi, watchApi, ApiClientError, jsonBody } from '../../app/api'
import { DataHeader } from '../../ui/DataHeader'
import { ErrorState } from '../../ui/ErrorState'
import { FormField, FormGroup } from '../../ui/FormField'
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
import { DomainSettingsSection } from './DomainSettingsSection'
import { ShareSettingsSection } from './ShareSettingsSection'

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

function isNotFound(cause: unknown) {
  return cause instanceof ApiClientError && cause.status === 404
}

const REGISTRATION_MODES: Array<{ value: RegistrationMode; label: string }> = [
  { value: 'open', label: '开放注册' },
  { value: 'invite', label: '邀请注册' },
  { value: 'closed', label: '关闭注册' },
]

function RegistrationSection() {
  const [mode, setMode] = useState<RegistrationMode | null>(() => peekApi<{ mode: RegistrationMode }>('/api/admin/system/registration')?.mode ?? null)
  const [loading, setLoading] = useState(() => peekApi<{ mode: RegistrationMode }>('/api/admin/system/registration') === undefined)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi<{ mode: RegistrationMode }>('/api/admin/system/registration') === undefined)
    setLoadError('')
    try {
      await watchApi<{ mode: RegistrationMode }>('/api/admin/system/registration', (result) => {
        setMode(result.mode)
      })
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
      <DataHeader id="sys-registration-title" title="账户与注册" actions={
        !loading && !loadError && mode ? (
          <FormSelect aria-label="注册模式" value={mode} disabled={saving} onChange={(event) => { void changeMode(event.currentTarget.value as RegistrationMode) }}>
            {REGISTRATION_MODES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </FormSelect>
        ) : undefined
      } />
      {loading ? <LoadingState label="正在加载注册设置" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && mode ? (
        <div className="sys-body">
          <p className="sys-hint">切换后立即生效</p>
          <EmailDomains />
        </div>
      ) : null}
    </section>
  )
}

function EmailDomains() {
  const [domains, setDomains] = useState<EmailDomainEntry[]>(() =>
    (peekApi<{ domains: Array<EmailDomainEntry | string> }>('/api/admin/email-domains')?.domains ?? [])
      .map((entry) => typeof entry === 'string' ? { domain: entry } : entry))
  const [loading, setLoading] = useState(() => peekApi('/api/admin/email-domains') === undefined)
  const [notReady, setNotReady] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/email-domains') === undefined)
    setLoadError('')
    try {
      await watchApi<{ domains: Array<EmailDomainEntry | string> }>('/api/admin/email-domains', (result) => {
        setDomains(result.domains.map((entry) => typeof entry === 'string' ? { domain: entry } : entry))
        setNotReady(false)
      })
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
    <FormGroup id="sys-email-domains-title" title="邮箱域名白名单" hint="名单内的邮箱域名才可以注册与绑定，白名单为空时不限制域名">
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
                  <button className="button ghost" type="button" disabled={busy} onClick={() => { remove(entry.domain).catch(() => undefined) }}>移除</button>
                </li>
              ))}
            </ul>
          )}
          <form className="sys-domain-form" onSubmit={add}>
            <FormField label="添加域名" htmlFor="sys-domain-input">
              <Input
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
    </FormGroup>
  )
}

function MailSection() {
  const [settings, setSettings] = useState(() => peekApi<{ settings: SystemMailSettings }>('/api/admin/system/mail')?.settings ?? null)
  const [form, setForm] = useState<MailSettingsForm | null>(() => {
    const initial = peekApi<{ settings: SystemMailSettings }>('/api/admin/system/mail')
    return initial ? toMailSettingsForm(initial.settings) : null
  })
  const serverForm = useRef(form)
  const [loading, setLoading] = useState(() => form === null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [portError, setPortError] = useState('')
  const [testTo, setTestTo] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testNotReady, setTestNotReady] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi('/api/admin/system/mail') === undefined)
    setLoadError('')
    try {
      await watchApi<{ settings: SystemMailSettings }>('/api/admin/system/mail', (result) => {
        setSettings(result.settings)
        const previous = serverForm.current
        const next = toMailSettingsForm(result.settings)
        serverForm.current = next
        setForm((current) => current === previous ? next : current)
      })
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
      serverForm.current = toMailSettingsForm(result.settings)
      setForm(serverForm.current)
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
      <DataHeader id="sys-mail-title" title="邮件" actions={
        !loading && !loadError && form && settings ? <button className="button primary" type="submit" form="ops-mail-settings" disabled={saving}>{saving ? '保存中' : '保存设置'}</button> : undefined
      } />
      {loading ? <LoadingState label="正在加载邮件设置" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
      {!loading && !loadError && form && settings ? (
        <form id="ops-mail-settings" className="sys-form" onSubmit={save} noValidate>
          <div className="sys-grid">
            <FormField label="邮件服务商" htmlFor="sys-mail-provider">
              <FormSelect id="sys-mail-provider" value={form.provider} disabled={saving} onChange={(event) => setForm({ ...form, provider: event.currentTarget.value === 'resend' ? 'resend' : 'smtp' })}>
                <option value="smtp">SMTP</option>
                <option value="resend">Resend</option>
              </FormSelect>
            </FormField>
            <FormField label="发件人" htmlFor="sys-mail-from">
              <Input id="sys-mail-from" type="text" placeholder="SubPanel <no-reply@example.com>" value={form.from} disabled={saving} onChange={(event) => setForm({ ...form, from: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 主机" htmlFor="sys-mail-host">
              <Input id="sys-mail-host" type="text" placeholder="smtp.example.com" value={form.smtpHost} disabled={saving} onChange={(event) => setForm({ ...form, smtpHost: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 端口" htmlFor="sys-mail-port" error={portError}>
              <Input id="sys-mail-port" type="number" inputMode="numeric" min={1} max={65535} step={1} placeholder="465" value={form.smtpPort} disabled={saving} onChange={(event) => setForm({ ...form, smtpPort: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 用户名" htmlFor="sys-mail-user">
              <Input id="sys-mail-user" type="text" autoComplete="off" value={form.smtpUser} disabled={saving} onChange={(event) => setForm({ ...form, smtpUser: event.currentTarget.value })} />
            </FormField>
            <FormField label="SMTP 密码" htmlFor="sys-mail-pass">
              <Input
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
                <Input
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
            密码与 API Key 只写入不回显，留空表示不修改
          </p>
          <FormGroup id="sys-mail-test-title" title="测试邮件">
            <div className="sys-test-row">
              <FormField label="收件邮箱" htmlFor="sys-mail-test-to">
                <Input id="sys-mail-test-to" type="email" placeholder="you@example.com" value={testTo} disabled={testSending} onChange={(event) => setTestTo(event.currentTarget.value)} />
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
          </FormGroup>
        </form>
      ) : null}
    </section>
  )
}

type ServiceHealth = { ok: boolean; version: string; cron: { status: 'idle' | 'success' | 'failed'; ranAt: string; finishedAt: string; errorCode?: string } | null }

function HealthSection() {
  const [health, setHealth] = useState<ServiceHealth | null>(() => peekApi<ServiceHealth>('/api/health') ?? null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setError('')
    try { await watchApi<ServiceHealth>('/api/health', setHealth) }
    catch (cause) { setError(errorMessage(cause, '加载服务健康失败')) }
  }, [])
  useEffect(() => { void load() }, [load])
  return <section className="data-section sys-section"><DataHeader title="服务健康与定时任务" actions={<button className="button primary" onClick={() => { void load() }}>刷新</button>} />
    <div className="sys-body">{error ? <ErrorState message={error} onRetry={() => { void load() }} /> : !health ? <LoadingState label="正在加载服务健康" /> : <>
      <p>服务健康：{health.ok ? '正常' : '异常'} · 版本 {health.version}</p>
      <FormGroup id="sys-health-cron-title" title="来源刷新定时任务" hint="每 15 分钟检查需要刷新的来源">
        {health.cron ? <dl className="key-value-rows"><div><dt>最近结果</dt><dd>{{ idle: '无待刷新来源', success: '成功', failed: '失败' }[health.cron.status]}</dd></div><div><dt>开始</dt><dd>{formatDate(health.cron.ranAt)}</dd></div><div><dt>完成</dt><dd>{formatDate(health.cron.finishedAt)}{health.cron.errorCode ? ` · ${health.cron.errorCode}` : ''}</dd></div></dl> : <p className="sys-hint">暂无任务运行记录</p>}
      </FormGroup>
    </>}</div>
  </section>
}

function StatusSection() {
  const [status, setStatus] = useState<SystemStatus | null>(() => peekApi<{ status: SystemStatus }>('/api/admin/system/status')?.status ?? null)
  const [loading, setLoading] = useState(() => peekApi<{ status: SystemStatus }>('/api/admin/system/status') === undefined)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    setLoading(peekApi<{ status: SystemStatus }>('/api/admin/system/status') === undefined)
    setLoadError('')
    try {
      await watchApi<{ status: SystemStatus }>('/api/admin/system/status', (result) => {
        setStatus(result.status)
      })
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
        actions={<button className="button ghost" type="button" disabled={loading} onClick={() => { load().catch(() => undefined) }}>刷新</button>}
      />
      {loading && !status ? <LoadingState label="正在加载系统状态" /> : null}
      {!loading && loadError ? <div><ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /></div> : null}
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
          <FormGroup id="sys-migrations-title" title="已应用迁移">
            {status.migrations.length === 0 ? (
              <p className="sys-hint">暂无迁移记录</p>
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
          </FormGroup>
          <p className="sys-hint">存储后端由迁移流程统一切换，此页仅供查看</p>
        </div>
      ) : null}
    </section>
  )
}

const SECTIONS = ['registration', 'mail', 'distribution', 'status']

export function SystemPage() {
  const { section } = useParams()
  const location = useLocation()
  const query = new URLSearchParams(location.search)
  const legacy = query.get('section') ?? query.get('tab') ?? location.hash.slice(1)
  const aliases: Record<string, string> = { 'admin-mail': 'mail', share: 'distribution', domain: 'distribution', 'app-downloads': '/catalog/apps', notices: '/operations/notices', templates: '/delivery/conversions' }
  const requested = section ?? legacy ?? 'registration'
  const active = aliases[requested] ?? requested
  if (!section || active !== requested || !SECTIONS.includes(active)) {
    query.delete('section'); query.delete('tab')
    const search = query.size ? `?${query}` : ''
    return <Navigate replace to={(active.startsWith('/') ? active : `/system/${SECTIONS.includes(active) ? active : 'registration'}`) + search} />
  }
  if (active === 'distribution' && (query.has('config') || query.has('archived') || legacy === 'templates')) {
    return <Navigate replace to={`/delivery/conversions?${query}`} />
  }
  return <div className="page-stack sys-page ops-page">
    <PageHeader title="系统设置" />
    <div className="page-stack settings-sections">
        {active === 'registration' ? <RegistrationSection /> : null}
        {active === 'mail' ? <><MailSection /><AdminMailSection /></> : null}
        {active === 'distribution' ? <><DomainSettingsSection /><ShareSettingsSection /><section className="data-section sys-section"><DataHeader title="转换配置" actions={<Link className="button secondary" to="/delivery/conversions" aria-label="打开转换配置">打开</Link>} /></section></> : null}
        {active === 'status' ? <><HealthSection /><StatusSection /></> : null}
    </div>
  </div>
}
