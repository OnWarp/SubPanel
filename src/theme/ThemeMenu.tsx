import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from './ThemeProvider'

const choices: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
]

export function ThemeMenu({ id = 'theme-menu', label }: { id?: string; label?: string }) {
  const { mode, preference, setPreference } = useTheme()
  const CurrentIcon = mode === 'dark' ? Moon : Sun

  const select = (next: ThemePreference) => {
    setPreference(next)
    document.getElementById(id)?.hidePopover()
  }

  return (
    <div className="theme-control">
      <button
        className="icon-button"
        type="button"
        aria-label={label ?? '主题'}
        title="切换主题"
        popoverTarget={id}
      >
        <CurrentIcon aria-hidden="true" size={18} />{label ? <span>{label}</span> : null}
      </button>
      <div className="menu" id={id} popover="auto" role="menu" aria-label="主题偏好">
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
