import { useContext } from 'react'
import { MobileBarContext } from './mobile-bar'

const options = [
  { value: 'floating', label: '悬浮' },
  { value: 'inset', label: '内嵌' },
] as const

export function MobileBarOptions() {
  const preference = useContext(MobileBarContext)
  if (!preference) return null

  return (
    <div className="mobile-bar-options" role="group" aria-label="底栏样式">
      <span className="account-menu-label">底栏样式</span>
      <div className="account-menu-choices">
        {options.map(({ value, label }) => (
          <button key={value} type="button" aria-pressed={preference.style === value} onClick={() => preference.changeStyle(value)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
