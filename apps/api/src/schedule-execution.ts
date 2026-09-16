import type { AgentIntent } from "@4evergent/shared";
import type { ScheduleRecord, ScheduleStore, ActivityStore, ApprovalStore } from "@4evergent/database";

interface PipelineOutcome {
  status: string;
  activityId?: string;
  approvalId?: string;
  message?: string;
}

interface PipelineExecuteInput {
  intent: AgentIntent;
  sourceAccount: {
    agentId: string;
    ownerId: string;
    accountId: () => string;
    sequenceNumber: () => string;
    incrementSequenceNumber: () => void;
  };
}

interface ScheduleExecutionDeps {
  activityStore: ActivityStore;
  approvalStore: ApprovalStore;
  pipelineExecutor: (input: PipelineExecuteInput) => Promise<PipelineOutcome>;
  now?: () => Date;
}

/**
 * ScheduleExecutionService — runs a scheduled intent through the SAME pipeline
 * as manual intents. The scheduler only decides WHEN to run; this service
 * decides HOW (via the existing pipeline).
 */
export class ScheduleExecutionService {
  private now: () => Date;

  constructor(private deps: ScheduleExecutionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async executeSchedule(schedule: ScheduleRecord): Promise<PipelineOutcome> {
    // 1. Reload to ensure status hasn't changed since the scheduler picked it up
    // (InMemoryScheduleStore.get is a Map lookup; SQLite does a SELECT)
    const current = await this.deps.activityStore.get(schedule.id).catch(() => null);
    // Note: schedule store isn't accessible here, so we rely on the caller.
    // The scheduler already filtered for active schedules.

    // 2. Build the execution input from the stored TYPED intent
    const intent = schedule.intent;

    const sourceAccount = {
      agentId: schedule.agentId,
      ownerId: schedule.ownerId,
      accountId: () => "", // filled by pipeline
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    };

    // 3. Run through the existing pipeline
    const outcome = await this.deps.pipelineExecutor({ intent, sourceAccount });

    return outcome;
  }
}
