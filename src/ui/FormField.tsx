import type { ReactNode } from 'react'

type FormFieldProps = {
  label: string
  error?: string
  hint?: string
  children: ReactNode
  htmlFor?: string
  /** Content editors opt out of the 460px field cap. */
  wide?: boolean
}

export function FormField({ label, error, hint, children, htmlFor, wide = false }: FormFieldProps) {
  return (
    <div className={`sp-form-field${wide ? ' sp-form-field-wide' : ''}`}>
      <label className="sp-form-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <p className="sp-form-hint">{hint}</p> : null}
      {error ? <p className="sp-form-field-error" role="alert">{error}</p> : null}
    </div>
  )
}

type FormGroupProps = {
  title?: string
  hint?: string
  children: ReactNode
  id?: string
}

/** Shared settings and dialog group. Title, then fields, separated by a hairline when stacked. */
export function FormGroup({ title, hint, children, id }: FormGroupProps) {
  return (
    <section className="sp-form-group" aria-labelledby={title ? id : undefined}>
      {title ? <h3 className="sp-form-group-title" id={id}>{title}</h3> : null}
      {hint ? <p className="sp-form-hint">{hint}</p> : null}
      {children}
    </section>
  )
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions sp-form-actions">{children}</div>
}

/** Low-frequency fields stay closed until the operator asks for them. */
export function AdvancedFields({ label = '高级选项', children }: { label?: string; children: ReactNode }) {
  return (
    <details className="sp-advanced">
      <summary>{label}</summary>
      <div className="sp-advanced-body">{children}</div>
    </details>
  )
}

