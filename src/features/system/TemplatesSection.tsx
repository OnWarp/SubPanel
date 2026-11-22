import { PageHeader } from '../../ui/PageHeader'
import { RuleLibrary } from './RuleLibrary'
import { lazy, Suspense, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { TemplateList } from './TemplateList'

const TemplateEditor = lazy(() => import('./TemplateEditor'))

export function ConversionPage() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const config = params.get('config')
  const preview = params.get('view') === 'preview'
  const versionId = params.get('version') ?? undefined
  const subscriptionId = params.get('subscription') ?? undefined
  const archived = params.get('archived') === 'true'
  const section = useRef<HTMLElement>(null)
  const previousConfig = useRef(config)
  const openedFromList = location.state?.openedFromTemplateList === true

  useLayoutEffect(() => {
    if (previousConfig.current && !config) section.current?.scrollIntoView({ block: 'start' })
    previousConfig.current = config
  }, [config])

  const open = (id: string | null, showPreview = false, replace = false) => {
    const next = new URLSearchParams(params)
    if (id) next.set('config', id)
    else next.delete('config')
    next.delete('version')
    next.delete('subscription')
    if (showPreview) next.set('view', 'preview')
    else next.delete('view')
    setParams(next, {
      replace,
      preventScrollReset: true,
      state: id && (!config || openedFromList) ? { openedFromTemplateList: true } : undefined,
    })
  }

  const returnToList = () => {
    if (openedFromList) void navigate(-1)
    else open(null, false, true)
  }

  return (
    <div className="page-stack ops-page conversion-page">
      <PageHeader title="转换配置" />
      <section ref={section} className="data-section sys-section ops-template" aria-label="附加配置">
        {config ? (
          <Suspense fallback={<p role="status">正在加载配置</p>}>
            <TemplateEditor key={JSON.stringify([config, preview, versionId])} config={config} previewOnly={preview}
              versionId={versionId} initialSubscription={subscriptionId} onReturn={returnToList}
              onCreated={(id) => open(id, false, true)} />
          </Suspense>
        ) : (
          <TemplateList archived={archived} onOpen={open} onArchived={(show) => {
            const next = new URLSearchParams(params)
            if (show) next.set('archived', 'true')
            else next.delete('archived')
            setParams(next, { replace: true, preventScrollReset: true })
          }} />
        )}
      </section>
      {!config && <RuleLibrary />}
    </div>
  )
}
