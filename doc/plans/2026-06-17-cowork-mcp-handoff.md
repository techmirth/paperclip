# Handoff Brief: Finish the Paperclip ↔ Cowork MCP Integration

> Date: 2026-06-17
> Audience: an agent picking up this work with repo access but no prior session context.

## End goal (why this exists)

We want **Claude in Cowork (the "strategist")** to connect to our **self-hosted Paperclip instance** as a custom MCP connector, so it can run a nightly ad-review loop: read state, write strategy guidance, create/assign tasks, and approve/escalate gated changes — while **Paperclip's own agents (the "operators")** execute the GA4 / Google Ads work behind budget + approval governance.

The hard constraint that shaped the design: **Cowork runs in an isolated sandbox that cannot reach `localhost`.** So Paperclip must expose its MCP server over a **network-reachable, authenticated HTTPS endpoint**, not stdio/loopback.

Division of labor:

- **Cowork (strategist):** reads state, writes strategy guidance, creates/assigns tasks, reviews work products, approves or escalates gated changes.
- **Paperclip agents (operators):** pull GA4 / Google Ads data, draft and apply campaign changes — gated behind approval for anything that spends money.
- **The board (human):** final sign-off on budget/spend changes.

## What's already done (do NOT redo)

PR **#2** is **merged to `master`** (squash commit `9cee3ac`). It added a **Streamable HTTP transport** to the existing `@paperclipai/mcp-server` package (a thin MCP wrapper over Paperclip's REST API). Specifically:

- New bin `paperclip-mcp-http-server` + `./http` export; entry files `packages/mcp-server/src/http.ts` and `http-cli.ts`.
- **Stateless per-request** handling (fresh MCP server + transport per POST).
- **Auth model (reuse this convention):** each request must carry `Authorization: Bearer <token>`. That token is used directly as the Paperclip API key for every REST call made while handling the request. Authorization is enforced by Paperclip's existing identity model per tool call, and mutations attribute to whatever actor the token belongs to. There is **no separate token store**.
- Config via env: `PAPERCLIP_API_URL` (required), `PAPERCLIP_COMPANY_ID` (pins the single company), `PAPERCLIP_MCP_HTTP_HOST`/`PORT`/`PATH` (defaults `127.0.0.1:3110/mcp`).
- Returns `401` (no bearer), `404` (off-path), `405` (non-POST), `400` (bad body), all as JSON-RPC errors.
- The server speaks **plain HTTP**; TLS must be terminated in front of it.
- README at `packages/mcp-server/README.md` documents all of this.

## Task 1 — Stand up and expose the endpoint (ops; do this first)

1. Run the HTTP server against our Paperclip instance:
   ```sh
   PAPERCLIP_API_URL=http://localhost:3100 \
   PAPERCLIP_COMPANY_ID=<Culture Match companyId> \
   node packages/mcp-server/dist/http-cli.js
   ```
   (Build first: `pnpm --filter @paperclipai/mcp-server build`. Note: in this monorepo, running compiled `dist` needs workspace deps built too — build `@paperclipai/shared` first, or run via the workspace `tsx` for a quick check.)
2. Expose it over HTTPS so the sandbox can reach it: `tailscale funnel 3110` → note the stable HTTPS URL. (Reverse proxy is an alternative.)
3. Create a dedicated **`cowork-strategist` agent** in Paperclip, company-scoped to Culture Match, and mint an **agent API key** for it. That key is the bearer token. Grant only the scopes Cowork needs; **withhold approval-write** if Cowork should recommend but never approve spend.
4. In Cowork, add a **custom connector** pointing at `https://<funnel-host>/mcp` with `Authorization: Bearer <that token>`. Verify by calling the `paperclipMe` (whoami) tool — it should resolve the `cowork-strategist` actor and company.

## Task 2 — Add the missing first-class MCP tools (code)

The spec names a set of tools. Most already exist in `packages/mcp-server/src/tools.ts`; a few don't and currently require the generic `paperclipApiRequest` escape hatch. Add proper tools for the gaps. The underlying REST routes already exist under `server/src/routes/` — wrap them, don't reimplement logic.

