import { Checkbox } from './Controls'
type SwitchProps = {
  id?: string
  label?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  describedBy?: string
}

/**
 * Shared pill switch. Same DOM pattern as the page-level switches
 * (checkbox with role="switch" plus a track/thumb pair), styled once here.
 */
export function Switch({ id, label, checked, onChange, disabled = false, ariaLabel, describedBy }: SwitchProps) {
  return (
    <label className="sp-switch">
      <Checkbox
        id={id}
        type="checkbox"
        role="switch"
        aria-label={ariaLabel ?? label}
        aria-describedby={describedBy}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="sp-switch-track" aria-hidden="true"><span className="sp-switch-thumb" /></span>
      <span className="sp-switch-state" aria-hidden="true">{checked ? '开' : '关'}</span>
      {label ? <span className="sp-switch-label">{label}</span> : null}
    </label>
  )
}
