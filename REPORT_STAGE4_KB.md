# 阶段 4 报告：知识库

基线 `508129b`（含权益 `0008` 与工单公告 `0009`，基线 397 个测试全过），分支 `task/stage4-kb-cmd`。本期只做知识库：分类、文章、用户端教程与搜索、管理端 CRUD。未改动既有 API 口径、配色与布局体系，未引入新依赖。迁移编号按简报固定为 `0011`，`0010` 在本分支未使用，保留空号。

## 数据表（`migrations/0011_knowledge_base.sql`）

### `kb_categories`

| 列 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY` | 自增 |
| `name` | `TEXT NOT NULL CHECK (length(trim(name)) > 0)` | 分类名，唯一 |
| `sort` | `INTEGER NOT NULL DEFAULT 0 CHECK (sort >= 0)` | 越小越靠前 |
| `created_at` | `TEXT NOT NULL` | ISO 8601 |

索引：`kb_categories_name`（唯一）、`kb_categories_sort(sort, id)`。

### `kb_articles`

| 列 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | `INTEGER PRIMARY KEY` | 自增 |
| `category_id` | `INTEGER NOT NULL REFERENCES kb_categories(id) ON DELETE RESTRICT` | 所属分类 |
| `title` | `TEXT NOT NULL CHECK (length(trim(title)) > 0)` | 标题 |
| `content` | `TEXT NOT NULL CHECK (length(trim(content)) > 0)` | Markdown 正文 |
| `published` | `INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1))` | `0` 草稿，`1` 已发布 |
| `sort` | `INTEGER NOT NULL DEFAULT 0 CHECK (sort >= 0)` | 同分类内排序 |
| `created_at` / `updated_at` | `TEXT NOT NULL` | ISO 8601 |

索引：`kb_articles_category(category_id, sort, id)`、`kb_articles_published(published, sort, id)`。

删除语义：分类下有文章时返回 `409 KB_CATEGORY_IN_USE`，不做级联删除；文章删除不影响分类。

## 接口清单

### 管理端（需管理员，挂在现有 `/api/admin/*` 鉴权下）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/admin/kb/categories` | 分类列表，`sort ASC, id ASC` |
| `POST` | `/api/admin/kb/categories` | 新建：`{ name, sort? }`，重名 `409 KB_CATEGORY_NAME_TAKEN` |
| `PUT` | `/api/admin/kb/categories/:id` | 部分更新 `{ name?, sort? }` |
| `DELETE` | `/api/admin/kb/categories/:id` | 删除；有文章 `409 KB_CATEGORY_IN_USE` |
| `GET` | `/api/admin/kb/articles` | 服务端分页：`?page=&pageSize=&categoryId=&published=true|false`，返回 `{ articles, total, page, pageSize }`（默认 20，上限 100） |
| `GET` | `/api/admin/kb/articles/:id` | 管理端详情，含正文 |
| `POST` | `/api/admin/kb/articles` | 新建：`{ categoryId, title, content, published?, sort? }`，默认草稿 |
| `PUT` | `/api/admin/kb/articles/:id` | 部分更新同一组字段 |
| `DELETE` | `/api/admin/kb/articles/:id` | 删除，成功 `204` |

列表不返回正文，只有详情返回 `content`；列表按 `分类 sort, 文章 sort, 文章 id` 排序。

### 用户端（需登录，挂在现有 `/api/kb` 鉴权下）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/kb` | 仅已发布文章，按分类分组；没有已发布文章的分类不返回 |
| `GET` | `/api/kb/articles/:id` | 仅已发布文章，草稿与不存在统一 `404 KB_ARTICLE_NOT_FOUND` |
| `GET` | `/api/kb/search?q=` | 仅已发布文章，匹配标题或正文；`q` 为空/超 100 字返回 `422 VALIDATION_FAILED` |

搜索用参数化 `LIKE`，并对 `\`、`%`、`_` 做转义，避免用户输入被当作通配符（例如 `100%` 只匹配字面量）。响应中不返回正文，只返回 `id/categoryId/categoryName/title/sort/updatedAt` 等摘要字段。

## 页面与导航

- 管理端「知识库」：`/kb/manage`，侧栏「系统管理」新增入口。页面包含：
  - 分类列表与内置新建/编辑表单、删除确认；分类名称与排序可维护。
  - 文章表格：标题、分类、发布状态、排序、更新时间、编辑/删除；分类与发布状态筛选、服务端分页。
  - 文章抽屉编辑：分类选择、标题、Markdown 正文文本域、排序、发布开关。
- 用户端「知识库」：`/kb`，顶部搜索框（250ms 防抖），下方按分类列出已发布文章；搜索结果独立展示标题与分类。
- 用户端文章详情：`/kb/:id`，展示分类、更新时间与渲染后的正文。
- 导航：用户端「更多」菜单与「我的」页菜单都加入「知识库」，不新开一级导航；管理端入口挂在已有侧栏分区。
- 样式：新增 `src/styles/pages-kb.css`，全部 `kb-` 前缀，沿用现有 token 与共享组件，未修改既有页面样式。

## Markdown 渲染选择

`package.json` 没有 Markdown 库，按简报要求不引入重型依赖，新增 `src/features/kb/markdown.ts` 实现最小安全渲染：

1. 先对全文做 HTML 转义（`& < > " '`），从根上阻止原始 HTML 注入。
2. 再识别代码块（三反引号）、标题（`#` 1–6 级）、无序/有序列表、粗体、行内代码和链接。
3. 链接只允许 `http:`、`https:`、`mailto:`、站内 `/` 与 `#`；其他协议（如 `javascript:`）只保留文本，不生成 `href`。
4. 输出通过 `dangerouslySetInnerHTML` 注入，但所有文本与属性值都来自转义后的内容，链接地址另做协议白名单。

支持范围覆盖简报要求的标题、列表、链接、代码块、粗体，另加行内代码；不支持表格、图片、引用等扩展语法。

## 测试

新增 9 个用例、2 个测试文件：

- `development/tests/worker/kb.test.ts`（5 个）：
  1. 分类/文章 CRUD 的登录与管理员权限、重名冲突、字段校验、404/409、分类占用保护。
  2. 管理端文章列表的分页、分类筛选、发布状态筛选与非法参数。
  3. 草稿在用户端列表、详情、搜索中不可见；发布后立即出现，再次下架后消失。
  4. 用户端按分类排序分组、标题/正文搜索命中、`%` 字面量转义、空关键词校验。
  5. `0011` 迁移后 `kb_categories`、`kb_articles` 表存在。
- `development/tests/worker/kb-markdown.test.ts`（4 个）：HTML 转义、标题/列表/粗体/代码块、链接协议白名单、有序列表与行内代码。

迁移与测试基础设施同步更新：

- `development/tests/worker/d1.ts` 注册 `0011_knowledge_base.sql`，`D1_TABLES` 加入 `kb_articles`、`kb_categories`。
- `d1-foundation.test.ts` 的迁移名列表与重放计数更新为 10。
- `helpers.ts` 在 `enableD1Modules()` 中调用 `clearKnowledgeBaseStorage()`，保证用例隔离。

验证结果：

- `npm test`：54 个测试文件、406 个用例全部通过（基线 397 个不回退，新增 9 个）。
- `npm run check`：`wrangler types --check`、`tsc -b`、`oxlint` 全部通过（0 警告 0 错误）。
- `npm run build`：worker 与 client 构建均通过。

## 本期未做

- 未迁移既有「订阅客户端教程」正文：仓库中没有可作为数据源的教程内容，本期只提供录入与展示能力。
- 不做附件、图片上传、文章版本历史、全文高亮与站内评论。
- 不引入 Markdown 依赖，也不改动其他功能的页面与视觉体系。
