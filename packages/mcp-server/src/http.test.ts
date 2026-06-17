import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPaperclipHttpServer } from "./http.js";
import type { PaperclipHttpServerConfig } from "./config.js";

const baseConfig: PaperclipHttpServerConfig = {
  apiUrl: "http://localhost:3100/api",
  companyId: "11111111-1111-1111-1111-111111111111",
  agentId: null,
  runId: null,
  host: "127.0.0.1",
  port: 0,
  path: "/mcp",
};

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  const handle = createPaperclipHttpServer(baseConfig);
  server = handle.httpServer;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function mcpHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  });
}

describe("Paperclip MCP HTTP transport", () => {
  it("returns 404 for an unknown path", async () => {
    const res = await fetch(`${baseUrl}/wrong`, {
      method: "POST",
      headers: mcpHeaders("token-123"),
      body: initializeBody(),
    });
    expect(res.status).toBe(404);
  });

  it("returns 405 for non-POST methods on the MCP path", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: mcpHeaders("token-123"),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });

  it("returns 401 when no bearer token is supplied", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders(),
      body: initializeBody(),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);
  });

  it("returns 400 for an invalid JSON body", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders("token-123"),
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("completes an MCP initialize handshake with a bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: mcpHeaders("token-123"),
      body: initializeBody(),
    });
    expect(res.status).toBe(200);

    const contentType = res.headers.get("Content-Type") ?? "";
    const text = await res.text();
    // The transport may answer with a direct JSON body or an SSE stream
    // depending on negotiation; in both cases the initialize result is present.
    const payload = contentType.includes("text/event-stream")
      ? JSON.parse(text.split("data: ")[1])
      : JSON.parse(text);
    expect(payload.result.serverInfo.name).toBe("paperclip");
  });
});