| Spec tool | Status | Action |
|---|---|---|
| `list_goals` / `list_projects` / `list_agents` / `list_issues` / `get_issue` | exists (`paperclipListGoals`, `…ListProjects`, `…ListAgents`, `…ListIssues`, `…GetIssue`) | none |
| `create_issue` / `comment_on_issue` / `set_issue_state` | exists (`paperclipCreateIssue`, `…AddComment`, `…UpdateIssue`) | none |
| `decide_approval` / `list_pending_approvals` | exists (`paperclipApprovalDecision`, `…ListApprovals`) | confirm `ListApprovals` can filter to pending; keep `ApprovalDecision` gated by approval-write scope |
| `whoami` | exists (`paperclipMe`) | none |
| `get_work_product` / `attach_work_product` | partial — maps to issue documents (`paperclipGetDocument`, `…UpsertIssueDocument`) | verify "work product" == document concept; if distinct, add tools |
| `list_cost_events` / `get_budgets` | gap | add tools wrapping `server/src/routes/costs.ts` (and agent/budget data in `agents.ts`) |
| `list_activity` | gap | add tool wrapping `server/src/routes/activity.ts` |
| `wake_agent` | gap | add tool wrapping `server/src/routes/issues-checkout-wakeup.ts` (heartbeat trigger) |
| `upsert_routine` | gap | add tool wrapping `server/src/routes/routines.ts` (cron, timezone, assignee, issue template, concurrency/catch-up policy) |

Follow the existing patterns in `tools.ts` (zod schema → `client.requestJson` → `formatTextResponse`/`formatErrorResponse`). Add unit tests in `tools.test.ts` mirroring the existing style (mock `fetch`, assert URL/method/headers/body). Update the tool list in `README.md`.

## Task 2b — Implement the nightly-loop data contract

The point of the read/write tools is a nightly review loop. Pin down **one stable JSON shape** for the ad-metrics work product so the Ads agent (producer) and Cowork (consumer) agree. Define/validate it in `packages/shared` (zod schema + exported type) so all layers share it, and have the `attach_work_product` / `get_work_product` tools carry it.

### The loop (1:00 AM America/New_York)

1. **Paperclip Routine fires** (`upsert_routine`, cron `0 1 * * *`, tz `America/New_York`, assigned to the Ads agent). The Ads agent: pulls GA4 + Google Ads, **publishes a metrics work product** (shape below), and opens/updates an issue labeled `awaiting-strategy` with `proposed_changes` — but **does not apply spend changes**.
2. **Cowork review pass** (~1:15 AM or on-demand): `list_issues(label="awaiting-strategy")` → `get_issue` / `get_work_product` → writes guidance via `comment_on_issue`, optionally generates creative and `attach_work_product`, then relabels `awaiting-strategy` → `ready-for-execution` (low-risk) or `awaiting-board-approval` (spend), and `wake_agent`.
3. **Execution under governance:** Ads agent applies `ready-for-execution` changes. Anything with `requires_approval: true` is held in the approvals queue until the board (or authorized Cowork) decides it.
4. **Delivery:** Cowork emails brian@surefoot.me / posts a morning brief: what changed, what's pending approval, generated creative.

> Schedule ownership: a Paperclip **Routine** owns the 1 AM tick (runs 24/7 even when Cowork is closed); the Cowork pass only runs after the data exists. Alternative: drop the Routine and have Cowork run nightly and call `create_issue` to brief the agent. Default to the Routine.

### Ad-metrics work-product JSON shape (the contract)

