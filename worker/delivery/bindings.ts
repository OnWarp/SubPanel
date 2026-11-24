import { z } from 'zod'
import { expiryFromDuration } from '../../shared/subscription-duration.js'
import { apiError } from '../platform/api-error.js'
import { hashToken } from '../platform/crypto.js'
import type { DataEnv } from '../db/module-switch.js'
import { durationSchema, entitlementConfigSchema, templateStatusSchema } from './entitlement-templates.js'
import { accountAvailable, bindingConflict, prepareUserAccess, readUserAccess, subscriptionNotFound } from './user-access.js'

export const maxBindings = 32
const epoch = z.number().int().min(-8_640_000_000_000_000).max(8_640_000_000_000_000)
const expiry = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('default') }),
  z.strictObject({ type: z.literal('duration'), duration: durationSchema }),
  z.strictObject({ type: z.literal('absolute'), expiresAt: epoch }),
  z.strictObject({ type: z.literal('permanent') }),
])
const id = z.string().min(1).max(128)
const timing = { expiry: expiry.default({ type: 'default' }), startsAt: epoch.optional() }
const request = { requestId: id, expectedRevision: z.number().int().nonnegative() }
export const bindingInput = z.discriminatedUnion('mode', [
  z.strictObject({ ...request, mode: z.literal('assign'), ...timing }),
  z.strictObject({ ...request, mode: z.literal('renew'), expiry: expiry.default({ type: 'default' }) }),
  z.strictObject({ ...request, mode: z.enum(['pause', 'resume', 'revoke']) }),
])
export const replaceInput = z.discriminatedUnion('mode', [
  z.strictObject({ ...request, ...timing, mode: z.literal('replace'), oldTemplateId: id, newTemplateId: id }),
  z.strictObject({ ...request, ...timing, mode: z.literal('replaceAll'), confirm: z.literal(true), newTemplateId: id }),
])

export type Binding = {
  template_id: string
  starts_at: number
  expires_at: number | null
  status: 'active' | 'paused' | 'revoked'
  revision: number
}
type Template = {
  template_status: z.infer<typeof templateStatusSchema>
  template_revision: number
  owner_user_id: string | null
  version_id: string | null
  schema_version: number | null
  config_json: string | null
}
export type BindingRow = Binding & Template

const templateColumns = 't.status AS template_status,t.revision AS template_revision,p.owner_user_id,v.id AS version_id,v.schema_version,v.config_json'
const versionJoin = `LEFT JOIN private_entitlement_templates p ON p.template_id=t.id
  LEFT JOIN entitlement_template_versions v ON v.template_id=t.id AND v.version_no=
    (SELECT max(version_no) FROM entitlement_template_versions WHERE template_id=t.id)`

export async function readBindings(db: D1Database, userId: string, includeRevoked = true) {
  const { results } = await db.prepare(`SELECT b.*, ${templateColumns}
    FROM user_template_bindings b JOIN entitlement_templates t ON t.id=b.template_id ${versionJoin}
    WHERE b.user_id=? ${includeRevoked ? '' : "AND b.status IN ('active','paused')"} ORDER BY b.template_id`).bind(userId).all<BindingRow>()
  return results
}

export function bindingConfig(template: Template) {
  if (template.schema_version !== 1 || !template.config_json) {
    throw apiError(409, 'ENTITLEMENT_VERSION_UNAVAILABLE', '模板版本不可用')
  }
  return entitlementConfigSchema.parse(JSON.parse(template.config_json))
}

type Operation = z.infer<typeof bindingInput> | z.infer<typeof replaceInput>
export type BindingChange = { before: Binding | null; after: Binding }
function snapshot(row: Binding | undefined): Binding | null {
  if (!row) return null
  const { template_id, starts_at, expires_at, status, revision } = row
  return { template_id, starts_at, expires_at, status, revision }
}

