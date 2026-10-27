import type { AuthService } from '../auth/service.ts'
import type { RequestContext } from '../contracts/errors.ts'
import { readReview } from './registry.ts'
import { terminal,type ReviewSnapshot } from './contracts.ts'
import type { Store } from '../../storage/database.ts'
export function reviewStream(store:Store,auth:AuthService,token:string,ctx:RequestContext,id:string,request:Request){
  const current=readReview(store,ctx,id),cursor=request.headers.get('last-event-id'),match=cursor?.match(/^([\w-]+):(\d+)$/)
  let version=match?.[1]===id&&Number(match[2])<=current.version?Number(match[2]):0,closed=false
  const encoder=new TextEncoder(),expires=Date.now()+55000
  const stream=new ReadableStream<Uint8Array>({
    async start(controller){
      const emit=(value:ReviewSnapshot,event='snapshot')=>controller.enqueue(encoder.encode(`id: ${id}:${value.version}\nevent: ${event}\ndata: ${JSON.stringify(value)}\n\n`))
      try{
        while(!closed&&!request.signal.aborted&&Date.now()<expires){
          await auth.getSession(token);const next=readReview(store,ctx,id)
          const events=store.all<{snapshot_json:string;kind:string}>('SELECT snapshot_json,kind FROM review_events WHERE review_id=? AND version>? ORDER BY version LIMIT 101',[id,version])
          if(!version||events.length>100){emit(next);version=next.version}
          else for(const event of events){const value=JSON.parse(event.snapshot_json) as ReviewSnapshot;if(value.version>version){emit(value,event.kind);version=value.version}}
          if(terminal(next.state))break
          controller.enqueue(encoder.encode(': heartbeat\n\n'));await new Promise(resolve=>setTimeout(resolve,1000))
        }
      }catch{if(!closed)controller.enqueue(encoder.encode('event: error\ndata: {"code":"session_or_scope_unavailable"}\n\n'))}
      finally{if(!closed){closed=true;controller.close()}}
    },cancel(){closed=true},
  })
  return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'private, no-store, no-transform','X-Accel-Buffering':'no'}})
}
