import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  loading?: boolean
  children: ReactNode
}

export function Button({ variant = 'secondary', loading = false, disabled, type = 'button', className, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`button ${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="sp-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}
