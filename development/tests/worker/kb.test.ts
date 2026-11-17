import { createFixtureAccount } from './helpers'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { enableD1Modules, jsonRequest, login, resetData, setupAdmin, TEST_ORIGIN, withCookie } from './helpers'

type Category = {
  id: number
  name: string
  sort: number
  createdAt: string
}

type ArticleSummary = {
  id: number
  categoryId: number
  categoryName: string
  title: string
  published: boolean
  sort: number
  createdAt: string
  updatedAt: string
}

type Article = ArticleSummary & { content: string }

type UserKb = {
  categories: Array<{
    id: number
    name: string
    sort: number
    articles: ArticleSummary[]
  }>
}

type ErrorBody = { error: { code: string, message: string } }

beforeEach(async () => {
  await resetData()
  await enableD1Modules()
  await setupAdmin()
})

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status)
  const body = await response.json() as ErrorBody
  expect(body.error.code).toBe(code)
}

async function provisionUser(
  adminCookie: string,
  username: string,
  password: string,
): Promise<{ id: string, cookie: string }> {
  const redeemed = await createFixtureAccount(username, password)
  expect(redeemed.status).toBe(201)
  const users = await (await exports.default.fetch(`${TEST_ORIGIN}/api/admin/users`, withCookie(adminCookie))).json() as {
    users: Array<{ id: string, username: string }>
  }
  const user = users.users.find((item) => item.username === username)
  if (!user) throw new Error(`missing user ${username}`)
  return { id: user.id, cookie: await login(username, password) }
}

function call(cookie: string, method: string, path: string, body?: unknown): Promise<Response> {
  const init = body === undefined
    ? withCookie(cookie, { method, headers: method === 'GET' ? {} : { origin: TEST_ORIGIN } })
    : jsonRequest(body, withCookie(cookie, { method }))
  return exports.default.fetch(`${TEST_ORIGIN}${path}`, init)
}

async function createCategory(
  cookie: string,
  body: { name: string, sort?: number },
): Promise<Category> {
  const response = await call(cookie, 'POST', '/api/admin/kb/categories', body)
  expect(response.status).toBe(201)
  return (await response.json() as { category: Category }).category
}

async function createArticle(
  cookie: string,
  body: { categoryId: number, title: string, content: string, published?: boolean, sort?: number },
): Promise<Article> {
  const response = await call(cookie, 'POST', '/api/admin/kb/articles', body)
  expect(response.status).toBe(201)
  return (await response.json() as { article: Article }).article
}

async function readUserKb(cookie: string): Promise<UserKb> {
  const response = await call(cookie, 'GET', '/api/kb')
  expect(response.status).toBe(200)
  return response.json() as Promise<UserKb>
}

async function search(cookie: string, query: string): Promise<ArticleSummary[]> {
  const response = await call(cookie, 'GET', `/api/kb/search?q=${encodeURIComponent(query)}`)
  expect(response.status).toBe(200)
  return (await response.json() as { articles: ArticleSummary[] }).articles
}

