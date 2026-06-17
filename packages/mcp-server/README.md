# Paperclip MCP Server

Model Context Protocol server for Paperclip.

This package is a thin MCP wrapper over the existing Paperclip REST API. It does
not talk to the database directly and it does not reimplement business logic.

## Transports

This package ships two transports over the same tool surface:

- **stdio** (`paperclip-mcp-server`) — for local CLI / desktop MCP clients that
  spawn the server as a child process.
- **Streamable HTTP** (`paperclip-mcp-http-server`) — a network-reachable
  endpoint that remote MCP clients (e.g. Claude / Cowork custom connectors) add
  as a connector. This is the transport to use when the client runs in an
  isolated sandbox that cannot reach `localhost`.

## Authentication

### stdio

The stdio server reads its configuration from environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL, for example `http://localhost:3100`
- `PAPERCLIP_API_KEY` - bearer token used for `/api` requests
- `PAPERCLIP_COMPANY_ID` - optional default company for company-scoped tools
- `PAPERCLIP_AGENT_ID` - optional default agent for checkout helpers
- `PAPERCLIP_RUN_ID` - optional run id forwarded on mutating requests

### Streamable HTTP

The HTTP server does **not** read a single shared `PAPERCLIP_API_KEY`. Instead,
each request must carry its own `Authorization: Bearer <token>` header, and that
token is used as the Paperclip API key for every REST call made while handling
the request. This means:

- Authorization is enforced by Paperclip's existing identity model on every tool
  call — no token store is reimplemented here.
- Each connector authenticates as its own actor (e.g. a `cowork-strategist`
  agent key or a board key) so mutations attribute cleanly in the audit log.
- Agent API keys are already company-scoped server-side, so a connection cannot
  cross company boundaries. `PAPERCLIP_COMPANY_ID` additionally pins the default
  company for company-scoped tools.

HTTP server environment variables:

- `PAPERCLIP_API_URL` - Paperclip base URL (required)
- `PAPERCLIP_COMPANY_ID` - company pinned for company-scoped tools (recommended)
- `PAPERCLIP_AGENT_ID` / `PAPERCLIP_RUN_ID` - optional defaults
- `PAPERCLIP_MCP_HTTP_HOST` - bind address (default `127.0.0.1`)
- `PAPERCLIP_MCP_HTTP_PORT` - bind port (default `3110`)
- `PAPERCLIP_MCP_HTTP_PATH` - request path (default `/mcp`)

> **TLS is required in front of this server.** It speaks plain HTTP and must be
> fronted by an HTTPS terminator — Tailscale Funnel/Serve or a reverse proxy —
> before it is reachable off-LAN. Never expose it without HTTPS.

The HTTP transport is **stateless**: each POST is handled with a fresh MCP
server and transport (`sessionIdGenerator: undefined`), so no state leaks
between connections. `GET`/`DELETE` on the MCP path return `405` since
server-initiated SSE streams and session teardown are not used.

## Usage

### stdio

```sh
npx -y @paperclipai/mcp-server
```

Or locally in this repo:

```sh
pnpm --filter @paperclipai/mcp-server build
node packages/mcp-server/dist/stdio.js
```

### Streamable HTTP

```sh
PAPERCLIP_API_URL=http://localhost:3100 \
PAPERCLIP_COMPANY_ID=<companyId> \
node packages/mcp-server/dist/http-cli.js
```

Then expose it over HTTPS, for example with Tailscale Funnel:

```sh
tailscale funnel 3110
```

Point the remote MCP client's custom connector at the resulting HTTPS URL plus
the configured path (default `/mcp`), authenticating with a Paperclip API key as
`Authorization: Bearer <token>`.

## Tool Surface

Read tools:

- `paperclipMe`
- `paperclipInboxLite`
- `paperclipListAgents`
- `paperclipGetAgent`
- `paperclipListIssues`
- `paperclipGetIssue`
- `paperclipGetHeartbeatContext`
- `paperclipListComments`
- `paperclipGetComment`
- `paperclipListIssueApprovals`
- `paperclipListDocuments`
- `paperclipGetDocument`
- `paperclipListDocumentRevisions`
- `paperclipListProjects`
- `paperclipGetProject`
- `paperclipGetIssueWorkspaceRuntime`
- `paperclipWaitForIssueWorkspaceService`
- `paperclipListGoals`
- `paperclipGetGoal`
- `paperclipListApprovals`
- `paperclipGetApproval`
- `paperclipGetApprovalIssues`
- `paperclipListApprovalComments`

Write tools:

- `paperclipCreateIssue`
- `paperclipUpdateIssue`
- `paperclipCheckoutIssue`
- `paperclipReleaseIssue`
- `paperclipAddComment`
- `paperclipSuggestTasks`
- `paperclipAskUserQuestions`
- `paperclipRequestConfirmation`
- `paperclipUpsertIssueDocument`
- `paperclipRestoreIssueDocumentRevision`
- `paperclipControlIssueWorkspaceServices`
- `paperclipCreateApproval`
- `paperclipLinkIssueApproval`
- `paperclipUnlinkIssueApproval`
- `paperclipApprovalDecision`
- `paperclipAddApprovalComment`

Escape hatch:

- `paperclipApiRequest`

`paperclipApiRequest` is limited to paths under `/api` and JSON bodies. It is
meant for endpoints that do not yet have a dedicated MCP tool.
