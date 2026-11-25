type LoadingStateProps = {
  label?: string
}

export function LoadingState({ label = '正在加载' }: LoadingStateProps) {
  return (
    <div className="sp-loading" role="status" aria-live="polite">
      <span className="sp-loading-bars" aria-hidden="true"><i /><i /><i /></span>
      <span className="sp-loading-label">{label}</span>
    </div>
  )
}

/** Decorative placeholder. The surrounding loading region announces its state. */
export function Skeleton() {
  return <span className="sp-table-placeholder content-skeleton" aria-hidden="true" />
}
