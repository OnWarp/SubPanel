import { useCallback, useEffect, useState } from 'react'
import { api, peekApi, watchApi, ApiClientError, jsonBody } from '../../app/api'
import { DataHeader } from '../../ui/DataHeader'
import { ErrorState } from '../../ui/ErrorState'
import { FormField } from '../../ui/FormField'
import { LoadingState } from '../../ui/LoadingState'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/Toast'

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof ApiClientError ? cause.message : fallback
}

export function AppDownloadsSection() {
  const [enabled, setEnabled] = useState<boolean | null>(() => peekApi<{ enabled: boolean }>('/api/admin/system/app-downloads')?.enabled ?? null)
  const [loading, setLoading] = useState(() => peekApi<{ enabled: boolean }>('/api/admin/system/app-downloads') === undefined)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const toast = useToast()

  const load = useCallback(async () => {
    setLoading(peekApi<{ enabled: boolean }>('/api/admin/system/app-downloads') === undefined)
    setLoadError('')
    try {
      await watchApi<{ enabled: boolean }>('/api/admin/system/app-downloads', (data) => {
        setEnabled(data.enabled)
      })
    } catch (cause) {
      setLoadError(errorMessage(cause, '加载客户端下载设置失败'))
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
      toast.notify(data.enabled ? '已显示客户端下载板块' : '已隐藏客户端下载板块')
    } catch (cause) {
      toast.notifyError(errorMessage(cause, '保存客户端下载设置失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="data-section sys-section" aria-labelledby="sys-app-downloads-title">
      <DataHeader id="sys-app-downloads-title" title="用户端显示" />
      {loading ? <LoadingState label="正在加载客户端下载设置" /> : null}
      {!loading && loadError ? <ErrorState message={loadError} onRetry={() => { load().catch(() => undefined) }} /> : null}
      {!loading && !loadError && enabled !== null ? (
        <div>
          <p className="sys-hint">开启后，普通用户可以在用户端查看各平台的客户端下载入口；关闭后，用户端隐藏整个客户端下载板块，但不会删除已配置的 APP</p>
          <div className="sys-toggles">
            <FormField label="显示客户端下载板块">
              <Switch checked={enabled} onChange={(checked) => { toggle(checked).catch(() => undefined) }} disabled={saving} ariaLabel="显示客户端下载板块" />
            </FormField>
          </div>
        </div>
      ) : null}
    </section>
  )
}
