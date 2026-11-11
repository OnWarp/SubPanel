import { CircleAlert } from 'lucide-react'

type ErrorStateProps = {
  message: string
  onRetry?: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="sp-error" role="alert">
      <CircleAlert aria-hidden="true" size={17} />
      <p>{message}</p>
      {onRetry ? <button type="button" className="sp-error-action" onClick={onRetry}>重试</button> : null}
    </div>
  )
}
