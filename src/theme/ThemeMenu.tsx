import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from './ThemeProvider'

const choices: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
]

export function ThemeMenu() {
  const { mode, preference, setPreference } = useTheme()
  const CurrentIcon = mode === 'dark' ? Moon : Sun

  const select = (next: ThemePreference) => {
    setPreference(next)
    document.getElementById('theme-menu')?.hidePopover()
  }

  return (
    <div className="theme-control">
      <button
        className="icon-button"
        type="button"
        aria-label="主题"
        title="切换主题"
        popoverTarget="theme-menu"
      >
        <CurrentIcon aria-hidden="true" size={18} />
      </button>
      <div className="menu" id="theme-menu" popover="auto" role="menu" aria-label="主题偏好">
        {choices.map(({ value, label, icon: Icon }) => (
          <button key={value} type="button" role="menuitem" onClick={() => select(value)}>
            <Icon aria-hidden="true" size={17} />
            <span>{label}</span>
            {preference === value ? <Check aria-hidden="true" size={16} /> : <span className="menu-check" />}
          </button>
        ))}
      </div>
    </div>
  )
}
