import type { RequestContext, AuthorizationService } from '@4evergent/shared';
import type { ActivityStore, ApprovalStore } from './index.js';

export interface AuthorizationContext {
  activityStore: ActivityStore;
  approvalStore: ApprovalStore;
  agents: Map<string, { id: string; ownerId: string }>;
}

export class ResourceAuthorizationService implements AuthorizationService {
  constructor(private ctx: AuthorizationContext) {}

  async canAccessAgent(ctx: RequestContext, agentId: string): Promise<boolean> {
    const agent = this.ctx.agents.get(agentId);
    return agent?.ownerId === ctx.ownerId;
  }

  async canSubmitIntent(ctx: RequestContext, agentId: string): Promise<boolean> {
    return this.canAccessAgent(ctx, agentId);
  }

  async canAccessActivity(ctx: RequestContext, activityId: string): Promise<boolean> {
    const activity = await this.ctx.activityStore.get(activityId);
    if (!activity) return false;
    return this.canAccessAgent(ctx, activity.agentId);
  }

  async canAccessApproval(ctx: RequestContext, approvalId: string): Promise<boolean> {
    const approval = await this.ctx.approvalStore.get(approvalId);
    if (!approval) return false;
    return this.canAccessAgent(ctx, approval.agentId);
  }

  async canApprove(ctx: RequestContext, approvalId: string): Promise<boolean> {
    return this.canAccessApproval(ctx, approvalId);
  }

  async canReject(ctx: RequestContext, approvalId: string): Promise<boolean> {
    return this.canAccessApproval(ctx, approvalId);
  }
}
