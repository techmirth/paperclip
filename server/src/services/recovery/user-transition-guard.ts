import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";

const STRANDED_ISSUE_MANUAL_OVERRIDE_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * If a board operator (user) recently transitioned this issue away from
 * "blocked" or cleared its `blockedByIssueIds`, suppress automatic recovery
 * for the debounce window so the manual override is authoritative.
 *
 * Detection: query `activity_log` for the most recent `issue.update` event
 * by a human actor that changed `status` away from `blocked` and/or removed
 * `blockedByIssueIds` values.
 */
export async function isRecoverySuppressedByRecentUserTransition(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - STRANDED_ISSUE_MANUAL_OVERRIDE_DEBOUNCE_MS);

  const recentUpdates = await db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.update"),
        gt(activityLog.createdAt, since),
        isNotNull(activityLog.details),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(5);

  for (const entry of recentUpdates) {
    // Only human-triggered updates qualify (board user or user actor)
    if (entry.actorType !== "user") continue;

    const details = entry.details as Record<string, unknown> | null;
    if (!details) continue;

    const prevStatus = details.previousStatus as string | undefined;
    const newStatus = details.status as string | undefined;
    const prevBlockers = details.previousBlockedByIssueIds as string[] | undefined;
    const newBlockers = details.blockedByIssueIds as string[] | undefined;

    // User moved this issue OUT of "blocked" — that's a manual override
    if (prevStatus === "blocked" && newStatus && newStatus !== "blocked") {
      return true;
    }

    // User cleared blocker IDs (reduced the set)
    if (
      prevBlockers &&
      prevBlockers.length > 0 &&
      (!newBlockers || newBlockers.length === 0 || newBlockers.length < prevBlockers.length)
    ) {
      return true;
    }

    // User specifically cleared blockedByIssueIds to empty
    if (prevBlockers && prevBlockers.length > 0 && (newStatus === "in_progress" || newStatus === "todo")) {
      return true;
    }
  }

  return false;
}
