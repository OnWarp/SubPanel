import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

type ButtonStyleProps = {
  variant?: ButtonVariant
  size?: 'page'
  className?: string
  children: ReactNode
}

type NativeButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  as?: 'button'
  ref?: ComponentPropsWithRef<'button'>['ref']
  loading?: boolean
}

type ButtonProps = ButtonStyleProps & (
  | NativeButtonProps
  | (LinkProps & { as: 'link' })
  | (ComponentPropsWithRef<'summary'> & { as: 'summary' })
)

export function Button(props: ButtonProps) {
  const { variant = 'secondary', size, className, children, ...elementProps } = props
  const classes = ['button', variant, size === 'page' && 'button-page', className].filter(Boolean).join(' ')

  if (elementProps.as === 'link') {
    const { as: _as, ...linkProps } = elementProps
    return <Link {...linkProps} className={classes}>{children}</Link>
  }

  if (elementProps.as === 'summary') {
    const { as: _as, ...summaryProps } = elementProps
    return <summary {...summaryProps} className={classes}>{children}</summary>
  }

  const { as: _as, loading = false, disabled, type = 'button', ...rest } = elementProps
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="sp-spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}
