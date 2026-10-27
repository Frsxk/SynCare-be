import {DomainError} from '../contracts/errors.ts'
import type {EmergencyGuidance} from '../alerts/guidance.ts'
export const F5_REFUSAL='Maaf, pertanyaan itu di luar cakupan rencana Anda. Silakan tanyakan ke perawat Anda atau hubungi hotline.'
export const F5_DISCLAIMER='Jawaban demo sintetis berdasarkan rencana tindak lanjut yang telah disetujui melalui alur kerja sintetis (bukan persetujuan klinis) dan draf edukasi yang belum disetujui; bukan nasihat medis.'
export interface Citation {id:string;label:string;provenance:'approved_plan'|'unapproved_education';quote:string}
export type AnswerOutcome={kind:'answer';text:string;citations:Citation[];disclaimer:string}|{kind:'refusal';text:string}|{kind:'emergency';reason:string;guidance:EmergencyGuidance|null}|{kind:'error';code:'retrieval_failed'|'invalid_generated_selection'|'invalid_flow_output'}
const invalid=():never=>{throw new DomainError('invalid_flow_output')}
export function normalizeAnswer(raw:unknown,patientId:string):AnswerOutcome{
  if(typeof raw!=='string'||!raw.trim()||raw.length>100000)return invalid()
  if(raw===F5_REFUSAL)return{kind:'refusal',text:raw}
  if(/^[\s]*[\[{]/.test(raw)){
    let v;try{v=JSON.parse(raw)}catch{return invalid()}
    if(!v||typeof v!=='object'||Array.isArray(v))return invalid()
    if(v.action==='escalate_immediately'&&Object.keys(v).every(k=>['action','reason'].includes(k))&&typeof v.reason==='string'&&v.reason.trim()&&v.reason.length<=2000)return{kind:'emergency',reason:v.reason,guidance:null}
    if((v.kind==='error'||v.ok===false)&&['retrieval_failed','invalid_generated_selection','invalid_query_json'].includes(v.error))return{kind:'error',code:v.error==='invalid_query_json'?'invalid_flow_output':v.error}
    return invalid()
  }
  if(!raw.startsWith(F5_DISCLAIMER+' '))return invalid()
  const citations:Citation[]=[];let end=F5_DISCLAIMER.length
  for(const match of raw.matchAll(/\[([^\[\]\r\n]+)\]/g)){
    const parts=match[1]!.split(' | '),id=parts[0],label=parts[1],quote=raw.slice(end,match.index).trim()
    if(parts.length!==2||!id||id.length>512||!quote||/[\[\]]/.test(quote))return invalid()
    let provenance:Citation['provenance']
    if(label==='rencana_disetujui_workflow_sintetis'&&id.startsWith(`${patientId}:`)&&/^(?:plan_text|instruction:\d+|medication:\d+|care_intensity:\d+)#[1-9]\d*$/.test(id.slice(patientId.length+1)))provenance='approved_plan'
    else if(label==='draf_edukasi_tidak_disetujui'&&/^(?:hf-aftercare|medication-safety):section:\d+#[1-9]\d*$/.test(id))provenance='unapproved_education'
    else return invalid()
    citations.push({id,label,provenance,quote});end=match.index+match[0].length
  }
  if(!citations.length||citations.length>100||raw.slice(end).trim())return invalid()
  return{kind:'answer',text:raw,citations,disclaimer:F5_DISCLAIMER}
}
