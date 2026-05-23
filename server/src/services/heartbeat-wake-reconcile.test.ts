import { describe, expect, it, vi } from "vitest";
import { buildPaperclipWakePayload } from "./heartbeat.js";

type SelectRow = Record<string, unknown>;
type SelectResult = { from: (table?: unknown) => { where: (...args: unknown[]) => { orderBy?: (...args: unknown[]) => { limit?: (n: number) => { then: (cb: (rows: SelectRow[]) => unknown) => Promise<unknown> } }; then: (cb: (rows: SelectRow[]) => unknown) => Promise<unknown> } } };

describe("buildPaperclipWakePayload reconciliation", () => {
  it("discovers comments that landed between enqueue and dispatch when wakeCommentIds is empty", async () => {
    // wakeCommentIds is empty (continuation-recovery wake)
    // but a comment exists in the DB for this issue
    const contextSnapshot: Record<string, unknown> = {
      wakeReason: "issue_continuation_needed",
      issueId: "issue-1",
      wakeCommentIds: [],
    };

    let selectCall = 0;
    const db: any = {
      select: vi.fn(() => {
        selectCall += 1;
        // Call 1: reconciliation — find latest comment cutoff (skipped since commentIds empty)
        // Call 1: reconciliation — SELECT id FROM issue_comments WHERE ... ORDER BY ... LIMIT 25
        // Call 2: issue summary lookup
        // Call 3: comment rows lookup
        switch (selectCall) {
          case 1: {
            // reconciliation: find new comments
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () => ({
                      then: (cb: (rows: SelectRow[]) => unknown) =>
                        Promise.resolve(
                          cb([
                            {
                              id: "comment-new-1",
                              createdAt: new Date("2026-05-20T12:00:00Z"),
                            },
                          ]),
                        ),
                    }),
                  }),
                }),
              }),
            };
          }
          case 2: {
            // issue summary
            return {
              from: () => ({
                where: () => ({
                  then: (cb: (rows: SelectRow[]) => unknown) =>
                    Promise.resolve(
                      cb([
                        {
                          id: "issue-1",
                          identifier: "CUL-268",
                          title: "Test issue",
                          status: "todo",
                          priority: "high",
                          workMode: "autonomous",
                        },
                      ]),
                    ),
                }),
              }),
            };
          }
          case 3: {
            // comment rows (now includes reconciled comment)
            return {
              from: () => ({
                where: () => ({
                  then: (cb: (rows: SelectRow[]) => unknown) =>
                    Promise.resolve(
                      cb([
                        {
                          id: "comment-new-1",
                          issueId: "issue-1",
                          body: "CEO comment that should be visible",
                          authorType: "agent",
                          authorAgentId: "agent-ceo",
                          authorUserId: null,
                          presentation: null,
                          metadata: null,
                          createdAt: new Date("2026-05-20T12:00:00Z"),
                        },
                      ]),
                    ),
                }),
              }),
            };
          }
          default:
            throw new Error(`Unexpected select call ${selectCall}`);
        }
      }),
    };

    const payload = await buildPaperclipWakePayload({
      db,
      companyId: "company-1",
      contextSnapshot,
      continuationSummary: null,
      issueSummary: null,
    });

    expect(payload).not.toBeNull();
    expect(payload!.commentWindow.requestedCount).toBe(1);
    expect(payload!.commentWindow.includedCount).toBe(1);
    expect(payload!.commentWindow.missingCount).toBe(0);
    expect(payload!.comments.length).toBe(1);
    expect(payload!.comments[0].body).toBe(
      "CEO comment that should be visible",
    );
  });

  it("discovers comments newer than the latest snapshotted comment", async () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeReason: "issue_continuation_needed",
      issueId: "issue-1",
      wakeCommentIds: ["comment-old-1"],
    };

    let selectCall = 0;
    const db: any = {
      select: vi.fn(() => {
        selectCall += 1;
        switch (selectCall) {
          case 1: {
            // reconciliation: find latest comment's createdAt for cutoff
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () => ({
                      then: (cb: (rows: SelectRow[]) => unknown) =>
                        Promise.resolve(
                          cb([
                            {
                              createdAt: new Date(
                                "2026-05-20T10:00:00Z",
                              ),
                            },
                          ]),
                        ),
                    }),
                  }),
                }),
              }),
            };
          }
          case 2: {
            // reconciliation: find comments newer than cutoff
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () => ({
                      then: (cb: (rows: SelectRow[]) => unknown) =>
                        Promise.resolve(
                          cb([
                            {
                              id: "comment-new-2",
                              createdAt: new Date(
                                "2026-05-20T11:00:00Z",
                              ),
                            },
                          ]),
                        ),
                    }),
                  }),
                }),
              }),
            };
          }
          case 3: {
            // issue summary
            return {
              from: () => ({
                where: () => ({
                  then: (cb: (rows: SelectRow[]) => unknown) =>
                    Promise.resolve(
                      cb([
                        {
                          id: "issue-1",
                          identifier: "CUL-268",
                          title: "Test issue",
                          status: "todo",
                          priority: "high",
                          workMode: "autonomous",
                        },
                      ]),
                    ),
                }),
              }),
            };
          }
          case 4: {
            // comment rows (old + new)
            return {
              from: () => ({
                where: () => ({
                  then: (cb: (rows: SelectRow[]) => unknown) =>
                    Promise.resolve(
                      cb([
                        {
                          id: "comment-old-1",
                          issueId: "issue-1",
                          body: "Original comment",
                          authorType: "agent",
                          authorAgentId: "agent-cto",
                          authorUserId: null,
                          presentation: null,
                          metadata: null,
                          createdAt: new Date(
                            "2026-05-20T10:00:00Z",
                          ),
                        },
                        {
                          id: "comment-new-2",
                          issueId: "issue-1",
                          body: "Late-arriving comment",
                          authorType: "agent",
                          authorAgentId: "agent-ceo",
                          authorUserId: null,
                          presentation: null,
                          metadata: null,
                          createdAt: new Date(
                            "2026-05-20T11:00:00Z",
                          ),
                        },
                      ]),
                    ),
                }),
              }),
            };
          }
          default:
            throw new Error(`Unexpected select call ${selectCall}`);
        }
      }),
    };

    const payload = await buildPaperclipWakePayload({
      db,
      companyId: "company-1",
      contextSnapshot,
      continuationSummary: null,
      issueSummary: null,
    });

    expect(payload).not.toBeNull();
    expect(payload!.commentWindow.requestedCount).toBe(2);
    expect(payload!.commentWindow.includedCount).toBe(2);
    expect(payload!.commentWindow.missingCount).toBe(0);
    expect(payload!.comments.length).toBe(2);
    // The late-arriving comment should be present
    expect(payload!.comments.some((c) => c.body === "Late-arriving comment")).toBe(true);
  });

  it("preserves existing commentIds when no new comments exist", async () => {
    const contextSnapshot: Record<string, unknown> = {
      wakeReason: "issue_continuation_needed",
      issueId: "issue-1",
      wakeCommentIds: ["comment-existing-1"],
    };

    let selectCall = 0;
    const db: any = {
      select: vi.fn(() => {
        selectCall += 1;
        switch (selectCall) {
          case 1: {
            // reconciliation: find latest comment's createdAt
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () => ({
                      then: (cb: (rows: SelectRow[]) => unknown) =>
                        Promise.resolve(
                          cb([
                            {
                              createdAt: new Date(
                                "2026-05-20T10:00:00Z",
                              ),
                            },
                          ]),
                        ),
                    }),
                  }),
                }),
              }),
            };
          }
          case 2: {
            // reconciliation: find newer comments — none exist
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: () => ({
                      then: (cb: (rows: SelectRow[]) => unknown) =>
                        Promise.resolve(cb([])),
                    }),
                  }),
                }),
              }),
            };
          }
          case 3: {
            // issue summary
            return {
              from: () => ({
                where: () => ({
                  then: (cb: (rows: SelectRow[]) => unknown) =>
                    Promise.resolve(
                      cb([
                        {
                          id: "issue-1",
                          identifier: "CUL-268",
                          title: "Test issue",
                          status: "todo",
                          priority: "high",
                          workMode: "autonomous",
                        },
                      ]),
                    ),
                }),
              }),
            };
          }
          case 4: {
            // comment rows
            return {
              from: () => ({
                where: () => ({
                  then: (cb: (rows: SelectRow[]) => unknown) =>
                    Promise.resolve(
                      cb([
                        {
                          id: "comment-existing-1",
                          issueId: "issue-1",
                          body: "Existing comment",
                          authorType: "agent",
                          authorAgentId: "agent-cto",
                          authorUserId: null,
                          presentation: null,
                          metadata: null,
                          createdAt: new Date(
                            "2026-05-20T10:00:00Z",
                          ),
                        },
                      ]),
                    ),
                }),
              }),
            };
          }
          default:
            throw new Error(`Unexpected select call ${selectCall}`);
        }
      }),
    };

    const payload = await buildPaperclipWakePayload({
      db,
      companyId: "company-1",
      contextSnapshot,
      continuationSummary: null,
      issueSummary: null,
    });

    expect(payload).not.toBeNull();
    expect(payload!.commentWindow.requestedCount).toBe(1);
    expect(payload!.commentWindow.includedCount).toBe(1);
    expect(payload!.commentWindow.missingCount).toBe(0);
    expect(payload!.fallbackFetchNeeded).toBe(false);
  });

  it("respects PAPERCLIP_WAKE_RECONCILE_COMMENTS=0 kill switch", async () => {
    const prev = process.env["PAPERCLIP_WAKE_RECONCILE_COMMENTS"];
    process.env["PAPERCLIP_WAKE_RECONCILE_COMMENTS"] = "0";

    try {
      const contextSnapshot: Record<string, unknown> = {
        wakeReason: "issue_continuation_needed",
        issueId: "issue-1",
        wakeCommentIds: [],
      };

      let selectCall = 0;
      const db: any = {
        select: vi.fn(() => {
          selectCall += 1;
          switch (selectCall) {
            case 1: {
              // issue summary (skips reconciliation because kill switch)
              return {
                from: () => ({
                  where: () => ({
                    then: (cb: (rows: SelectRow[]) => unknown) =>
                      Promise.resolve(
                        cb([
                          {
                            id: "issue-1",
                            identifier: "CUL-268",
                            title: "Test issue",
                            status: "todo",
                            priority: "high",
                            workMode: "autonomous",
                          },
                        ]),
                      ),
                  }),
                }),
              };
            }
            case 2: {
              // comment rows — empty because reconciliation was skipped
              return {
                from: () => ({
                  where: () => ({
                    then: (cb: (rows: SelectRow[]) => unknown) =>
                      Promise.resolve(cb([])),
                  }),
                }),
              };
            }
            default:
              throw new Error(`Unexpected select call ${selectCall}`);
          }
        }),
      };

      const payload = await buildPaperclipWakePayload({
        db,
        companyId: "company-1",
        contextSnapshot,
        continuationSummary: null,
        issueSummary: null,
      });

      expect(payload).not.toBeNull();
      expect(payload!.commentWindow.requestedCount).toBe(0);
      expect(payload!.commentWindow.includedCount).toBe(0);
    } finally {
      if (prev === undefined) {
        delete process.env["PAPERCLIP_WAKE_RECONCILE_COMMENTS"];
      } else {
        process.env["PAPERCLIP_WAKE_RECONCILE_COMMENTS"] = prev;
      }
    }
  });
});
