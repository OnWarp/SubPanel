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
import { BasicTemplateFields } from './BasicTemplateFields'
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
  versionId?: string
  initialSubscription?: string
  onReturn: () => void
  onCreated: (id: string) => void
}

type Validation = { diagnostics: Diagnostic[]; ignored: string[] }

export default function TemplateEditor({ config, previewOnly, versionId, initialSubscription, onReturn, onCreated }: EditorProps) {
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
  const [subscription, setSubscription] = useState(initialSubscription ?? '')
  const [platform, setPlatform] = useState('mihomo')
  const [sample, setSample] = useState(false)
  const [editorMode, setEditorMode] = useState('advanced')
  const [publishedYaml, setPublishedYaml] = useState('')
  const [verificationVersion, setVerificationVersion] = useState(versionId)
  const autoPreview = useRef(Boolean(initialSubscription && versionId))
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
    setVerificationVersion(undefined)
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

  const runPreview = async (compareVersion = verificationVersion) => {
    clearPreview()
    setPane('preview')
    const request = new AbortController()
    previewRequest.current = request
    setPreviewPending(true)
    try {
      const result = await api<TemplatePreviewResponse>(`${ROOT}/preview`, {
        method: 'POST', body: jsonBody({
          yaml: compareVersion ? undefined : yaml,
          profileId: isNew ? undefined : config,
          versionId: compareVersion,
          subscriptionId: subscription || undefined, platform, sample,
        }), signal: request.signal,
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

  useEffect(() => {
    if (!detail || !autoPreview.current) return
    autoPreview.current = false
    void runPreview()
    // The version URL triggers a single preview after the profile loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail])

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

  const applyCandidate = (result: TemplateImportResponse, savedNotice: string) => {
    if (result.notModified) { setNotice(result.message); return }
    changeYaml(result.candidate.yaml)
    setSource(result.source)
    setUrl('')
    setImported(result.candidate)
    setValidation(result.candidate)
    setNotice(savedNotice)
  }

  const importRemote = () => {
    if (!detail) return
    void run(async () => {
      const result = await api<TemplateImportResponse>(`${path}/import`, {
        method: 'POST', body: jsonBody({ url: url.trim() || source?.url || detail.sourceUrl, expectedRevision: detail.revision }),
      })
      applyCandidate(result, '远程内容已导入，保存草稿后生效')
    })
  }

  const fetchOnce = () => {
    const target = url.trim()
    if (!target) return
    void run(async () => {
      const result = await api<TemplateImportResponse>(`${ROOT}/import`, {
        method: 'POST', body: jsonBody({ url: target }),
      })
      applyCandidate(result, '已抓取远程内容，保存草稿时一并写入')
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
      if (result.diagnostics.some(item => item.severity === 'error')) throw new Error('请先处理规则集错误')
      if (latest.revision !== detail.revision) throw new Error('配置已被修改，请刷新后重试')
      const previous = latest.publishedVersionId ? await api<{ yaml: string }>(
        `${path}/versions/${encodeURIComponent(latest.publishedVersionId)}`,
      ) : null
      setPublishedYaml(previous?.yaml ?? '')
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
      setVerificationVersion(result.versionId)
      toast.notify(`已发布 v${result.sequence}，可选择订阅验证发布版本`)
      await runPreview(result.versionId)
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
        {!readOnly && <div className="form-stack sp-form-stack template-edit-fields">
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
              <Input id="template-source-url" type="password" autoComplete="off" value={url} disabled={busy} maxLength={4096}
                placeholder={source || detail?.sourceUrl ? '已保存地址隐藏，可重新输入' : undefined}
                onChange={(event) => setUrl(event.currentTarget.value)} />
            </FormField>
            {isNew ? <>
              <p className="sys-hint">填写 HTTPS 地址后抓取一次，确认预览再保存</p>
              <div><button className="button secondary" type="button" disabled={busy || !url.trim()} onClick={fetchOnce}>抓取预览</button></div>
            </> : <div><button className="button secondary" type="button" disabled={busy || !(url.trim() || source || detail?.sourceUrl)} onClick={importRemote}>导入／重新导入</button></div>}
            {(source?.fetchedAt || detail?.sourceFetchedAt) && <p>获取时间 {templateDate(source?.fetchedAt ?? detail?.sourceFetchedAt ?? '')}</p>}
            {notice && <StatusMessage tone="success">{notice}</StatusMessage>}
            {imported && imported.ignored.length > 0 && <p>导入时发现忽略字段：{imported.ignored.join('、')}</p>}
          </div>}
          <div role="group" aria-label="编辑模式" className="template-actions">
            <button className="button secondary" type="button" aria-pressed={editorMode === 'basic'} onClick={() => setEditorMode('basic')}>基础模式</button>
            <button className="button secondary" type="button" aria-pressed={editorMode === 'advanced'} onClick={() => setEditorMode('advanced')}>高级模式</button>
          </div>
          {editorMode === 'basic' ? <BasicTemplateFields yaml={yaml} onChange={changeYaml} disabled={busy} /> : <FormField label="YAML" htmlFor="template-yaml" wide>
            <Textarea id="template-yaml" rows={17} wrap="off" spellCheck={false} disabled={busy} value={yaml}
              onChange={(event) => changeYaml(event.currentTarget.value)} />
          </FormField>}
          <section className="form-stack template-validation" aria-label="校验结果">
            <h3>校验结果</h3>
            {validation
              ? <TemplateDiagnostics {...validation} />
              : <p className="sys-hint">{previewPending ? '正在校验' : '预览或发布时校验 YAML'}</p>}
            {validation && !validation.diagnostics.length && !validation.ignored.length && <p>草稿结构校验通过</p>}
            {previewError && validation && <StatusMessage tone="error">{previewError}</StatusMessage>}
          </section>
        </div>}
        <TemplatePreview platform={platform} onPlatform={value => { setPlatform(value); clearPreview() }}
          sample={sample} onSample={value => { setSample(value); if (value) setSubscription(''); clearPreview() }}
          value={subscription} onChange={(id) => { setSubscription(id); setSample(false); clearPreview() }}
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
        <p>发布「{detail?.name}」的草稿修订 {detail?.revision}，将影响 {detail ? referenceCount(detail.references) : 0} 条订阅</p>
        <p>如需先灰度，可复制配置并仅将副本绑定到测试订阅</p>
        <TemplateDiff previous={publishedYaml} draft={yaml} />
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
      <p>离开前可保存草稿，或放弃本次修改</p>
      {blocker.state === 'blocked' && error && <StatusMessage tone="error">{error}</StatusMessage>}
    </Dialog>
  </>
}

function getDiagnostics(cause: unknown): Diagnostic[] | undefined {
  return cause instanceof ApiClientError ? (cause.details as { diagnostics?: Diagnostic[] } | undefined)?.diagnostics : undefined
}

function TemplateDiff({ previous, draft }: { previous: string; draft: string }) {
  if (previous === draft) return <p>配置内容无变化</p>
  const before = previous.split('\n')
  const after = draft.split('\n')
  let first = 0
  while (first < before.length && first < after.length && before[first] === after[first]) first++
  let oldEnd = before.length
  let newEnd = after.length
  while (oldEnd > first && newEnd > first && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return <details open>
    <summary>发布差异 · 从第 {first + 1} 行起</summary>
    <pre className="template-diff" tabIndex={0}><del>{before.slice(first, oldEnd).join('\n')}</del>{'\n'}<ins>{after.slice(first, newEnd).join('\n')}</ins></pre>
  </details>
}
