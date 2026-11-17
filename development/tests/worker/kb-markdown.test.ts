import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../../../src/features/kb/markdown'

describe('knowledge base markdown renderer', () => {
  it('escapes raw HTML before formatting', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('renders headings, lists, bold, and code blocks', () => {
    const html = renderMarkdown('# 标题\n\n- 一\n- 二\n\n**粗体**\n\n```\nconst x = 1\n```')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<ul><li>一</li><li>二</li></ul>')
    expect(html).toContain('<strong>粗体</strong>')
    expect(html).toContain('<pre><code>const x = 1</code></pre>')
  })

  it('keeps safe links and drops unsafe schemes', () => {
    const safe = renderMarkdown('[文档](https://example.com/a?x=1&y=2)')
    expect(safe).toContain('href="https://example.com/a?x=1&amp;y=2"')
    expect(safe).toContain('>文档</a>')

    const unsafe = renderMarkdown('[点我](javascript:alert(1))')
    expect(unsafe).toBe('<p>点我</p>')
  })

  it('renders ordered lists and inline code', () => {
    const html = renderMarkdown('1. 第一步\n2. 第二步\n\n使用 `npm run dev` 启动')
    expect(html).toContain('<ol><li>第一步</li><li>第二步</li></ol>')
    expect(html).toContain('<code>npm run dev</code>')
  })
})
