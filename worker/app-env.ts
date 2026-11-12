declare global {
  interface Env {
    DB: D1Database
    DATA_ENCRYPTION_KEY?: string
    SESSION_KEY?: string
  }

  namespace Cloudflare {
    interface Env {
      DB: D1Database
      DATA_ENCRYPTION_KEY?: string
      SESSION_KEY?: string
    }
  }
}

export type Principal = {
  id: string
  username: string
  role: 'admin' | 'user'
  sessionVersion: number
}

export type AppEnv = {
  Bindings: Env
  Variables: {
    principal: Principal
  }
}
