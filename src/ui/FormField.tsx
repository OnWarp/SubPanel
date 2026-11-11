import type { ReactNode } from 'react'

type FormFieldProps = {
  label: string
  error?: string
  children: ReactNode
  htmlFor?: string
}

export function FormField({ label, error, children, htmlFor }: FormFieldProps) {
  return (
    <div className="sp-form-field">
      <label className="sp-form-field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="sp-form-field-error" role="alert">{error}</p> : null}
    </div>
  )
}
