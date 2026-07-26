import { env, exports } from 'cloudflare:workers'

export const TEST_ORIGIN = 'https://subpanel.test'
export const ADMIN_USERNAME = 'admin'
export const ADMIN_PASSWORD = 'correct horse battery staple'

export async function resetData(): Promise<void> {
  let cursor: string | undefined
  do {
    const page = await env.DATA.list({ cursor })
    await Promise.all(page.keys.map(({ name }) => env.DATA.delete(name)))
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

export const jsonRequest = (body: unknown, init: RequestInit = {}): RequestInit => ({
  ...init,
  method: init.method ?? 'POST',
  headers: {
    origin: TEST_ORIGIN,
    'content-type': 'application/json',
    ...init.headers,
  },
  body: JSON.stringify(body),
})

export async function setupAdmin(): Promise<void> {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/setup`,
    jsonRequest({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  )
  if (response.status !== 201) throw new Error(`Setup failed with ${response.status}`)
}

export async function login(username = ADMIN_USERNAME, password = ADMIN_PASSWORD): Promise<string> {
  const response = await exports.default.fetch(
    `${TEST_ORIGIN}/api/login`,
    jsonRequest({ username, password }),
  )
  if (response.status !== 200) throw new Error(`Login failed with ${response.status}`)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (!cookie) throw new Error('Login did not return a session cookie')
  return cookie
}

export const withCookie = (cookie: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { cookie, ...init.headers },
})
