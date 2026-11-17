export const templateDefaults = {
 verification: { subject: 'SubPanel 验证码 / Verification code', body: '{{username}}，你的 SubPanel 验证码是 {{code}}\n用途：{{purpose}}\n验证码 10 分钟内有效，请勿告诉任何人' },
 expiry_reminder: { subject: 'SubPanel 权益即将到期', body: '{{username}}，你的 {{plan}} 权益将于 {{expires_at}} 到期。' },
 broadcast: { subject: '{{subject}}', body: '{{body}}' },
}
export type TemplateKey = keyof typeof templateDefaults
export function interpolate(text: string, variables: Record<string, string>): string {
 return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => variables[key] ?? match)
}
export function textHtml(text: string): string {
 return '<p>' + text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll('\n','<br>') + '</p>'
}
export async function templateContent(db: D1Database, key: TemplateKey, variables: Record<string,string>, fallback = templateDefaults[key]) {
 let row: {subject:string;body:string}|null = null
 try { row = await db.prepare('SELECT subject,body FROM mail_templates WHERE key=?').bind(key).first<{subject:string;body:string}>() } catch (error) {
  if (!(error instanceof Error) || !/no such table.*mail_templates/i.test(error.message)) throw error
 }
 const subject = interpolate((row ?? fallback).subject, variables).replace(/[\r\n]+/g,' ')
 const text = interpolate((row ?? fallback).body, variables)
 return { subject, text, html: textHtml(text) }
}
