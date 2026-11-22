import { useState } from 'react'
import type { CatalogNode } from '../../app/api'
import { Checkbox } from '../../ui/Controls'
import { SearchInput } from '../../ui/SearchInput'

export function NodeAssignmentPicker({ nodes, selected, onChange }: {
  nodes: CatalogNode[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const selectedIds = new Set(selected)
  const needle = query.trim().toLowerCase()
  const choices = nodes.filter((node) => node.enabled && !selectedIds.has(node.id) &&
    (!needle || `${node.displayName} ${node.id}`.toLowerCase().includes(needle)))
  return (
    <details className="choice-section">
      <summary>指定节点快照 · 已选 {selected.length} 个</summary>
      {selected.length > 0 && <div className="choice-list" aria-label="已选节点">
        {selected.map((id) => {
          const node = byId.get(id)
          return <label className="choice-row" key={id}>
            <Checkbox checked aria-label={`移除节点 ${node?.displayName ?? id}`} onChange={() => onChange(selected.filter((value) => value !== id))} />
            <span>{node?.displayName ?? id}{!node?.enabled && '（当前不可用）'}</span>
          </label>
        })}
      </div>}
      <SearchInput label="搜索可选节点" placeholder="搜索节点" value={query} onChange={setQuery} />
      <div className="choice-list">
        {choices.slice(0, 40).map((node) => <label className="choice-row" key={node.id}>
          <Checkbox checked={false} aria-label={`选择节点 ${node.displayName}`} onChange={() => onChange([...selected, node.id])} />
          <span>{node.displayName}</span>
        </label>)}
        {choices.length === 0 && <p className="drawer-note">没有匹配的可用节点</p>}
      </div>
      {choices.length > 40 && <p className="drawer-note">显示前 40 个结果，可搜索其余节点</p>}
    </details>
  )
}
