import { Input } from './Controls'
import { Search } from 'lucide-react'

type SearchInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label?: string
  disabled?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  className?: string
}

export function SearchInput({ value, onChange, placeholder, label, disabled = false, inputRef, className }: SearchInputProps) {
  return (
    <div className={`sp-search${className ? ` ${className}` : ''}`}>
      <Search aria-hidden="true" size={16} />
      <Input
        ref={inputRef}
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
