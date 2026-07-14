import { TaskId, type ThreadId } from "@t3tools/contracts";

/** Stable parent task id for threads created before the task model existed. */
export function legacyTaskIdForThread(threadId: ThreadId): TaskId {
  return TaskId.make(`legacy-${threadId}`);
}
