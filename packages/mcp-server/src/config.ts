export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}

/**
 * Base configuration for the Streamable HTTP transport.
 *
 * Unlike {@link PaperclipMcpConfig}, this does not carry an `apiKey`: the HTTP
 * server derives the API key per request from the connecting client's
 * `Authorization: Bearer <token>` header, so each Cowork-style connector
 * authenticates with its own Paperclip identity (e.g. the `cowork-strategist`
 * agent or board key). `companyId` pins the single company a connection may
 * reach for company-scoped tools.
 */
export interface PaperclipHttpServerConfig {
  apiUrl: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  host: string;
  port: number;
  path: string;
}

const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3110;
const DEFAULT_HTTP_PATH = "/mcp";

function parsePort(value: string | undefined, fallback: number): number {
  const raw = nonEmpty(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PAPERCLIP_MCP_HTTP_PORT: ${value}`);
  }
  return parsed;
}

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = nonEmpty(value);
  if (!raw) return fallback;
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.length > 1
    ? stripTrailingSlash(withLeadingSlash)
    : withLeadingSlash;
}

export function readHttpServerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaperclipHttpServerConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
    host: nonEmpty(env.PAPERCLIP_MCP_HTTP_HOST) ?? DEFAULT_HTTP_HOST,
    port: parsePort(env.PAPERCLIP_MCP_HTTP_PORT, DEFAULT_HTTP_PORT),
    path: normalizePath(env.PAPERCLIP_MCP_HTTP_PATH, DEFAULT_HTTP_PATH),
  };
}

/**
 * Build a per-request MCP config from the HTTP base config plus the bearer
 * token supplied by the connecting client. The token becomes the API key used
 * for all REST calls made while handling that request, so authorization is
 * enforced by Paperclip's existing identity model on every tool call.
 */
export function buildRequestConfig(
  base: PaperclipHttpServerConfig,
  apiKey: string,
): PaperclipMcpConfig {
  return {
    apiUrl: base.apiUrl,
    apiKey,
    companyId: base.companyId,
    agentId: base.agentId,
    runId: base.runId,
  };
}
