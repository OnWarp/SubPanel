import { useId, type ReactNode } from 'react'

type FormFieldProps = {
  label: string
  error?: string
  hint?: string
  children: ReactNode | ((control: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode)
  htmlFor?: string
  /** Content editors opt out of the 460px field cap. */
  wide?: boolean
}

export function FormField({ label, error, hint, children, htmlFor, wide = false }: FormFieldProps) {
  const id = useId()
  const controlId = htmlFor ?? id
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ')
  return (
    <div className={`sp-form-field${wide ? ' sp-form-field-wide' : ''}`}>
      <label className="sp-form-field-label" htmlFor={typeof children === 'function' ? controlId : htmlFor}>{label}</label>
      {typeof children === 'function' ? children({
        id: controlId,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      }) : children}
      {hint ? <p className="sp-form-hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="sp-form-field-error" id={`${id}-error`} role="alert">{error}</p> : null}
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
  const generatedId = useId()
  const titleId = id ?? generatedId
  return (
    <section className="sp-form-group" aria-labelledby={title ? titleId : undefined}>
      {title ? <h3 className="sp-form-group-title" id={titleId}>{title}</h3> : null}
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


export { FormGroup as FormSection }

export { FormActions as FormFooter }
