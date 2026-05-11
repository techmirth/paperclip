// CUL-252 — guardrail tests for `adapterConfig.model` allow-list enforcement.
//
// Root cause: manual user PATCHes have repeatedly set
// `adapterConfig.model` to fictitious strings (e.g. "deepseek-v4-pro" on the
// claude_local adapter), which the underlying CLI rejects on spawn, causing
// silent-run hangs / status:error.
//
// `assertAdapterModelKnown` in routes/agents.ts compares the requested model
// against the adapter's published `models` list and rejects (422) when the
// value is not present. Adapters that publish no models are skipped.

import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  resolveAdapterConfigForRuntime: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => ({ config }),
  ),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

const modelAllowListAdapter: ServerAdapterModule = {
  type: "model_allow_list_test",
  models: [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  ],
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "model_allow_list_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

const noModelsAdapter: ServerAdapterModule = {
  type: "no_models_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "no_models_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "company-1";

function existingAgentFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Test Agent",
    urlKey: "test-agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "model_allow_list_test",
    adapterConfig: { model: "claude-opus-4-7" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    defaultEnvironmentId: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: COMPANY_ID,
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("CUL-252 adapter model allow-list guardrail", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentService.create.mockImplementation(
      async (_companyId: string, input: Record<string, unknown>) => ({
        ...existingAgentFixture(),
        adapterType: String(input.adapterType ?? "process"),
        adapterConfig:
          (input.adapterConfig as Record<string, unknown> | undefined) ?? {},
        runtimeConfig:
          (input.runtimeConfig as Record<string, unknown> | undefined) ?? {},
      }),
    );
    mockAgentService.update.mockImplementation(
      async (id: string, patch: Record<string, unknown>) => ({
        ...existingAgentFixture(),
        id,
        ...patch,
      }),
    );
    await unregisterTestAdapter("model_allow_list_test");
    await unregisterTestAdapter("no_models_test");
  });

  afterEach(async () => {
    await unregisterTestAdapter("model_allow_list_test");
    await unregisterTestAdapter("no_models_test");
  });

  it("POST /agents — rejects `deepseek-v4-pro` with 422", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(modelAllowListAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "Drift Agent",
          adapterType: "model_allow_list_test",
          adapterConfig: { model: "deepseek-v4-pro" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const message = String(res.body.error ?? res.body.message ?? "");
    expect(message).toContain("model_allow_list_test");
    expect(message).toContain("deepseek-v4-pro");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("POST /agents — accepts an allow-listed model with 201", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(modelAllowListAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "Healthy Agent",
          adapterType: "model_allow_list_test",
          adapterConfig: { model: "claude-opus-4-7" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledOnce();
  });

  it("PATCH /agents/:id — PATCH `adapterConfig.model = 'deepseek-v4-pro'` returns 422", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(modelAllowListAdapter);

    mockAgentService.getById.mockResolvedValue(existingAgentFixture());

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${AGENT_ID}`)
        .send({
          adapterConfig: { model: "deepseek-v4-pro" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const message = String(res.body.error ?? res.body.message ?? "");
    expect(message).toContain("deepseek-v4-pro");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("PATCH /agents/:id — accepts an allow-listed model", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(modelAllowListAdapter);

    mockAgentService.getById.mockResolvedValue(existingAgentFixture());

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${AGENT_ID}`)
        .send({
          adapterConfig: { model: "claude-sonnet-4-6" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledOnce();
  });

  it("skips assertion when the adapter publishes no models list", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(noModelsAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({
          name: "No-Models Agent",
          adapterType: "no_models_test",
          adapterConfig: { model: "anything-goes" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
