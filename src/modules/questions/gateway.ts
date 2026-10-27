import {createHash} from 'node:crypto'
import {readFileSync,realpathSync} from 'node:fs'
import {resolve} from 'node:path'
import {DomainError} from '../contracts/errors.ts'
export class QuestionGateway {
  constructor(private readonly options:{baseUrl:string;apiKey:string;flowId:string;reviewDbPath:string}){}
  async verify(){
    try{
      const binding=JSON.parse(readFileSync(new URL('../../../config/f5-runtime.demo.json',import.meta.url),'utf8')) as {folderId:string;edgesSha256:string;components:Record<string,string>}
      const response=await fetch(`${this.options.baseUrl.replace(/\/$/,'')}/api/v1/flows/${encodeURIComponent(this.options.flowId)}`,{headers:{'x-api-key':this.options.apiKey},signal:AbortSignal.timeout(10000),redirect:'error'})
      if(!response.ok)throw Error('definition_unavailable')
      const flow=await response.json() as Record<string,any>
      if(flow.id!==this.options.flowId||flow.folder_id!==binding.folderId||!Array.isArray(flow.data?.nodes))throw Error('identity_mismatch')
      if(createHash('sha256').update(JSON.stringify(flow.data.edges)).digest('hex')!==binding.edgesSha256)throw Error('graph_drift')
      for(const [id,hash] of Object.entries(binding.components)){
        const matches=flow.data.nodes.filter((n:any)=>n.id===id),code=matches[0]?.data?.node?.template?.code?.value
        if(matches.length!==1||typeof code!=='string'||createHash('sha256').update(code).digest('hex')!==hash)throw Error('source_drift')
      }
      const paths=flow.data.nodes.flatMap((n:any)=>typeof n.data?.node?.template?.db_path?.value==='string'?[n.data.node.template.db_path.value]:[])
      const physical=(p:string)=>{let value;try{value=realpathSync.native(resolve(p))}catch{value=resolve(p)}return process.platform==='win32'?value.toLowerCase():value}
      if(paths.length!==1||physical(paths[0])!==physical(this.options.reviewDbPath))throw Error('canonical_path_mismatch')
    }catch{throw new DomainError('dependency_unavailable')}
  }
}
