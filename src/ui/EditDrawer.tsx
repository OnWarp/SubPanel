import type { ReactNode, RefObject } from 'react'
import { Dialog, type DialogSize } from './Dialog'

type EditDrawerProps = {
  open: boolean
  title: string
  headerStatus?: ReactNode
  headerActions?: ReactNode
  busy?: boolean
  /** When true, Esc and the close icon ask before discarding. */
  dirty?: boolean
  onClose: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  size?: 'compact' | 'medium' | 'wide' | 'large'
  footer?: ReactNode
  children: ReactNode
}

const sizes: Record<NonNullable<EditDrawerProps['size']>, DialogSize> = {
  compact: 's',
  medium: 'm',
  wide: 'l',
  large: 'l',
}

/** Temporary compatibility for existing callers. Remove in P4. */
export function EditDrawer({ size = 'medium', ...props }: EditDrawerProps) {
  return <Dialog {...props} size={sizes[size]} closeOnBackdrop={false} />
}
