import { createHash } from 'node:crypto'
import { DomainError } from '../contracts/errors.ts'
import { runFlow, type FlowRunResult, type RunFlowOptions } from '../../plugins/langflow.ts'

export interface F2Context { patientId: string; message: string; baselineScore: number; assessmentId: string; sessionId: string }
export interface F2Binding { flowId: string; scorerId: string; scorerCodeSha256: string; verifiedAt: string }
export type F2Outcome = { action: 'escalate_immediately'; reason: string } | (Record<string, unknown> & {
  action: 'continue_monitoring' | 'trigger_plan_review'; patient_id: string; baseline_score: number; baseline_tier: string
  score: number; tier: string; tier_changed: boolean; next_checkin_days: number; label: string; disclaimer: string
})
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v==='object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v==='string' && !!v.trim()
const finite = (v: unknown): v is number => typeof v==='number' && Number.isFinite(v)
const tier = (v: unknown) => ['LOW','MEDIUM','HIGH'].includes(v as string)
export function validF2(outputText: string | null, context: Pick<F2Context,'patientId'|'baselineScore'>): F2Outcome | null {
  try {
    const v: unknown = outputText===null ? null : JSON.parse(outputText)
    if (!object(v)) return null
    if (v.action==='escalate_immediately') return text(v.reason) && Object.keys(v).every(k=>['action','reason'].includes(k)) ? v as F2Outcome : null
    if (!['continue_monitoring','trigger_plan_review'].includes(v.action as string) || v.patient_id!==context.patientId || v.baseline_score!==context.baselineScore ||
      !finite(v.score) || v.score<0 || !tier(v.tier) || !tier(v.baseline_tier) || typeof v.tier_changed!=='boolean' || !finite(v.next_checkin_days) ||
      !Number.isInteger(v.next_checkin_days) || v.next_checkin_days<=0 || !text(v.label) || !text(v.disclaimer) || !Array.isArray(v.adjustments) ||
      v.adjustments.some(a=>!object(a) || !text(a.condition) || typeof a.applied!=='boolean' || !finite(a.points)) || !object(v.extraction)) return null
    const e=v.extraction
    if (!Array.isArray(e.symptoms) || e.symptoms.some(s=>typeof s!=='string') || !['regular','irregular','unknown'].includes(e.medication_adherence as string) ||
      e.red_flag!==false || e.quote_of_red_flag!=='') return null
    return v as F2Outcome
  } catch { return null }
}

export class FlowGateway {
  constructor(private readonly options: {
    binding: F2Binding | null; baseUrl: string; apiKey: string; fetchImpl?: typeof fetch
    run?: (flowId: string,input: string,options: RunFlowOptions)=>Promise<FlowRunResult>
  }) {}
  async runF2(context: F2Context): Promise<FlowRunResult> {
    const b=this.options.binding
    if (!b || !text(b.flowId) || !text(b.scorerId) || !/^[a-f0-9]{64}$/.test(b.scorerCodeSha256) || !Number.isFinite(Date.parse(b.verifiedAt)) ||
      !text(context.patientId) || !text(context.message) || !text(context.assessmentId) || !text(context.sessionId) || !Number.isInteger(context.baselineScore) || context.baselineScore<0) throw new DomainError('dependency_unavailable')
    const response=await (this.options.fetchImpl??fetch)(`${this.options.baseUrl.replace(/\/$/,'')}/api/v1/flows/${encodeURIComponent(b.flowId)}`,
      {headers:{'x-api-key':this.options.apiKey},signal:AbortSignal.timeout(10000),redirect:'error'})
    if (!response.ok) throw new DomainError('dependency_unavailable')
    const flow=await response.json() as {id?:string;data?:{nodes?:{id:string;data?:{node?:{template?:Record<string,{value:unknown}>}}}[]}}
    const template=flow.data?.nodes?.find(n=>n.id===b.scorerId)?.data?.node?.template
    if (flow.id!==b.flowId || !template?.baseline_score || !template.patient_id || typeof template.code?.value!=='string' ||
      createHash('sha256').update(template.code.value).digest('hex')!==b.scorerCodeSha256) throw new DomainError('dependency_unavailable')
    return (this.options.run??runFlow)(b.flowId,JSON.stringify({patient_id:context.patientId,message:context.message}),{
      sessionId:context.sessionId,tweaks:{[b.scorerId]:{patient_id:context.patientId,baseline_score:context.baselineScore}},
    })
  }
}