describe('knowledge base admin', () => {
  it('guards category and article CRUD and enforces validation', async () => {
    const admin = await login()
    const reader = await provisionUser(admin, 'kb-reader', 'kb reader password')

    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/kb`),
      401,
      'AUTH_REQUIRED',
    )
    await expectError(
      await exports.default.fetch(`${TEST_ORIGIN}/api/admin/kb/categories`),
      401,
      'AUTH_REQUIRED',
    )
    await expectError(await call(reader.cookie, 'GET', '/api/admin/kb/categories'), 403, 'ADMIN_REQUIRED')
    await expectError(
      await call(reader.cookie, 'POST', '/api/admin/kb/categories', { name: '越权分类' }),
      403,
      'ADMIN_REQUIRED',
    )
    await expectError(
      await call(reader.cookie, 'POST', '/api/admin/kb/articles', {
        categoryId: 1,
        title: '越权文章',
        content: '正文',
      }),
      403,
      'ADMIN_REQUIRED',
    )

    const later = await createCategory(admin, { name: '进阶配置', sort: 20 })
    const earlier = await createCategory(admin, { name: '快速上手', sort: 10 })

    const listed = await call(admin, 'GET', '/api/admin/kb/categories')
    expect(listed.status).toBe(200)
    expect((await listed.json() as { categories: Category[] }).categories.map((item) => item.id))
      .toEqual([earlier.id, later.id])

    await expectError(
      await call(admin, 'POST', '/api/admin/kb/categories', { name: '快速上手' }),
      409,
      'KB_CATEGORY_NAME_TAKEN',
    )
    await expectError(
      await call(admin, 'POST', '/api/admin/kb/categories', { name: '   ' }),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(admin, 'PUT', `/api/admin/kb/categories/${later.id}`, {}),
      422,
      'VALIDATION_FAILED',
    )

    const renamed = await call(admin, 'PUT', `/api/admin/kb/categories/${later.id}`, { name: '进阶配置（修订）', sort: 5 })
    expect(renamed.status).toBe(200)
    expect((await renamed.json() as { category: Category }).category).toMatchObject({ name: '进阶配置（修订）', sort: 5 })

    const draft = await createArticle(admin, {
      categoryId: earlier.id,
      title: '安装客户端',
      content: '# 安装\n\n下载后导入订阅。',
    })
    expect(draft).toMatchObject({ categoryId: earlier.id, categoryName: '快速上手', published: false, sort: 0 })

    await expectError(
      await call(admin, 'POST', '/api/admin/kb/articles', { categoryId: 9999, title: '缺失分类', content: '正文' }),
      404,
      'KB_CATEGORY_NOT_FOUND',
    )
    await expectError(
      await call(admin, 'POST', '/api/admin/kb/articles', { categoryId: earlier.id, title: '', content: '正文' }),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(admin, 'POST', '/api/admin/kb/articles', { categoryId: earlier.id, title: '标题', content: '' }),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(admin, 'POST', '/api/admin/kb/articles', { categoryId: earlier.id, title: '标题', content: '正文', sort: -1 }),
      422,
      'VALIDATION_FAILED',
    )

    const detail = await call(admin, 'GET', `/api/admin/kb/articles/${draft.id}`)
    expect(detail.status).toBe(200)
    expect((await detail.json() as { article: Article }).article.content).toBe('# 安装\n\n下载后导入订阅。')

    const updated = await call(admin, 'PUT', `/api/admin/kb/articles/${draft.id}`, { title: '安装客户端（修订）', published: true })
    expect(updated.status).toBe(200)
    expect((await updated.json() as { article: Article }).article).toMatchObject({
      title: '安装客户端（修订）',
      published: true,
      content: '# 安装\n\n下载后导入订阅。',
    })

    await expectError(
      await call(admin, 'DELETE', `/api/admin/kb/categories/${earlier.id}`),
      409,
      'KB_CATEGORY_IN_USE',
    )

    expect((await call(admin, 'DELETE', `/api/admin/kb/articles/${draft.id}`)).status).toBe(204)
    expect((await call(admin, 'DELETE', `/api/admin/kb/categories/${earlier.id}`)).status).toBe(204)
    await expectError(
      await call(admin, 'DELETE', `/api/admin/kb/categories/${earlier.id}`),
      404,
      'KB_CATEGORY_NOT_FOUND',
    )
    await expectError(
      await call(admin, 'DELETE', `/api/admin/kb/articles/${draft.id}`),
      404,
      'KB_ARTICLE_NOT_FOUND',
    )
  })

  it('paginates and filters the admin article list', async () => {
    const admin = await login()
    const category = await createCategory(admin, { name: '分页分类', sort: 0 })
    const other = await createCategory(admin, { name: '其他分类', sort: 1 })

    const first = await createArticle(admin, {
      categoryId: category.id, title: '第一篇', content: '正文一', sort: 1,
    })
    const second = await createArticle(admin, {
      categoryId: category.id, title: '第二篇', content: '正文二', sort: 2, published: true,
    })
    const third = await createArticle(admin, {
      categoryId: category.id, title: '第三篇', content: '正文三', sort: 3,
    })
    const elsewhere = await createArticle(admin, {
      categoryId: other.id, title: '其他文章', content: '正文', sort: 0, published: true,
    })

    const pageOne = await call(admin, 'GET', '/api/admin/kb/articles?page=1&pageSize=2')
    expect(pageOne.status).toBe(200)
    const pageOneBody = await pageOne.json() as { articles: ArticleSummary[], total: number, page: number, pageSize: number }
    expect(pageOneBody).toMatchObject({ total: 4, page: 1, pageSize: 2 })
    expect(pageOneBody.articles.map((item) => item.id)).toEqual([first.id, second.id])
    expect(pageOneBody.articles[0]?.content).toBeUndefined()

    const pageTwo = await call(admin, 'GET', '/api/admin/kb/articles?page=2&pageSize=2')
    expect((await pageTwo.json() as { articles: ArticleSummary[] }).articles.map((item) => item.id))
      .toEqual([third.id, elsewhere.id])

    const filtered = await call(admin, 'GET', `/api/admin/kb/articles?categoryId=${category.id}`)
    expect(filtered.status).toBe(200)
    expect((await filtered.json() as { articles: ArticleSummary[], total: number }))
      .toMatchObject({ total: 3, articles: [{ id: first.id }, { id: second.id }, { id: third.id }] })

    const drafts = await call(admin, 'GET', '/api/admin/kb/articles?published=false')
    expect((await drafts.json() as { articles: ArticleSummary[] }).articles.map((item) => item.id))
      .toEqual([first.id, third.id])

    await expectError(
      await call(admin, 'GET', '/api/admin/kb/articles?published=maybe'),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(admin, 'GET', '/api/admin/kb/articles?categoryId=abc'),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(admin, 'GET', '/api/admin/kb/articles?categoryId=9999'),
      404,
      'KB_CATEGORY_NOT_FOUND',
    )
  })
})

describe('knowledge base user surface', () => {
  it('hides drafts from lists, detail, and search until published', async () => {
    const admin = await login()
    const reader = await provisionUser(admin, 'kb-user', 'kb user password')
    const category = await createCategory(admin, { name: '客户端教程', sort: 0 })
    const draftsOnly = await createCategory(admin, { name: '仅有草稿', sort: 1 })

    const draft = await createArticle(admin, {
      categoryId: category.id,
      title: '草稿文章',
      content: '这段正文只给管理员看',
    })
    const hiddenCategoryDraft = await createArticle(admin, {
      categoryId: draftsOnly.id,
      title: '隐藏分类草稿',
      content: '分类下没有已发布文章',
    })
    const published = await createArticle(admin, {
      categoryId: category.id,
      title: '已发布文章',
      content: '所有用户都能看到',
      published: true,
      sort: 1,
    })

    const initial = await readUserKb(reader.cookie)
    expect(initial.categories.map((item) => item.id)).toEqual([category.id])
    expect(initial.categories[0]?.articles.map((item) => item.id)).toEqual([published.id])
    expect(JSON.stringify(initial)).not.toContain(draft.title)
    expect(JSON.stringify(initial)).not.toContain(hiddenCategoryDraft.title)

    await expectError(
      await call(reader.cookie, 'GET', `/api/kb/articles/${draft.id}`),
      404,
      'KB_ARTICLE_NOT_FOUND',
    )
    expect(await search(reader.cookie, '草稿')).toEqual([])

    const beforePublish = await call(admin, 'GET', '/api/admin/kb/articles?published=false')
    expect((await beforePublish.json() as { articles: ArticleSummary[] }).articles.map((item) => item.id))
      .toEqual([draft.id, hiddenCategoryDraft.id])

    const publishedDraft = await call(admin, 'PUT', `/api/admin/kb/articles/${draft.id}`, { published: true })
    expect(publishedDraft.status).toBe(200)
    await call(admin, 'PUT', `/api/admin/kb/articles/${hiddenCategoryDraft.id}`, { published: true })

    const afterPublish = await readUserKb(reader.cookie)
    expect(afterPublish.categories.map((item) => item.id)).toEqual([category.id, draftsOnly.id])
    expect(afterPublish.categories[0]?.articles.map((item) => item.id)).toEqual([draft.id, published.id])
    expect(afterPublish.categories[1]?.articles.map((item) => item.id)).toEqual([hiddenCategoryDraft.id])

    const detail = await call(reader.cookie, 'GET', `/api/kb/articles/${draft.id}`)
    expect(detail.status).toBe(200)
    expect((await detail.json() as { article: Article }).article.content).toBe('这段正文只给管理员看')

    const hits = await search(reader.cookie, '只给管理员')
    expect(hits.map((item) => item.id)).toEqual([draft.id])

    await call(admin, 'PUT', `/api/admin/kb/articles/${draft.id}`, { published: false })
    await expectError(
      await call(reader.cookie, 'GET', `/api/kb/articles/${draft.id}`),
      404,
      'KB_ARTICLE_NOT_FOUND',
    )
    expect(await search(reader.cookie, '只给管理员')).toEqual([])
  })

  it('groups by category order and searches title and content with literal wildcards', async () => {
    const admin = await login()
    const reader = await provisionUser(admin, 'kb-search', 'kb search password')
    const basics = await createCategory(admin, { name: '基础', sort: 0 })
    const advanced = await createCategory(admin, { name: '进阶', sort: 1 })

    const titleHit = await createArticle(admin, {
      categoryId: basics.id, title: '如何导入订阅', content: '打开客户端后粘贴链接', published: true, sort: 2,
    })
    const contentHit = await createArticle(admin, {
      categoryId: advanced.id, title: '规则模板', content: '这里包含分流规则与 DNS 设置', published: true, sort: 1,
    })
    const percentHit = await createArticle(admin, {
      categoryId: advanced.id, title: '成功率说明', content: '实测成功率 100% 可达', published: true, sort: 2,
    })
    const scale = await createArticle(admin, {
      categoryId: advanced.id, title: '规模说明', content: '支持 1000 个节点', published: true, sort: 3,
    })

    await createArticle(admin, {
      categoryId: basics.id, title: '订阅草稿', content: '如何导入订阅（草稿）', published: false, sort: 1,
    })

    const grouped = await readUserKb(reader.cookie)
    expect(grouped.categories.map((item) => ({ name: item.name, ids: item.articles.map((article) => article.id) })))
      .toEqual([
        { name: '基础', ids: [titleHit.id] },
        { name: '进阶', ids: [contentHit.id, percentHit.id, scale.id] },
      ])
    expect(grouped.categories[1]?.articles.map((item) => item.title))
      .toEqual(['规则模板', '成功率说明', '规模说明'])

    expect((await search(reader.cookie, '导入订阅')).map((item) => item.id)).toEqual([titleHit.id])
    expect((await search(reader.cookie, '分流规则')).map((item) => item.id)).toEqual([contentHit.id])
    expect((await search(reader.cookie, '100%')).map((item) => item.id)).toEqual([percentHit.id])
    expect((await search(reader.cookie, '1000'))).toHaveLength(1)
    expect((await search(reader.cookie, '不存在的关键词'))).toEqual([])

    const results = await search(reader.cookie, '规则')
    expect(results[0]).toMatchObject({ categoryId: advanced.id, categoryName: '进阶', title: '规则模板' })
    expect(results[0]?.content).toBeUndefined()

    await expectError(
      await call(reader.cookie, 'GET', '/api/kb/search'),
      422,
      'VALIDATION_FAILED',
    )
    await expectError(
      await call(reader.cookie, 'GET', '/api/kb/search?q=%20%20'),
      422,
      'VALIDATION_FAILED',
    )
  })
})

describe('knowledge base migration', () => {
  it('stores categories and articles with deterministic ordering', async () => {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kb_categories', 'kb_articles') ORDER BY name`,
    ).all<{ name: string }>()
    expect(rows.results.map((row) => row.name)).toEqual(['kb_articles', 'kb_categories'])
  })
})