```json
{
  "period": { "start": "2026-06-16", "end": "2026-06-16", "timezone": "America/New_York" },
  "source": "google_ads",
  "account_id": "123-456-7890",
  "totals": { "spend": 0, "impressions": 0, "clicks": 0, "conversions": 0, "cpa": 0, "roas": 0 },
  "campaigns": [
    { "id": "", "name": "", "status": "ENABLED", "spend": 0, "clicks": 0,
      "conversions": 0, "cpa": 0, "ctr": 0, "budget_daily": 0, "notes": "" }
  ],
  "ga4": { "sessions": 0, "signups": 0, "paid_signups": 0, "conversion_rate": 0 },
  "proposed_changes": [
    { "type": "budget|copy|creative|targeting|pause",
      "campaign_id": "", "current": "", "proposed": "",
      "rationale": "", "requires_approval": true }
  ]
}
```

### Rules for the contract

- **`requires_approval: true` is the governance hook.** Any spend-affecting change (budget, new campaign, bid change over the threshold the board sets) MUST set it `true`, which routes the change through the approvals queue. The Ads agent must never apply such a change directly.
- `proposed_changes[].type` is one of `budget | copy | creative | targeting | pause`.
- Keep the shape **stable and versioned** — if you must evolve it, add a `schema_version` field rather than breaking consumers. Validate inbound/outbound against the zod schema so a malformed work product fails loudly instead of silently mis-driving the loop.
- Treat `proposed_changes` as advisory input to Cowork, not commands; Cowork decides what to push/cut/test and at what CPA targets, then sets labels accordingly.

## Task 3 (optional — confirm scope first) — OAuth connector

The spec's *preferred* auth is OAuth 2.0 authorization-code so Cowork connects with a "Connect" button and Paperclip mints a scoped token. The merged PR ships only the "minimum viable" bearer model. Implementing OAuth is a larger change to Paperclip's auth surface — **check with the user before starting**, as it may overlap planned core work (see `ROADMAP.md`, discuss in `#dev`).

## Token scopes

The bearer token (or future OAuth token) should carry: `read:org`, `read:work`, `write:work`, `read:costs`, `read:approvals`, `write:approvals`, `write:routines`. Keep `write:approvals` separable so it can be withheld if Cowork should recommend but never approve.

## Governance guardrails (non-negotiable for ad spend)

- Per-agent **monthly budget hard-stop** on the Ads agent (Paperclip supports this) — set it.
- Any change with `requires_approval: true` (budget edits, new campaigns, bid changes over a threshold) must sit in the approvals queue until a human — or explicitly-authorized Cowork — decides it.
- Every Cowork-originated mutation attributed to the `cowork-strategist` actor and recorded in the activity log.
- GA4 / Google Ads credentials stay in Paperclip's server-side secret store, injected only into the Ads agent's runs. Cowork never sees them.

## Repo rules you must follow

- **Branch:** develop on a feature branch, push with `git push -u origin <branch>`, open a **draft PR**. Do not push to `master`.
- **PR template:** `.github/PULL_REQUEST_TEMPLATE.md` is mandatory — fill in every section (Thinking Path, What Changed, Verification, Risks, Model Used, Checklist).
- **Read first:** `AGENTS.md`, `doc/SPEC-implementation.md`, `doc/DATABASE.md`.
- **Invariants:** keep everything **company-scoped**; enforce actor permissions (board vs agent); **write activity-log entries for mutations**; keep contracts synced across `packages/db` / `packages/shared` / `server` / `ui`.
- **Verify before hand-off:**
  ```sh
  pnpm --filter @paperclipai/mcp-server typecheck
  pnpm --filter @paperclipai/mcp-server test
  ```
  Run repo-wide `pnpm -r typecheck && pnpm test:run && pnpm build` if your change touches shared/server contracts.

## What the board still needs to hand over to wire the loop

1. MCP endpoint URL (HTTPS, network-reachable) + auth (bearer token, or OAuth client details).
2. `companyId` for Culture Match.
3. Agent identity/IDs for the GA4 / Google Ads operator agent(s), with confirmation they have Google Ads + GA4 access configured.
4. `projectId` and `goalId` the ad work should ladder up to (e.g. "grow Culture Match paying customers").
5. Approval policy: which change types require board sign-off, and whether Cowork may `decide_approval` on in-budget low-risk changes or must always escalate.
6. Daily budget cap for the Ads agent.
