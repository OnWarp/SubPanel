export type SegmentedOption<T extends string = string> = {
  value: T
  label: string
}

type SegmentedControlProps<T extends string = string> = {
  label: string
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
}

/**
 * Apple-style segmented control for small in-place view switches
 * (plan sections 6/7). Instant switching, no animation.
 */
export function SegmentedControl<T extends string = string>({ label, value, options, onChange }: SegmentedControlProps<T>) {
  return (
    <div className="sp-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
