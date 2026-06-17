import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaperclipMcpServer } from "./index.js";
import {
  buildRequestConfig,
  readHttpServerConfigFromEnv,
  type PaperclipHttpServerConfig,
} from "./config.js";

// JSON-RPC 2.0 standard error codes used for transport-level failures that
// happen before a request reaches the MCP server (auth, routing, bad body).
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_UNAUTHORIZED = -32001;
const JSON_RPC_INTERNAL_ERROR = -32603;

function sendJsonRpcError(
  res: ServerResponse,
  httpStatus: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(httpStatus, { "Content-Type": "application/json", ...headers });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

async function readRequestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Build a Node HTTP request handler that serves the Paperclip MCP server over
 * the MCP Streamable HTTP transport.
 *
 * Each request is handled statelessly: a fresh MCP server and transport are
 * created so that no state leaks between connections, and every request must
 * carry its own `Authorization: Bearer <token>` whose identity is enforced by
 * Paperclip on each underlying REST call.
 *
 * This server speaks plain HTTP. TLS is expected to be terminated in front of
 * it (Tailscale Funnel/Serve, or a reverse proxy) per the integration spec —
 * never expose it without HTTPS in front.
 */
export function createHttpRequestHandler(
  base: PaperclipHttpServerConfig,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");

    if (requestUrl.pathname !== base.path) {
      sendJsonRpcError(res, 404, JSON_RPC_INVALID_REQUEST, "Not found");
      return;
    }

    // Stateless transport: server-initiated SSE streams (GET) and session
    // teardown (DELETE) are not supported, so reject anything but POST.
    if (req.method !== "POST") {
      sendJsonRpcError(res, 405, JSON_RPC_INVALID_REQUEST, "Method not allowed", {
        Allow: "POST",
      });
      return;
    }

    const token = extractBearerToken(req);
    if (!token) {
      sendJsonRpcError(
        res,
        401,
        JSON_RPC_UNAUTHORIZED,
        "Missing or malformed Authorization: Bearer token",
        { "WWW-Authenticate": 'Bearer realm="paperclip-mcp"' },
      );
      return;
    }

    let body: unknown;
    try {
      body = await readRequestBody(req);
    } catch {
      sendJsonRpcError(res, 400, JSON_RPC_PARSE_ERROR, "Invalid JSON request body");
      return;
    }

    const config = buildRequestConfig(base, token);
    const { server } = createPaperclipMcpServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("Paperclip MCP HTTP request failed:", error);
      sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, "Internal server error");
    }
  };
}

export interface PaperclipHttpServerHandle {
  httpServer: Server;
  config: PaperclipHttpServerConfig;
}

export function createPaperclipHttpServer(
  base: PaperclipHttpServerConfig = readHttpServerConfigFromEnv(),
): PaperclipHttpServerHandle {
  const handler = createHttpRequestHandler(base);
  const httpServer = createServer((req, res) => {
    void handler(req, res);
  });
  return { httpServer, config: base };
}

export async function runHttpServer(
  base: PaperclipHttpServerConfig = readHttpServerConfigFromEnv(),
): Promise<Server> {
  const { httpServer } = createPaperclipHttpServer(base);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(base.port, base.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });
  console.error(
    `Paperclip MCP HTTP server listening on http://${base.host}:${base.port}${base.path}`,
  );
  return httpServer;
}
