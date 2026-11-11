export type InlineMessageProps = {
  tone: 'error' | 'success' | 'warning'
  children: string
}

export function InlineMessage({ tone, children }: InlineMessageProps) {
  return <p className={`form-message ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</p>
}
