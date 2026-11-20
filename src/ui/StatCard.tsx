import { Link } from 'react-router-dom'
import { TriangleAlert } from 'lucide-react'
import { useId, type ReactNode } from 'react'

type StatCardProps = {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  variant?: 'plain' | 'ring' | 'bar'
  percent?: number
  tone?: 'normal' | 'warning' | 'danger'
  to?: string
  onClick?: () => void
  footer?: ReactNode
}

export function StatCard({ label, value, sub, variant = 'plain', percent = 0, tone = 'normal', to, onClick, footer }: StatCardProps) {
  const labelId = useId()
  const progress = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  const content = <><span id={labelId} className="sp-stat-label">{label}</span><span className="sp-stat-value">{value}{tone !== 'normal' ? <TriangleAlert size={20} aria-hidden="true" /> : null}</span>{sub != null ? <span className="sp-stat-sub">{sub}</span> : null}{variant !== 'plain' ? <span className={`sp-stat-progress sp-stat-progress-${variant}`} role="meter" aria-labelledby={labelId} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>{variant === 'ring' ? <svg viewBox="0 0 48 48" aria-hidden="true"><circle className="sp-stat-track" cx="24" cy="24" r="20" /><circle className="sp-stat-fill" cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${progress} 100`} transform="rotate(-90 24 24)" /></svg> : <span style={{ width: `${progress}%` }} />}</span> : null}</>
  return <div className={`object-card sp-stat-${tone}`}>{to ? <Link to={to} className="sp-stat-body sp-stat-action">{content}</Link> : onClick ? <button type="button" className="sp-stat-body sp-stat-action" onClick={onClick}>{content}</button> : <div className="sp-stat-body">{content}</div>}{footer != null ? <div className="sp-card-footer">{footer}</div> : null}</div>
}
