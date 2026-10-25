import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api.js';

function mockFetch(response: Response | (() => Promise<Response>)) {
  const impl = typeof response === 'function' ? response : async () => response;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl as typeof fetch);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation list contract', () => {
  it('returns the server list as-is for the requested expert', async () => {
    const list = [
      {
        id: 'c1',
        agentId: 'a1',
        title: 'Alpha',
        createdAt: '',
        updatedAt: '',
        lastMessage: null,
      },
    ];
    const fetch = mockFetch(Response.json(list));
    await expect(api.conversations('agent-a')).resolves.toEqual(list);
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/conversations?agentId=agent-a');
  });

  it('surfaces a 404 as an error instead of pretending the list is unsupported', async () => {
    mockFetch(Response.json({ code: 'NOT_FOUND', message: '路由不存在' }, { status: 404 }));
    await expect(api.conversations()).rejects.toMatchObject({ status: 404 });
  });
});

describe('overview contract', () => {
  it('rejects a 404 instead of pretending the endpoint is unsupported', async () => {
    mockFetch(Response.json({ code: 'NOT_FOUND', message: '路由不存在' }, { status: 404 }));
    await expect(api.overview()).rejects.toMatchObject({ status: 404 });
  });
});

describe('agent package transfer', () => {
  it('downloads the exported ZIP as a Blob', async () => {
    const fetch = mockFetch(new Response('PK\u0003\u0004zip'));
    const blob = await api.exportAgent('agent-1');
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe('PK\u0003\u0004zip');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/export/agents/agent-1');
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('include');
  });

  it('sends an expired session back to login on a ZIP download', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/', assign });
    mockFetch(Response.json({ code: 'UNAUTHORIZED', message: '登录已失效' }, { status: 401 }));
    await expect(api.exportAgent('agent-1')).rejects.toMatchObject({ status: 401 });
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('keeps the Problem body when the ZIP export fails', async () => {
    mockFetch(
      Response.json(
        { code: 'CONFLICT', message: '专家包超过 1 MiB', requestId: 'req-1' },
        { status: 409 },
      ),
    );
    const error = await api.exportAgent('agent-1').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'CONFLICT', requestId: 'req-1' });
  });

  it('rethrows an aborted ZIP download unchanged', async () => {
    const controller = new AbortController();
    mockFetch(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const error = await api
      .exportAgent('agent-1', controller.signal)
      .catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('uploads the ZIP binary with its content type and returns the import result', async () => {
    const result = {
      agent: {
        id: 'agent-2',
        slug: 'imported',
        name: 'Imported',
        role: '通用助手',
        description: '',
        model: 'claude-sonnet-5-5',
        systemPrompt: '',
        serverIds: [],
        skillIds: [],
        subAgentIds: [],
        allowedTools: [],
        disallowedTools: [],
        permissionMode: 'dontAsk',
        maxTurns: 20,
        maxBudgetUsd: 2,
        timeoutMs: 600_000,
        enabled: true,
        parentId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      createdServers: [],
      reusedServers: [],
      createdSkills: [],
      createdSubAgents: [],
      warnings: ['slug 已存在，导入为 "imported-2"'],
    };
    const fetch = mockFetch(Response.json(result, { status: 201 }));
    const file = new File([new Uint8Array([1, 2, 3])], 'expert.zip', {
      type: 'application/zip',
    });
    await expect(api.importAgent(file)).resolves.toEqual(result);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/import/agents');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(file);
    expect(init?.headers).toMatchObject({ 'content-type': 'application/zip' });
    expect(init?.credentials).toBe('include');
  });

  it('reports an import Problem with its status and message', async () => {
    mockFetch(
      Response.json({ code: 'INVALID_INPUT', message: '不是有效的 ZIP 包' }, { status: 400 }),
    );
    const error = await api.importAgent(new Blob(['bad'])).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'INVALID_INPUT',
      message: '不是有效的 ZIP 包',
    });
  });

  it('rethrows an aborted ZIP upload unchanged', async () => {
    const controller = new AbortController();
    mockFetch(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const error = await api
      .importAgent(new Blob(['zip']), controller.signal)
      .catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('native fetch signal', () => {
  it('forwards the abort signal for audit and market searches', async () => {
    const fetch = mockFetch(() => Promise.resolve(Response.json([])));
    const controller = new AbortController();
    await api.audit({ action: 'auth.' }, controller.signal);
    await api.marketSkills({ view: 'all-time', q: 'pdf' }, controller.signal);
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
  });

  it('rethrows abort unchanged instead of reporting the API unreachable', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const error = await api
      .audit({}, new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});
