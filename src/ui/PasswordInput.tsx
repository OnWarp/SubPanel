import { Eye, EyeOff } from 'lucide-react'
import { useState, type InputHTMLAttributes } from 'react'
export function PasswordInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false)
  return <div className="password-input"><input {...props} type={visible ? 'text' : 'password'} /><button type="button" className="icon-button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(v => !v)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
}
