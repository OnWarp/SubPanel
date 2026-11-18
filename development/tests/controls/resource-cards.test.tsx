import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { ResourceFooter, ResourceRowActions, ResourceSelectAll } from '../../../src/features/admin-resources/ResourceCard'
import { GroupsPage } from '../../../src/features/catalog/GroupsPage'
import { NodesPage } from '../../../src/features/catalog/NodesPage'
import { SourcesPage } from '../../../src/features/catalog/SourcesPage'
import { AdminSharesPage } from '../../../src/features/delivery/AdminSharesPage'
import { SubscriptionsPage } from '../../../src/features/delivery/SubscriptionsPage'
import { DataTable } from '../../../src/ui/DataTable'
import { Pagination } from '../../../src/ui/Pagination'
import { ToastProvider } from '../../../src/ui/Toast'

const noop = () => undefined

describe('admin resource list cards', () => {
  it.each([
    { Page: GroupsPage, id: 'groups-title', title: '分组', search: '搜索名称', action: '添加分组', unit: '个分组', paged: false },
    { Page: NodesPage, id: 'nodes-title', title: '节点', search: '搜索节点', paged: true, unit: '个节点' },
    { Page: SourcesPage, id: 'sources-title', title: '来源', search: '搜索来源', action: '添加来源', unit: '个来源', paged: false },
    { Page: SubscriptionsPage, id: 'subscriptions-title', title: '订阅', search: '搜索订阅', action: '添加订阅', unit: '个订阅', paged: true },
    { Page: AdminSharesPage, id: 'ashr-shares-title', title: '分享管理', search: '搜索分享', unit: '个分享', paged: true },
  ])('renders the title, search and total inside the $title card', ({ Page, id, title, search, action, unit, paged }) => {
    const html = renderToStaticMarkup(<MemoryRouter><ToastProvider><Page /></ToastProvider></MemoryRouter>)
    const card = html.split(`aria-labelledby="${id}">`)[1].split('</section>')[0]
    const heading = card.split('</header>')[0]

    expect(heading).toContain(`<h1 id="${id}">${title}</h1>`)
    if (action) expect(heading).toContain(action)
    else expect(heading).not.toContain('<button')
    expect(card).toContain(`aria-label="${search}"`)
    expect(card).toContain(`共 0 ${unit}`)
    expect(card).toContain('1 / 1 页')
    expect(card.includes('aria-label="下一页"')).toBe(paged)
  })

  it('keeps the rendered selection control and the narrow-screen column label', () => {
    const html = renderToStaticMarkup(<DataTable columns={[{
      key: 'selection',
      header: '选择',
      headerContent: <ResourceSelectAll label="选择当前页" ids={['a']} selected={new Set(['a'])} disabled={false} onChange={noop} />,
      render: () => 'a',
    }]} rows={['a']} rowKey={(row) => row} />)
    expect(html).toMatch(/<th[^>]*>.*aria-label="选择当前页".*checked=""/)
    expect(html).toContain('<td data-label="选择">a</td>')
  })

  it('connects a row trigger to all actions and preserves disabled states', () => {
    const html = renderToStaticMarkup(<ResourceRowActions actions={[
      { label: '查看详情', onClick: noop },
      { label: '临时分享', disabled: true, onClick: noop },
    ]} />)
    const id = html.match(/popoverTarget="([^"]+)"/i)?.[1]
    expect(id).toBeTruthy()
    expect(html).toContain(`id="${id}" popover="auto"`)
    expect(html).toContain('>查看详情</button>')
    expect(html).toContain('disabled="">临时分享</button>')
  })

  it('uses compact paging in the card and keeps numbered paging for existing callers', () => {
    const props = { page: 2, pageCount: 3, onPageChange: noop }
    const compact = renderToStaticMarkup(<ResourceFooter count={41} unit="个节点" pagination={props} />)
    expect(compact).toContain('共 41 个节点')
    expect(compact).toContain('aria-current="page">2 / 3 页</span>')
    expect(compact).toContain('aria-label="上一页"')
    expect(compact).toContain('aria-label="下一页"')
    const numbered = renderToStaticMarkup(<Pagination {...props} />)
    expect(numbered).toContain('aria-current="page">2</button>')
  })
})