export async function planBinding(
  db: D1Database, userId: string, templateId: string, input: Operation, now: number,
) {
  const access = await readUserAccess(db, { userId })
  if (!accountAvailable(access)) throw subscriptionNotFound()
  if (input.expectedRevision !== (access.revision ?? 0)) throw bindingConflict()
  const rows = await readBindings(db, userId)
  const before = snapshot(rows.find(row => row.template_id === templateId))
  const operations = ['assign', 'renew', 'replace', 'replaceAll']
  const assigning = operations.includes(input.mode)
  const template = assigning || input.mode === 'resume'
    ? await db.prepare(`SELECT ${templateColumns} FROM entitlement_templates t ${versionJoin}
        WHERE t.id=? AND t.status='enabled' AND (p.owner_user_id IS NULL OR p.owner_user_id=?)`)
      .bind(templateId, userId).first<Template>()
    : null
  if ((assigning || input.mode === 'resume') && !template) throw subscriptionNotFound()

  let starts_at = before?.starts_at ?? now
  let expires_at = before?.expires_at ?? null
  let status: Binding['status'] = 'active'
  if ('expiry' in input && template) {
    if (input.mode === 'renew' && before?.status !== 'active') throw bindingConflict()
    if (input.mode !== 'renew') starts_at = ('startsAt' in input ? input.startsAt : undefined) ?? now
    const preservePermanent = before !== null && before.status !== 'revoked' && before.expires_at === null
    if (preservePermanent) starts_at = Math.min(starts_at, before.starts_at)
    const config = bindingConfig(template)
    const base = input.mode === 'renew' ? Math.max(now, before?.expires_at ?? now) : starts_at
    const rule = input.expiry
    if (input.mode === 'renew' && rule.type === 'absolute') {
      throw apiError(400, 'BINDING_TIME_INVALID', '续期需要相对时长或永久有效期')
    }
    expires_at = preservePermanent || rule.type === 'permanent'
      ? null : rule.type === 'absolute' ? rule.expiresAt
        : expiryFromDuration(base, rule.type === 'duration' ? rule.duration : config.duration)
    if (!epoch.safeParse(starts_at).success || (expires_at !== null &&
      (!epoch.safeParse(expires_at).success || expires_at <= starts_at))) {
      throw apiError(400, 'BINDING_TIME_INVALID', '授权有效期无效')
    }
  } else {
    if (!before || before.status === 'revoked' || (input.mode === 'resume' && before.status !== 'paused')) {
      throw bindingConflict()
    }
    status = input.mode === 'pause' ? 'paused' : input.mode === 'revoke' ? 'revoked' : 'active'
  }
  const changes: BindingChange[] = [{ before, after: { template_id: templateId, starts_at, expires_at, status, revision: (before?.revision ?? 0) + 1 } }]
  const replaced = input.mode === 'replace' ? rows.filter(row => row.template_id === input.oldTemplateId && row.status !== 'revoked')
    : input.mode === 'replaceAll' ? rows.filter(row => row.template_id !== templateId && row.status !== 'revoked') : []
  if (input.mode === 'replace' && (replaced.length !== 1 || input.oldTemplateId === templateId)) throw bindingConflict()
  for (const row of replaced) {
    const prior = snapshot(row)!
    changes.push({ before: prior, after: { ...prior, status: 'revoked', revision: prior.revision + 1 } })
  }
  const count = rows.filter(row => row.status !== 'revoked').length
    + changes.reduce((delta, { before, after }) => delta + Number(after.status !== 'revoked')
      - Number(before !== null && before.status !== 'revoked'), 0)
  if (count > maxBindings) throw apiError(409, 'BINDING_LIMIT', '授权模板数量超出限制')
  return { changes, templateRevision: template?.template_revision ?? null }
}

type BindingResult = { revision: number; changes: BindingChange[] }

export async function mutateBinding(env: DataEnv, userId: string, templateId: string, input: Operation, actor: string, now = Date.now()): Promise<BindingResult> {
  const { DB: db } = env
  const requestHash = await hashToken(JSON.stringify([actor, templateId, input]))
  const replay = async () => {
    const row = await db.prepare('SELECT request_hash,revision,changes_json FROM user_binding_requests WHERE user_id=? AND request_id=?')
      .bind(userId, input.requestId).first<{ request_hash: string; revision: number; changes_json: string }>()
    if (!row) return undefined
    if (row.request_hash !== requestHash) throw bindingConflict()
    return { revision: row.revision, changes: JSON.parse(row.changes_json) as BindingChange[] }
  }
  const previous = await replay()
  if (previous) return previous
  try {
    const { changes, templateRevision } = await planBinding(db, userId, templateId, input, now)
    const timestamp = new Date(now).toISOString()
    const expected = input.expectedRevision
    const revision = Math.max(1, expected) + 1
    const statements = expected === 0 ? [await prepareUserAccess(env, userId, timestamp)] : []
    // Force a constraint failure before any bind writes if the access or template changed.
    statements.push(db.prepare(`INSERT INTO user_binding_requests
      (user_id,request_id,actor,request_hash,changes_json,revision,created_at)
      VALUES (?,?,?,?,?, CASE WHEN
        (${expected === 0 ? 'changes()=1 AND' : ''} EXISTS (
          SELECT 1 FROM users u JOIN user_subscription_access a ON a.user_id=u.id
          WHERE u.id=? AND u.enabled=1 AND u.deleted_at IS NULL AND a.revision=?))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM entitlement_templates WHERE id=? AND revision=? AND status='enabled'))
        THEN ? END, ?)`).bind(userId, input.requestId, actor, requestHash, JSON.stringify(changes), userId,
      Math.max(1, expected), templateRevision, templateId, templateRevision, revision, timestamp))
    for (const { after } of changes) {
      statements.push(db.prepare(`INSERT INTO user_template_bindings
        (user_id,template_id,starts_at,expires_at,status,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id,template_id) DO UPDATE SET starts_at=excluded.starts_at,expires_at=excluded.expires_at,
          status=excluded.status,revision=excluded.revision,updated_at=excluded.updated_at`)
        .bind(userId, after.template_id, after.starts_at, after.expires_at, after.status, after.revision, timestamp, timestamp))
    }
    statements.push(db.prepare('UPDATE user_subscription_access SET revision=?,updated_at=? WHERE user_id=?')
      .bind(revision, timestamp, userId))
    await db.batch(statements)
    return { revision, changes }
  } catch (error) {
    const committed = await replay()
    if (committed) return committed
    if (error instanceof Error && error.message.includes('user_binding_requests.revision')) throw bindingConflict()
    throw error
  }
}

export async function mutateBindingsByUser(
  env: DataEnv, items: readonly { userId: string; templateId: string; input: Operation }[], actor: string,
) {
  if (items.length > maxBindings || new Set(items.map(item => item.userId)).size !== items.length) {
    throw apiError(400, 'BINDING_BATCH_INVALID', '批量请求必须按用户分项')
  }
  const results: PromiseSettledResult<BindingResult>[] = []
  for (const item of items) {
    const [result] = await Promise.allSettled([mutateBinding(env, item.userId, item.templateId, item.input, actor)])
    results.push(result)
  }
  return results
}
