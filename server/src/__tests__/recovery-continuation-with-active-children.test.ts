import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery-continuation-with-active-children tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery: continuation-recovery with active child/interaction paths (CUL-267)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-continuation-active-children-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(opts: { agentStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Continuation Recovery Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      role: "engineer",
      status: opts.agentStatus ?? "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, issuePrefix };
  }

  async function seedParentIssueWithProductiveSucceededRun(opts: {
    companyId: string;
    agentId: string;
    issuePrefix: string;
    issueNumber: number;
    now: Date;
  }) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const startedAt = new Date(opts.now.getTime() - 5 * 60 * 1000);
    // Productive succeeded run with `livenessState='advanced'` — without the
    // CUL-267 fix this is exactly the path that re-fires
    // `issue.productive_terminal_continuation_recovery` on every cycle.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: opts.companyId,
      agentId: opts.agentId,
      status: "succeeded",
      livenessState: "advanced",
      invocationSource: "assignment",
      triggerDetail: "system",
      startedAt,
      processStartedAt: startedAt,
      finishedAt: new Date(startedAt.getTime() + 60 * 1000),
      contextSnapshot: { issueId },
      logBytes: 0,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: opts.companyId,
      title: `Parent ${opts.issueNumber}`,
      status: "in_progress",
      priority: "high",
      assigneeAgentId: opts.agentId,
      issueNumber: opts.issueNumber,
      identifier: `${opts.issuePrefix}-${opts.issueNumber}`,
      checkoutRunId: runId,
      executionRunId: runId,
      startedAt,
      updatedAt: opts.now,
      createdAt: startedAt,
    });
    return { issueId, runId };
  }

  async function seedChildIssue(opts: {
    companyId: string;
    parentIssueId: string;
    assigneeAgentId: string | null;
    status: "todo" | "in_progress";
    issuePrefix: string;
    issueNumber: number;
  }) {
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId: opts.companyId,
      parentId: opts.parentIssueId,
      title: `Child ${opts.issueNumber}`,
      status: opts.status,
      priority: "high",
      assigneeAgentId: opts.assigneeAgentId,
      issueNumber: opts.issueNumber,
      identifier: `${opts.issuePrefix}-${opts.issueNumber}`,
    });
    return childId;
  }

  it("does NOT requeue continuation-recovery when an in_progress child shares the parent's assignee (CUL-226 -> CUL-230 repro)", async () => {
    const now = new Date("2026-05-11T01:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const { issueId: parentId } = await seedParentIssueWithProductiveSucceededRun({
      companyId,
      agentId,
      issuePrefix,
      issueNumber: 1,
      now,
    });
    await seedChildIssue({
      companyId,
      parentIssueId: parentId,
      assigneeAgentId: agentId, // same agent → delegated path
      status: "in_progress",
      issuePrefix,
      issueNumber: 2,
    });

    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.productiveContinuationObserved).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result.issueIds).not.toContain(parentId);
  });

  it("does NOT requeue continuation-recovery on an issue with its own pending `wake_assignee` interaction (CUL-267 self repro)", async () => {
    const now = new Date("2026-05-11T01:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const { issueId: parentId } = await seedParentIssueWithProductiveSucceededRun({
      companyId,
      agentId,
      issuePrefix,
      issueNumber: 1,
      now,
    });
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: parentId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve the change?" } as never,
    });

    const enqueueWakeup = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result.issueIds).not.toContain(parentId);
  });

  it("DOES fire continuation-recovery when the open child has a different uninvokable assignee with no live execution path (sanity: dead child does not suppress)", async () => {
    const now = new Date("2026-05-11T01:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Paused Worker",
      role: "engineer",
      status: "paused", // uninvokable
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const { issueId: parentId } = await seedParentIssueWithProductiveSucceededRun({
      companyId,
      agentId,
      issuePrefix,
      issueNumber: 1,
      now,
    });
    await seedChildIssue({
      companyId,
      parentIssueId: parentId,
      assigneeAgentId: otherAgentId, // different agent, paused → no delegated path
      status: "in_progress",
      issuePrefix,
      issueNumber: 2,
    });

    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    // The parent's productive succeeded run goes through the
    // `issue.productive_terminal_continuation_recovery` branch, NOT the
    // line-1789 fallback, so we look for any continuation wake regardless of
    // source.
    expect(result.issueIds).toContain(parentId);
    expect(enqueueWakeup).toHaveBeenCalled();
  });

  it("DOES fire continuation-recovery on a parent with no children and no pending interactions (baseline)", async () => {
    const now = new Date("2026-05-11T01:00:00.000Z");
    const { companyId, agentId, issuePrefix } = await seedCompanyAndAgent();
    const { issueId: parentId } = await seedParentIssueWithProductiveSucceededRun({
      companyId,
      agentId,
      issuePrefix,
      issueNumber: 1,
      now,
    });

    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID() });
    const recovery = recoveryService(db, { enqueueWakeup });
    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(parentId);
    expect(enqueueWakeup).toHaveBeenCalled();
  });
});
