import { DomainError } from '../contracts/errors.ts'

export interface EmergencyGuidance {
  content: string; contacts: { label: string; number: string; action: 'information_only' }[]
  region: string; verifiedAt: string; source: string; version: number
}
export function readGuidance(input: unknown): EmergencyGuidance {
  const fail = () => { throw new DomainError('emergency_guidance_unavailable') }
  if (!input || typeof input!=='object' || Array.isArray(input)) return fail()
  const value = input as EmergencyGuidance
  if (![value.content,value.region,value.source,value.verifiedAt].every(v=>typeof v==='string' && v.trim()) ||
    !Number.isFinite(Date.parse(value.verifiedAt)) || !Number.isInteger(value.version) || value.version<1 || !Array.isArray(value.contacts)) return fail()
  let source: URL
  try { source = new URL(value.source) } catch { return fail() }
  if (source.protocol!=='https:' || source.username || source.password) return fail()
  if (value.contacts.some(c=>!c || typeof c.label!=='string' || !c.label.trim() || typeof c.number!=='string' || !/^\+?[0-9 -]{3,30}$/.test(c.number) || c.action!=='information_only')) return fail()
  return { content:value.content, contacts:value.contacts.map(c=>({label:c.label,number:c.number,action:c.action})),
    region:value.region,verifiedAt:value.verifiedAt,source:value.source,version:value.version }
}
