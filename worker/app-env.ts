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
