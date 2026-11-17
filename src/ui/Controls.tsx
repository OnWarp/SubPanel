import { Children, Fragment, isValidElement, useId, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react'
import { Select, type SelectOption } from './Select'

type InputProps = InputHTMLAttributes<HTMLInputElement>

/** Native editing semantics with project styling and inline constraint errors */
export function Input({ className = '', onInvalid, onChange, ...props }: InputProps) {
  const [error, setError] = useState('')
  const errorId = useId()
  return <><input {...props} className={`sp-input ${className}`} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[props['aria-describedby'], error ? errorId : ''].filter(Boolean).join(' ') || undefined} onInvalid={(event) => { onInvalid?.(event); if (!event.defaultPrevented) { event.preventDefault(); setError(event.currentTarget.validationMessage) } }} onChange={(event) => { if (error) setError(event.currentTarget.validationMessage); onChange?.(event) }} />{error ? <span id={errorId} className="sp-form-field-error" role="alert">{error}</span> : null}</>
}

export function Textarea({ className = '', onInvalid, onChange, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const [error, setError] = useState('')
  const errorId = useId()
  return <><textarea {...props} className={`sp-textarea ${className}`} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[props['aria-describedby'], error ? errorId : ''].filter(Boolean).join(' ') || undefined} onInvalid={(event) => { onInvalid?.(event); if (!event.defaultPrevented) { event.preventDefault(); setError(event.currentTarget.validationMessage) } }} onChange={(event) => { if (error) setError(event.currentTarget.validationMessage); onChange?.(event) }} />{error ? <span id={errorId} className="sp-form-field-error" role="alert">{error}</span> : null}</>
}

export function Checkbox({ className = '', ...props }: InputProps) {
  return <Input {...props} type="checkbox" className={`sp-checkbox ${className}`} />
}

export function DateTimeInput(props: InputProps) {
  return <Input {...props} type="datetime-local" />
}

export function FileInput({ className = '', onChange, ...props }: InputProps) {
  const input = useRef<HTMLInputElement>(null)
  const [filename, setFilename] = useState('未选择文件')
  return <span className={`sp-file ${className}`}><input {...props} ref={input} type="file" hidden onChange={(event) => { setFilename(Array.from(event.currentTarget.files ?? []).map((file) => file.name).join('、') || '未选择文件'); onChange?.(event) }} /><button className="button secondary" type="button" disabled={props.disabled} aria-label={props['aria-label'] ?? '选择文件'} onClick={() => input.current?.click()}>选择文件</button><span aria-live="polite">{filename}</span></span>
}

type ValueChange = { target: { value: string }; currentTarget: { value: string } }
type FormSelectProps = {
  children: ReactNode
  value?: string | number
  id?: string
  name?: string
  disabled?: boolean
  required?: boolean
  'aria-label'?: string
  onChange?: (event: ValueChange) => void
}

/** Adapt option markup to the existing project Select, preserving string values */
export function FormSelect({ children, value = '', id, name, disabled, required, onChange, 'aria-label': label }: FormSelectProps) {
  const options: SelectOption[] = []
  const collect = (nodes: ReactNode) => Children.forEach(nodes, (child) => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode }>(child)) return
    if (child.type === Fragment) collect(child.props.children)
    else if (child.type === 'option') {
      const text = Children.toArray(child.props.children).join('')
      options.push({ value: String(child.props.value ?? text), label: text })
    }
  })
  collect(children)
  const [error, setError] = useState('')
  const errorId = useId()
  // React's native single select falls back to the first option for an unmatched value
  const requested = String(value)
  const current = options.some((option) => option.value === requested) ? requested : (options[0]?.value ?? '')
  return <div className="sp-form-select"><Select id={id} label={label} value={current} options={options} disabled={disabled} invalid={!!error} describedBy={error ? errorId : undefined} onChange={(next) => { setError(''); onChange?.({ target: { value: next }, currentTarget: { value: next } }) }} />{name ? <input type="hidden" name={name} value={current} disabled={disabled} /> : null}{required ? <Input className="sp-select-validation" tabIndex={-1} aria-hidden="true" value={current} required disabled={disabled} onChange={() => {}} onInvalid={(event) => { event.preventDefault(); setError('请选择一项'); event.currentTarget.parentElement?.querySelector('button')?.focus() }} /> : null}{error ? <span className="sp-form-field-error" id={errorId} role="alert">{error}</span> : null}</div>
}
