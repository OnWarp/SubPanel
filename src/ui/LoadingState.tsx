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
