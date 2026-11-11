import { InlineMessage, type InlineMessageProps } from './InlineMessage'

export type StatusMessageProps = InlineMessageProps

export function StatusMessage({ tone, children }: StatusMessageProps) {
  return <InlineMessage tone={tone}>{children}</InlineMessage>
}
