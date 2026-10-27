import type { Store } from '../../storage/database.ts'
import type { FlowRunResult } from '../../plugins/langflow.ts'
import type { RequestContext } from '../contracts/errors.ts'
import { CursorCodec } from '../contracts/pagination.ts'
import { PlanService } from '../plans/service.ts'
import { ApprovedPlans } from '../plans/approved.ts'
import type { ReviewGateway } from './contracts.ts'
import { ApprovalEvidenceReader } from './approval-evidence.ts'
import { ReviewReconciler } from './reconciler.ts'
import { ReviewQueries } from './queries.ts'
import { startReview } from './start.ts'
import { decideReview } from './decision.ts'
export class ReviewService extends ReviewQueries {
  readonly plans:PlanService
  readonly approved:ApprovedPlans
  readonly reconciler:ReviewReconciler
  constructor(store:Store,private readonly options:{codec:CursorCodec;gateway:ReviewGateway;reviewDbPath:string;runF3:(input:string,sessionId:string)=>Promise<FlowRunResult>}){
    super(store,options.codec);this.plans=new PlanService(store,options.runF3)
    const evidence=new ApprovalEvidenceReader(options.reviewDbPath)
    this.approved=new ApprovedPlans(store,evidence,options.codec);this.reconciler=new ReviewReconciler(store,options.gateway,evidence)
  }
  start(ctx:RequestContext,draftId:string,input:unknown){return startReview(this.store,this.plans,this.options.gateway,ctx,draftId,input)}
  decide(ctx:RequestContext,id:string,input:unknown){return decideReview(this.store,this.options.gateway,ctx,id,input)}
}
