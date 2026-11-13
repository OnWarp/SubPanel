type SwitchProps = {
  label?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
}

/**
 * Shared pill switch. Same DOM pattern as the page-level switches
 * (checkbox with role="switch" plus a track/thumb pair), styled once here.
 */
export function Switch({ label, checked, onChange, disabled = false, ariaLabel }: SwitchProps) {
  return (
    <label className="sp-switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel ?? label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="sp-switch-track" aria-hidden="true"><span className="sp-switch-thumb" /></span>
      {label ? <span className="sp-switch-label">{label}</span> : null}
    </label>
  )
}
