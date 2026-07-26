import type { ReactNode } from 'react'
import { ThemeMenu } from '../../theme/ThemeMenu'

export function AuthLayout({ title, children }: {
  title: string
  children: ReactNode
}) {
  return (
    <main className="auth-page">
      <header className="auth-topbar">
        <a className="brand" href="/" aria-label="SubPanel 首页">
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <span>SubPanel</span>
        </a>
        <ThemeMenu />
      </header>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-heading">
          <h1 id="auth-title">{title}</h1>
        </div>
        {children}
      </section>
    </main>
  )
}
