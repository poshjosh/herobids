/**
 * BullMQ queue name for manual (user-triggered) platform assessment review jobs.
 */
export const MANUAL_REVIEW_QUEUE_NAME = 'agent-platform-assessment-reviews';

/**
 * Job data contract shared by the API (enqueue) and worker (consume).
 *
 * The API creates a run row and enqueues this job; the worker picks it up,
 * executes the shared review runner with force:true, and persists the result.
 */
export interface ManualReviewJobData {
  runId: string;
  agentId: string;
  requestedByUserId: string;
}
