import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubscriptionDetailRows } from '../../../src/features/delivery/SubscriptionDetailRows'
import { Input, Textarea } from '../../../src/ui/Controls'
import { FormField, FormGroup } from '../../../src/ui/FormField'
import { Switch } from '../../../src/ui/Switch'

describe('design v2 form and detail contracts', () => {
  it('renders subscription details as hairline rows with a shared section title', () => {
    const html = renderToStaticMarkup(<SubscriptionDetailRows
      user="alice" groups="默认分组"
      plan={{ name: '月付', traffic: '100 GB', speed: '不限', devices: '3' }}
      links={[{ client: 'mihomo', label: 'Mihomo', link: 'https://example.test/sub/token' }]}
      client="mihomo" primaryLink="https://example.test/sub/token" linkError=""
      onClient={() => {}} onCopied={() => {}} onCopyError={() => {}} onShowQr={() => {}}
      bindingLabel="继承默认" templateName="办公分流" version="v3"
      bindingError="" bindingLoading={false}
      diagnostics={[{ key: 'mihomo', label: 'Mihomo', available: true, summary: '输入 1 · 输出 1 · 跳过 0', items: [] }]}
    />)
    expect(html).toContain('subscription-details')
    expect(html).toContain('drawer-section-title')
    expect(html).toContain('key-value-rows')
    expect(html).toContain('基本信息')
    expect(html).toContain('客户端链接')
    expect(html).toContain('class="subscription-link-row"')
    expect(html).toContain('class="link-url del-link-text"')
    expect(html).toContain('附加配置')
    expect(html).toContain('兼容诊断')
    expect(html).not.toContain('subscription-detail-fields')
    expect(html).not.toContain('profile-fields')
  })

  it('groups fields, caps ordinary fields, and shows switch state without color alone', () => {
    const html = renderToStaticMarkup(<form className="form-stack sp-form-stack">
      <FormGroup id="group-basic" title="基本信息">
        <FormField label="名称" htmlFor="name"><Input id="name" /></FormField>
        <FormField label="YAML" htmlFor="yaml" wide><Textarea id="yaml" /></FormField>
      </FormGroup>
      <Switch label="启用" checked onChange={() => {}} />
      <Switch ariaLabel="停用项" checked={false} onChange={() => {}} />
    </form>)
    expect(html).toContain('sp-form-group')
    expect(html).toContain('sp-form-group-title')
    expect(html).toContain('基本信息')
    expect(html).toContain('sp-form-stack')
    expect(html).toContain('sp-form-field-wide')
    expect(html).toContain('aria-hidden="true">开</span>')
    expect(html).toContain('aria-hidden="true">关</span>')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-label="启用"')
  })
})
