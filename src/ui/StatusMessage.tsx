type StatusMessageProps = {
  tone: 'error' | 'success' | 'warning'
  children: string
}

export function StatusMessage({ tone, children }: StatusMessageProps) {
  return <p className={`form-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>
}
