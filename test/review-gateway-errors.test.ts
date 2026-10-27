import {test,expect} from 'bun:test'
import {LangflowReviewGateway} from '../src/modules/reviews/gateway.ts'
const gateway=(status:number,detail:unknown)=>new LangflowReviewGateway({baseUrl:'http://127.0.0.1:7861',apiKey:'synthetic-fixture',flowId:'flow-a',f5FlowId:'flow-f5',reviewDbPath:'unused',fetchImpl:(async()=>Response.json({detail},{status})) as unknown as typeof fetch})

test('correlated explicit engine input deadline and execution timeout normalize to timed_out',async()=>{
 expect((await gateway(500,{code:'JOB_FAILED',job_id:'job-a',error_detail:{type:'input_timed_out'}}).snapshot('job-a','session-a')).status).toBe('timed_out')
 expect((await gateway(408,{code:'EXECUTION_TIMEOUT',job_id:'job-a',flow_id:'flow-a'}).snapshot('job-a','session-a')).status).toBe('timed_out')
})
test('ordinary correlated job failure stays failed, never expired or approved',async()=>{
 expect((await gateway(500,{code:'JOB_FAILED',job_id:'job-a',error_detail:{type:'synthetic_processing_error'}}).snapshot('job-a','session-a')).status).toBe('failed')
})
test('foreign, malformed and generic transport errors cannot fabricate a terminal job result',async()=>{
 for(const [status,detail]of[[500,{code:'JOB_FAILED',job_id:'foreign',error_detail:{type:'input_timed_out'}}],[408,{code:'EXECUTION_TIMEOUT',job_id:'job-a',flow_id:'foreign'}],[500,{code:'JOB_FAILED',job_id:'job-a',session_id:'foreign',error_detail:{type:'input_timed_out'}}],[503,{code:'dependency_unavailable'}],[500,{code:'INTERNAL_SERVER_ERROR',job_id:'job-a'}]] as const){
  await expect(gateway(status,detail).snapshot('job-a','session-a')).rejects.toMatchObject({code:'dependency_unavailable'})
 }
 await expect(gateway(404,{code:'JOB_NOT_FOUND',job_id:'job-a'}).snapshot('job-a','session-a')).rejects.toMatchObject({code:'outcome_unknown'})
})
