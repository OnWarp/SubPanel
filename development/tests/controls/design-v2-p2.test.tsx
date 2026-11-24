import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubscriptionDetailRows } from '../../../src/features/delivery/SubscriptionDetailRows'
import { Input, Textarea } from '../../../src/ui/Controls'
import { FormField, FormGroup } from '../../../src/ui/FormField'
import { Switch } from '../../../src/ui/Switch'

describe('design v2 form and detail contracts', () => {
  it('renders aggregate subscription details as hairline rows', () => {
    const html = renderToStaticMarkup(<SubscriptionDetailRows permanent expiresAt={null} nodes={[{ name: 'Fixture', protocol: 'ss' }]} />)
    expect(html).toContain('key-value-rows')
    expect(html).toContain('最远到期')
    expect(html).toContain('长期有效')
    expect(html).toContain('聚合节点')
    expect(html).not.toContain('Fixture')
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
