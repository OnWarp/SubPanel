const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? character)
}

function safeUrl(value: string): string | null {
  if (/^https?:\/\//iu.test(value)) return value
  if (/^mailto:/iu.test(value)) return value
  if (value.startsWith('/') || value.startsWith('#')) return value
  return null
}

function renderInline(value: string): string {
  return value
    .replace(/`([^`]+)`/gu, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/gu, (_match, label: string, url: string) => {
      const href = safeUrl(url)
      if (!href) return label
      return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label}</a>`
    })
}

function renderParagraph(lines: string[]): string {
  return `<p>${lines.map(renderInline).join('<br />')}</p>`
}

function renderProse(text: string): string {
  const lines = text.split('\n')
  const output: string[] = []
  let paragraph: string[] = []
  let list: { type: 'ul' | 'ol', items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      output.push(renderParagraph(paragraph))
      paragraph = []
    }
  }
  const flushList = () => {
    if (list) {
      const tag = list.type
      output.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`)
      list = null
    }
  }

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1]?.length ?? 1
      output.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`)
      continue
    }

    const unordered = /^\s*[-*]\s+(.*)$/u.exec(line)
    if (unordered) {
      flushParagraph()
      if (list?.type !== 'ul') {
        flushList()
        list = { type: 'ul', items: [] }
      }
      list.items.push(unordered[1] ?? '')
      continue
    }

    const ordered = /^\s*\d+\.\s+(.*)$/u.exec(line)
    if (ordered) {
      flushParagraph()
      if (list?.type !== 'ol') {
        flushList()
        list = { type: 'ol', items: [] }
      }
      list.items.push(ordered[1] ?? '')
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  return output.join('\n')
}

export function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source)
  const parts = escaped.split(/```[^\n]*\n?([\s\S]*?)```/gu)
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return `<pre><code>${part.replace(/\n$/u, '')}</code></pre>`
      return renderProse(part)
    })
    .join('\n')
}
