import { Search } from 'lucide-react'

type SearchInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  disabled?: boolean
  className?: string
}

export function SearchInput({ value, onChange, placeholder, label, disabled = false, className }: SearchInputProps) {
  return (
    <div className={`sp-search${className ? ` ${className}` : ''}`}>
      <Search aria-hidden="true" size={16} />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label ?? placeholder ?? '搜索'}
        disabled={disabled}
      />
    </div>
  )
}
