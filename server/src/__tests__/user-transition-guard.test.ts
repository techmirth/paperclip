import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { isRecoverySuppressedByRecentUserTransition } from "../services/recovery/user-transition-guard.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const COMPANY_ID = randomUUID();
const ISSUE_ID = randomUUID();
const ISSUE_ID_2 = randomUUID();

describeEmbeddedPostgres("user-transition-guard", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("user-transition-guard-");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);

    await db.insert(companies).values({
      id: COMPANY_ID,
      name: "Test Company",
      status: "active",
      issuePrefix: "TST",
      issueCounter: 0,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      attachmentMaxBytes: 10 * 1024 * 1024,
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await stopDb?.();
  });

  afterEach(async () => {
    await db.delete(activityLog);
  });

  async function insertActivityLog(
    overrides: Partial<typeof activityLog.$inferInsert> = {},
  ) {
    const now = new Date();
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "user-1",
      action: "issue.update",
      entityType: "issue",
      entityId: ISSUE_ID,
      details: {},
      createdAt: now,
      ...overrides,
    });
  }

  it("returns false when no activity log entries exist", async () => {
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });

  it("returns false when activity log entries are from the system, not user", async () => {
    await insertActivityLog({
      actorType: "system",
      details: { previousStatus: "blocked", status: "in_progress" },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });

  it("returns true when user moved issue from blocked to another status", async () => {
    await insertActivityLog({
      details: { previousStatus: "blocked", status: "in_progress" },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(true);
  });

  it("returns true when user moved issue from blocked to todo", async () => {
    await insertActivityLog({
      details: { previousStatus: "blocked", status: "todo" },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(true);
  });

  it("returns false when user moved issue between non-blocked statuses", async () => {
    await insertActivityLog({
      details: { previousStatus: "todo", status: "in_progress" },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });

  it("returns true when user cleared all blocker IDs", async () => {
    await insertActivityLog({
      details: {
        previousStatus: "blocked",
        status: "blocked",
        previousBlockedByIssueIds: ["blocker-1", "blocker-2"],
        blockedByIssueIds: [],
      },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(true);
  });

  it("returns true when user reduced blocker IDs", async () => {
    await insertActivityLog({
      details: {
        previousStatus: "blocked",
        status: "blocked",
        previousBlockedByIssueIds: ["blocker-1", "blocker-2", "blocker-3"],
        blockedByIssueIds: ["blocker-1"],
      },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(true);
  });

  it("returns false when blocker IDs remain the same", async () => {
    await insertActivityLog({
      details: {
        previousStatus: "blocked",
        status: "blocked",
        previousBlockedByIssueIds: ["blocker-1", "blocker-2"],
        blockedByIssueIds: ["blocker-1", "blocker-2"],
      },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });

  it("returns true when user transitions to in_progress with blockers cleared", async () => {
    await insertActivityLog({
      details: {
        previousStatus: "blocked",
        status: "in_progress",
        previousBlockedByIssueIds: ["blocker-1"],
        blockedByIssueIds: [],
      },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(true);
  });

  it("ignores activity log entries older than the debounce window", async () => {
    const oldDate = new Date(Date.now() - 11 * 60 * 1000); // 11 minutes ago (window is 10 min)
    await insertActivityLog({
      createdAt: oldDate,
      details: { previousStatus: "blocked", status: "in_progress" },
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });

  it("returns false for a different issue's activity", async () => {
    const now = new Date();
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "user-1",
      action: "issue.update",
      entityType: "issue",
      entityId: ISSUE_ID_2, // different issue
      details: { previousStatus: "blocked", status: "in_progress" },
      createdAt: now,
    });
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });

  it("checks the most recent log entries first, skipping system entries", async () => {
    // Old entry: user moved to blocked
    const oldDate = new Date(Date.now() - 2 * 60 * 1000);
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId: COMPANY_ID,
      actorType: "user",
      actorId: "user-1",
      action: "issue.update",
      entityType: "issue",
      entityId: ISSUE_ID,
      details: { previousStatus: "in_progress", status: "blocked" },
      createdAt: oldDate,
    });

    // Newer entry: a system actor
    const recentDate = new Date(Date.now() - 1 * 60 * 1000);
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId: COMPANY_ID,
      actorType: "system",
      actorId: "system",
      action: "issue.update",
      entityType: "issue",
      entityId: ISSUE_ID,
      details: { previousStatus: "in_progress", status: "blocked" },
      createdAt: recentDate,
    });

    // The recent entry is system (skipped), but the user entry moved to blocked, not away from it
    const result = await isRecoverySuppressedByRecentUserTransition(db, COMPANY_ID, ISSUE_ID);
    expect(result).toBe(false);
  });
});
