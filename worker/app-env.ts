declare global {
  interface Env {
    BOOTSTRAP_SECRET?: string
    CATALOG_ENCRYPT_AT_REST?: string
    PUBLIC_FETCH_GLOBAL_LIMIT?: string
    REQUIRE_WORKER_SECRETS?: string
    REMOTE_FETCH_ORIGINS?: string
    REMOTE_FETCH_GATEWAY?: Fetcher
    REDEMPTION_ROLLOUT_PERCENT?: string
  }

  interface Env {
    DB: D1Database
    DATA_ENCRYPTION_KEY?: string
    SESSION_KEY?: string
    REDEMPTION_HMAC_KEYS?: string
    RESEND_API_KEY?: string
    SMTP_URL?: string
    MAIL_FROM?: string
  }

  namespace Cloudflare {
    interface Env {
      CATALOG_ENCRYPT_AT_REST?: string
      REMOTE_FETCH_ORIGINS?: string
      REMOTE_FETCH_GATEWAY?: Fetcher
    }
    interface Env {
      DB: D1Database
      DATA_ENCRYPTION_KEY?: string
      SESSION_KEY?: string
      REDEMPTION_HMAC_KEYS?: string
      RESEND_API_KEY?: string
      SMTP_URL?: string
      MAIL_FROM?: string
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
    validatedBody: unknown
  }
}
