import { useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import {
  api, peekApi, watchApi, ApiClientError, jsonBody, subscriptionTemplatesPath as ROOT,
  type Diagnostic, type TemplateDetailResponse, type TemplateDraftUpdate, type TemplateDraftWrite,
  type TemplateImportResponse, type TemplatePreviewResponse, type TemplatePublishResponse, type TemplateSource, type TemplateValidateResponse,
} from '../../app/api'
import { FormSelect, Input, Textarea } from '../../ui/Controls'
import { DataHeader } from '../../ui/DataHeader'
import { Dialog } from '../../ui/Dialog'
import { FormField } from '../../ui/FormField'
import { StatusMessage } from '../../ui/StatusMessage'
import { useToast } from '../../ui/Toast'
import { TemplateDiagnostics, TemplatePreview } from './TemplatePreview'
import { referenceCount, templateDate, templateError, templateStatus } from './template-display'

const INITIAL = `proxy-groups:
  - name: Proxy
    type: select
    proxies:
      - "$SUBPANEL_NODES"
      - DIRECT
rules:
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - MATCH,Proxy
`

type EditorProps = {
  config: string
  previewOnly: boolean
  onReturn: () => void
  onCreated: (id: string) => void
}

type Validation = { diagnostics: Diagnostic[]; ignored: string[] }

export default function TemplateEditor({ config, previewOnly, onReturn, onCreated }: EditorProps) {
  const isNew = config === 'new'
  const path = `${ROOT}/${encodeURIComponent(config)}`
  const [initial] = useState(() => isNew ? undefined : peekApi<TemplateDetailResponse>(path))
  const [detail, setDetail] = useState(initial)
  const [name, setName] = useState(initial?.name ?? '')
  const [yaml, setYaml] = useState(initial?.draft ?? INITIAL)
  const [mode, setMode] = useState(initial?.sourceUrl ? 'remote' : 'direct')
  const [url, setUrl] = useState('')
  const [source, setSource] = useState<TemplateSource>()
  const [imported, setImported] = useState<Validation>()
  const [notice, setNotice] = useState('')
  const [subscription, setSubscription] = useState('')
  const [preview, setPreview] = useState<TemplatePreviewResponse>()
  const [previewPending, setPreviewPending] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [validation, setValidation] = useState<Validation>()
  const [pane, setPane] = useState<'edit' | 'preview'>('edit')
  const [loadError, setLoadError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [publishConfirm, setPublishConfirm] = useState(false)
  const previewRequest = useRef<AbortController | null>(null)
  const bypass = useRef(false)
  const toast = useToast()

  const archived = detail?.status === 'archived'
  const readOnly = previewOnly || archived
  const dirty = !readOnly && (name !== (detail?.name ?? '') || yaml !== (detail?.draft ?? INITIAL) || Boolean(source))
  const editing = useRef(false)
  editing.current = dirty || busy
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    if (bypass.current || (!dirty && !busy)) return false
    return currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search
  })

  useEffect(() => {
    if (!dirty && !busy) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty, busy])

  useEffect(() => {
    if (isNew) return
    const abort = new AbortController()
    setLoadError('')
    void watchApi<TemplateDetailResponse>(path, (next) => {
      if (editing.current) return
      setDetail(next)
      setName(next.name)
      setYaml(next.draft)
      setMode(next.sourceUrl ? 'remote' : 'direct')
    }, { signal: abort.signal }).catch((cause) => { if (!abort.signal.aborted) setLoadError(templateError(cause)) })
    return () => abort.abort()
  }, [isNew, loadAttempt, path])

  useEffect(() => () => previewRequest.current?.abort(), [])

  const clearPreview = () => {
    previewRequest.current?.abort()
    setPreviewPending(false)
    setPreview(undefined)
    setPreviewError('')
    setValidation(undefined)
  }

  const changeYaml = (value: string) => {
    setYaml(value)
    clearPreview()
  }

  const run = async (operation: () => Promise<void>) => {
    setError('')
    setBusy(true)
    try { await operation(); return true }
    catch (cause) {
      const diagnostics = getDiagnostics(cause)
      if (diagnostics) setValidation({ diagnostics, ignored: [] })
      setError(templateError(cause))
      return false
    } finally { setBusy(false) }
  }

  const runPreview = async () => {
    clearPreview()
    setPane('preview')
    const request = new AbortController()
    previewRequest.current = request
    setPreviewPending(true)
    try {
      const result = await api<TemplatePreviewResponse>(`${ROOT}/preview`, {
        method: 'POST', body: jsonBody({ yaml, subscriptionId: subscription || undefined }), signal: request.signal,
      })
      if (request.signal.aborted) return
      setValidation(result)
      setPreview(result)
    } catch (cause) {
      if (request.signal.aborted) return
      const diagnostics = getDiagnostics(cause)
      if (diagnostics) {
        setValidation({ diagnostics, ignored: [] })
        if (!readOnly) setPane('edit')
      }
      setPreviewError(templateError(cause))
    } finally {
      if (!request.signal.aborted) setPreviewPending(false)
    }
  }

  const save = async (leaving = false) => {
    const savedName = name.trim()
    if (!savedName) return false
    return run(async () => {
      const body = jsonBody({ name: savedName, yaml, source, expectedRevision: detail?.revision })
      if (detail) {
        const result = await api<TemplateDraftUpdate>(path, { method: 'PUT', body })
        const saved = {
          ...detail, name: savedName, draft: yaml, draftHash: result.draftHash, revision: result.revision,
          status: detail.publishedVersionId ? (yaml === detail.draft ? detail.status : 'modified' as const) : 'draft' as const,
          sourceUrl: source?.url ?? detail.sourceUrl,
          sourceFetchedAt: source?.fetchedAt ?? detail.sourceFetchedAt,
        }
        setDetail(saved)
        if (!leaving && detail.publishedVersionId && yaml !== detail.draft) {
          const refreshed = await api<TemplateDetailResponse>(path).catch(() => undefined)
          if (refreshed?.revision === saved.revision) setDetail(refreshed)
        }
      } else {
        const result = await api<TemplateDraftWrite>(ROOT, { method: 'POST', body })
        if (!leaving) {
          bypass.current = true
          onCreated(result.id)
        }
      }
      setName(savedName)
      setSource(undefined)
      toast.notify('草稿已保存')
    })
  }

  const importRemote = () => {
    if (!detail) return
    void run(async () => {
      const result = await api<TemplateImportResponse>(`${path}/import`, {
        method: 'POST', body: jsonBody({ url: url.trim() || source?.url || detail.sourceUrl, expectedRevision: detail.revision }),
      })
      if (result.notModified) { setNotice(result.message); return }
      changeYaml(result.candidate.yaml)
      setSource(result.source)
      setUrl('')
      setImported(result.candidate)
      setValidation(result.candidate)
      setNotice('远程内容已导入，保存草稿后生效')
    })
  }

  const preparePublish = () => {
    if (!detail) return
    void run(async () => {
      setValidation(undefined)
      const [result, latest] = await Promise.all([
        api<TemplateValidateResponse>(`${ROOT}/validate`, { method: 'POST', body: jsonBody({ yaml }) }),
        api<TemplateDetailResponse>(path),
      ])
      setValidation(result)
      if (latest.revision !== detail.revision) throw new Error('配置已被修改，请刷新后重试')
      setDetail(latest)
      setPublishConfirm(true)
    })
  }

  const publish = () => {
    if (!detail || dirty || !validation) return
    void run(async () => {
      const result = await api<TemplatePublishResponse>(`${path}/publish`, {
        method: 'POST', body: jsonBody({
          expectedRevision: detail.revision,
          draftHash: detail.draftHash,
          ignoredAcknowledged: validation.ignored.length > 0,
        }),
      })
      setDetail({ ...detail, status: 'published', revision: result.revision, publishedVersionId: result.versionId, references: result.references })
      setPublishConfirm(false)
      toast.notify(`已发布 v${result.sequence}`)
    })
  }

  return <>
    <DataHeader title={previewOnly ? `${detail?.name ?? '附加配置'} · 预览` : name.trim() || (isNew ? '新增配置' : '编辑配置')}
      actions={<button className="button secondary" type="button" onClick={onReturn}>返回列表</button>} />
    {(!isNew && !detail) ? (loadError
      ? <div className="template-actions"><StatusMessage tone="error">{loadError}</StatusMessage>
        <button className="button secondary" type="button" onClick={() => setLoadAttempt(loadAttempt + 1)}>重试</button></div>
      : <p role="status">正在加载配置</p>) : <>
      <p className="template-editor-status">{templateStatus[detail?.status ?? 'draft']}{dirty && ' · 有未保存更改'}</p>
      {!readOnly && <div className="template-actions template-tabs" role="group" aria-label="编辑和预览">
        <button className="button secondary" type="button" aria-pressed={pane === 'edit'} onClick={() => setPane('edit')}>编辑</button>
        <button className="button secondary" type="button" aria-pressed={pane === 'preview'} onClick={() => setPane('preview')}>预览</button>
      </div>}
      <div className={readOnly ? 'template-standalone' : 'template-editor-grid'} data-pane={pane}>
        {!readOnly && <div className="form-stack template-edit-fields">
          <FormField label="配置名称" htmlFor="template-name">
            <Input id="template-name" value={name} maxLength={128} disabled={busy} onChange={(event) => setName(event.currentTarget.value)} />
          </FormField>
          <FormField label="来源" htmlFor="template-source-mode">
            <FormSelect id="template-source-mode" value={mode} disabled={busy} onChange={(event) => setMode(event.currentTarget.value)}>
              <option value="direct">直接编辑</option><option value="remote">远程地址</option>
            </FormSelect>
          </FormField>
          {mode === 'remote' && <div className="form-stack">
            <FormField label="HTTPS 地址" htmlFor="template-source-url">
              <Input id="template-source-url" type="password" autoComplete="off" value={url} disabled={busy || isNew} maxLength={4096}
                placeholder={source || detail?.sourceUrl ? '已保存地址隐藏，可重新输入' : undefined}
                onChange={(event) => setUrl(event.currentTarget.value)} />
            </FormField>
            {isNew ? <p className="sys-hint">保存草稿后可从远程地址导入。也可以直接粘贴 YAML。</p> :
              <div><button className="button secondary" type="button" disabled={busy || !(url.trim() || source || detail?.sourceUrl)} onClick={importRemote}>导入／重新导入</button></div>}
            {(source?.fetchedAt || detail?.sourceFetchedAt) && <p>获取时间 {templateDate(source?.fetchedAt ?? detail?.sourceFetchedAt ?? '')}</p>}
            {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
            {imported && imported.ignored.length > 0 && <p>导入时发现忽略字段：{imported.ignored.join('、')}</p>}
          </div>}
          <FormField label="YAML" htmlFor="template-yaml">
            <Textarea id="template-yaml" rows={17} wrap="off" spellCheck={false} disabled={busy} value={yaml}
              onChange={(event) => changeYaml(event.currentTarget.value)} />
          </FormField>
          <section className="form-stack template-validation" aria-label="校验结果">
            <h3>校验结果</h3>
            {validation
              ? <TemplateDiagnostics {...validation} />
              : <p className="sys-hint">{previewPending ? '正在校验' : '预览或发布时校验 YAML'}</p>}
            {validation && !validation.diagnostics.length && !validation.ignored.length && <p>草稿结构校验通过</p>}
            {previewError && validation && <StatusMessage tone="error">{previewError}</StatusMessage>}
          </section>
        </div>}
        <TemplatePreview value={subscription} onChange={(id) => { setSubscription(id); clearPreview() }}
          result={preview} pending={previewPending} onPreview={() => void runPreview()} standalone={readOnly} disabled={busy} />
        {readOnly && <>
          {validation && <TemplateDiagnostics {...validation} />}
          {previewError && <StatusMessage tone="error">{previewError}</StatusMessage>}
        </>}
      </div>
      {!readOnly && <div className="template-actions template-editor-footer">
        <button className="button secondary" type="button" disabled={busy || !name.trim() || (!dirty && !isNew)} onClick={() => void save()}>保存草稿</button>
        <button className="button secondary" type="button" disabled={busy || previewPending} onClick={() => void runPreview()}>预览</button>
        <button className="button primary" type="button" disabled={busy || previewPending || !detail || dirty} onClick={preparePublish}>发布</button>
        {(!detail || dirty) && <span className="sys-hint">先保存草稿</span>}
      </div>}
      {!readOnly && previewError && !validation && <StatusMessage tone="error">{previewError}</StatusMessage>}
      {error && !publishConfirm && blocker.state !== 'blocked' && <StatusMessage tone="error">{error}</StatusMessage>}
    </>}
    <Dialog open={publishConfirm} onClose={() => { if (!busy) { setPublishConfirm(false); setError('') } }} title="发布配置"
      footer={<>
        <button className="button secondary" type="button" disabled={busy} onClick={() => { setPublishConfirm(false); setError('') }}>取消</button>
        <button className="button primary" type="button" disabled={busy} onClick={publish}>{busy ? '正在发布' : '确认发布'}</button>
      </>}>
      <div className="form-stack">
        <p>发布「{detail?.name}」的草稿修订 {detail?.revision}，将影响 {detail ? referenceCount(detail.references) : 0} 条订阅。</p>
        {validation && validation.ignored.length > 0 && <p>发布将忽略以下字段，请确认：{validation.ignored.join('、')}</p>}
        {publishConfirm && error && <StatusMessage tone="error">{error}</StatusMessage>}
      </div>
    </Dialog>
    <Dialog open={blocker.state === 'blocked'} title="有未保存更改" onClose={() => { if (!busy) blocker.reset?.() }}
      footer={<>
        <button className="button secondary" type="button" disabled={busy} onClick={() => blocker.reset?.()}>继续编辑</button>
        <button className="button secondary" type="button" disabled={busy} onClick={() => blocker.proceed?.()}>放弃更改</button>
        <button className="button primary" type="button" disabled={busy || !dirty || !name.trim()} onClick={() => void save(true).then((saved) => { if (saved) blocker.proceed?.() })}>
          {busy ? '处理中' : '保存并离开'}
        </button>
      </>}>
      <p>离开前可保存草稿，或放弃本次修改。</p>
      {blocker.state === 'blocked' && error && <StatusMessage tone="error">{error}</StatusMessage>}
    </Dialog>
  </>
}

function getDiagnostics(cause: unknown): Diagnostic[] | undefined {
  return cause instanceof ApiClientError ? (cause.details as { diagnostics?: Diagnostic[] } | undefined)?.diagnostics : undefined
}
