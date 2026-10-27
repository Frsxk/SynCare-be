import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { startReviewJob,resumeReviewJob } from '../../plugins/langflow.ts'
import { DomainError } from '../contracts/errors.ts'
import { object,text } from '../plans/contracts.ts'
import { canonicalPayloadHash } from '../contracts/idempotency.ts'
import type { ReviewGateway,UpstreamSnapshot } from './contracts.ts'
export class LangflowReviewGateway implements ReviewGateway {
  constructor(private readonly options:{baseUrl:string;apiKey:string;flowId:string;f5FlowId:string;reviewDbPath:string;fetchImpl?:typeof fetch}){}
  private async get(path:string,expected?:{jobId:string;sessionId:string}){
    const response=await(this.options.fetchImpl??fetch)(`${this.options.baseUrl.replace(/\/$/,'')}${path}`,{headers:{'x-api-key':this.options.apiKey},signal:AbortSignal.timeout(10000),redirect:'error'})
    if(!response.ok){
      let body:unknown;try{body=await response.json()}catch{}
      const detail=object(body)&&object(body.detail)?body.detail:null
      if(expected&&detail?.job_id===expected.jobId&&(!Object.hasOwn(detail,'flow_id')||detail.flow_id===this.options.flowId)&&(!Object.hasOwn(detail,'session_id')||detail.session_id===expected.sessionId)){
        const timeout=response.status===408&&detail.code==='EXECUTION_TIMEOUT'
        const failed=response.status===500&&detail.code==='JOB_FAILED'
        if(timeout||failed)return{job_id:expected.jobId,flow_id:this.options.flowId,session_id:expected.sessionId,
          status:timeout||(failed&&object(detail.error_detail)&&detail.error_detail.type==='input_timed_out')?'timed_out':'failed'}
      }
      throw new DomainError(response.status===404?'outcome_unknown':'dependency_unavailable')
    }
    return response.json() as Promise<Record<string,any>>
  }
  async topology(){
    const actual=(p:string)=>{try{const path=realpathSync.native(resolve(p));return process.platform==='win32'?path.toLowerCase():path}catch{throw new DomainError('dependency_unavailable')}}
    const expected=actual(this.options.reviewDbPath)
    for(const id of [this.options.flowId,this.options.f5FlowId]){
      const flow=await this.get(`/api/v1/flows/${encodeURIComponent(id)}`)
      if(flow.id!==id||!Array.isArray(flow.data?.nodes))throw new DomainError('dependency_unavailable')
      const paths=flow.data.nodes.flatMap((n:any)=>typeof n.data?.node?.template?.db_path?.value==='string'?[n.data.node.template.db_path.value]:[])
      if(paths.length!==1||actual(paths[0])!==expected)throw new DomainError('dependency_unavailable')
    }
  }
  async start(draft:string,sessionId:string){await this.topology();return startReviewJob(this.options.flowId,draft,sessionId,{fetchImpl:this.options.fetchImpl})}
  async discover(sessionId:string,planHash:string){
    const pending=await this.get(`/api/v2/workflows/pending?flow_id=${encodeURIComponent(this.options.flowId)}`) as unknown
    if(!Array.isArray(pending))throw new DomainError('outcome_unknown')
    const own=pending.filter(p=>p.session_id===sessionId&&p.flow_id===this.options.flowId)
    if(!own.length)return null
    if(own.length!==1||!text(own[0].job_id))throw new DomainError('outcome_unknown')
    let envelope;try{envelope=JSON.parse(own[0].prompt)}catch{throw new DomainError('outcome_unknown')}
    if(canonicalPayloadHash(envelope.plan_json)!==planHash)throw new DomainError('outcome_unknown')
    return own[0].job_id as string
  }
  async snapshot(jobId:string,sessionId:string):Promise<UpstreamSnapshot>{
    const v=await this.get(`/api/v2/workflows?job_id=${encodeURIComponent(jobId)}`,{jobId,sessionId})
    if(v.job_id!==jobId||v.flow_id!==this.options.flowId||!text(v.status)||('session_id'in v&&v.session_id!==sessionId))throw new DomainError('outcome_unknown')
    if(v.status==='suspended'){
      const pending=await this.get(`/api/v2/workflows/pending?flow_id=${encodeURIComponent(this.options.flowId)}`) as unknown
      if(!Array.isArray(pending))throw new DomainError('outcome_unknown')
      const matches=pending.filter(p=>p.job_id===jobId&&p.session_id===sessionId&&p.flow_id===this.options.flowId)
      if(matches.length!==1)return{status:v.status,gate:null}
      const p=matches[0],allowed=p.allowed_decisions
      if(!text(p.request_id)||!Array.isArray(allowed)||!allowed.length||allowed.length>12||allowed.some(k=>!text(k)||k.length>128)||new Set(allowed).size!==allowed.length||!Array.isArray(p.options))throw new DomainError('invalid_flow_output')
      const options=allowed.map((id:string)=>{const label=p.options.find((o:any)=>o.action_id===id)?.label;return{actionId:id,label:text(label)&&label.length<=160?label:id}})
      let envelope;try{envelope=JSON.parse(p.prompt)}catch{throw new DomainError('invalid_flow_output')}
      return{status:v.status,gate:{requestId:p.request_id,options},gatePlan:envelope.plan_json,sessionId}
    }
    return{status:v.status,output:object(v.output)&&v.output.reason==='single'&&typeof v.output.text==='string'?v.output.text:null,sessionId:v.session_id??null}
  }
  async resume(jobId:string,requestId:string,actionId:string,actorId:string,note:string){return resumeReviewJob(jobId,{request_id:requestId,action_id:actionId,actor:actorId,reviewer_note:note},{fetchImpl:this.options.fetchImpl})}
}
