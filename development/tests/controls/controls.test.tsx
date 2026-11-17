import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Checkbox, DateTimeInput, FileInput, FormSelect, Input, Textarea } from '../../../src/ui/Controls'
import { PasswordInput } from '../../../src/ui/PasswordInput'
import { Switch } from '../../../src/ui/Switch'

describe('project form contracts', () => {
  it('keeps submission names, constraints and disabled states on editing controls', () => {
    const html = renderToStaticMarkup(<form>
      <Input name="days" type="number" min={1} max={365} step={1} required defaultValue="7" />
      <Textarea name="body" maxLength={50000} required disabled defaultValue="正文" />
      <PasswordInput name="password" minLength={12} required autoComplete="new-password" />
      <DateTimeInput name="expiresAt" defaultValue="2026-11-17T12:30" />
    </form>)
    expect(html).toContain('name="days"')
    expect(html).toContain('min="1" max="365" step="1" required=""')
    expect(html).toContain('maxLength="50000" required="" disabled=""')
    expect(html).toContain('type="password"')
    expect(html).toContain('minLength="12" required="" autoComplete="new-password"')
    expect(html).toContain('type="datetime-local"')
    expect(html).toContain('value="2026-11-17T12:30"')
  })

  it('preserves numeric values and fragment/map labels without a native select', () => {
    const html = renderToStaticMarkup(<FormSelect id="plan" name="plan" value={2} required aria-label="计划">
      <option value="">选择计划</option>
      <>{[1, 2].map((id) => <option key={id} value={id}>计划 {id} · {30} 天</option>)}</>
    </FormSelect>)
    expect(html).not.toContain('<select')
    expect(html).toContain('计划 2 · 30 天')
    expect(html).toContain('aria-label="计划"')
    expect(html).toContain('type="hidden" name="plan"')
    expect(html).toContain('value="2"')
    expect(html).toContain('required=""')
    const fallback = renderToStaticMarkup(<FormSelect name="user" value=""><option value="first">首位用户</option></FormSelect>)
    expect(fallback).toContain('首位用户')
    expect(fallback).toContain('value="first"')
  })

  it('keeps checkbox semantics and switch labels', () => {
    const html = renderToStaticMarkup(<><Checkbox name="group" aria-label="分组" defaultChecked disabled /><Switch label="启用" checked disabled onChange={() => {}} /></>)
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
    expect(html).toContain('name="group"')
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-label="启用"')
    expect(html).toContain('disabled=""')
  })

  it('keeps file acceptance while presenting a project button', () => {
    const html = renderToStaticMarkup(<FileInput aria-label="来源文件" accept=".yaml,.json" disabled />)
    expect(html).toContain('accept=".yaml,.json"')
    expect(html).toContain('type="file" hidden=""')
    expect(html).toContain('选择文件</button>')
    expect(html).toContain('disabled=""')
  })
})
