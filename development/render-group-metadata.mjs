// Read Wrangler --json output for PRAGMA table_info(groups) from stdin.
// Inspect and execute the resulting SQL file against the same database.
import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8'))
const [result] = input
if (input.length !== 1 || result?.success !== true || !result.results?.some((column) => column.name === 'id')) {
  throw new Error('Expected one successful PRAGMA table_info(groups) result')
}

const columns = new Set(result.results.map((column) => column.name))
const template = readFileSync(new URL('../migrations/0032_group_metadata.sql', import.meta.url), 'utf8')
const statements = template.split('\n').filter((line) => {
  const column = /^ALTER TABLE groups ADD COLUMN (\w+)/.exec(line)?.[1]
  return column && !columns.has(column)
})
process.stdout.write((statements.length ? statements.join('\n') : 'SELECT 1;') + '\n')
