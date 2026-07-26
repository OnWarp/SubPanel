import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_HELP, diagnosticDescription } from '../../../src/features/delivery/diagnostics'

describe('subscription diagnostic copy', () => {
  it('does not claim a node is included when an unsupported field forces a skip', () => {
    expect(diagnosticDescription({
      nodeId: 'node_1',
      code: 'UNSUPPORTED_FIELD',
      outcome: 'skipped',
      fields: ['extensions.shadowtls'],
      message: '节点包含该客户端无法安全表达的字段',
    })).toBe('已跳过：节点包含目标客户端无法安全表达的字段')
  })

  it('explains that the outcome is per node and distinguishes included fields', () => {
    expect(DIAGNOSTIC_HELP).toBe('已跳过表示该节点未输出；节点仍会输出表示仅列出的字段未能映射，相关能力可能失效。')
  })
})
