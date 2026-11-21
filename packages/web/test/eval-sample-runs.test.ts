import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type EvalSampleCandidate } from '../src/lib/api.js';
import { SampleRunsDialog } from '../src/pages/eval/sample-runs-dialog.js';

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

const candidate: EvalSampleCandidate = {
  runId: 'run_abc12345',
  conversationId: 'conv_a',
  title: '季度复盘',
  prompt: '请总结本季度进展\n第二行',
  endedAt: '2026-11-01T08:00:00.000Z',
};

async function mount(onConvert = vi.fn()) {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SampleRunsDialog, {
          agentId: 'agent-a',
          onConvert,
          onClose: vi.fn(),
        }),
      ),
    );
  });
  return onConvert;
}

async function waitFor(assert: () => void) {
  await act(async () => {
    await vi.waitFor(assert);
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('SampleRunsDialog', () => {
  it('lists sampled runs and converts the chosen one', async () => {
    vi.spyOn(api, 'sampleEvalCandidates').mockResolvedValue([candidate]);
    const onConvert = await mount();
    await waitFor(() => expect(document.body.textContent).toContain('季度复盘'));
    expect(document.body.textContent).toContain('请总结本季度进展');
    expect(document.body.textContent).not.toContain('第二行');
    await act(async () => button('转为用例').click());
    expect(onConvert).toHaveBeenCalledWith(candidate);
    expect(api.sampleEvalCandidates).toHaveBeenCalledWith({ agentId: 'agent-a' });
  });

  it('shows the empty state when no run can be sampled', async () => {
    vi.spyOn(api, 'sampleEvalCandidates').mockResolvedValue([]);
    await mount();
    await waitFor(() => expect(document.body.textContent).toContain('近期没有可抽样的运行'));
  });

  it('removes an ignored candidate from the list locally', async () => {
    vi.spyOn(api, 'sampleEvalCandidates').mockResolvedValue([candidate]);
    const onConvert = await mount();
    await waitFor(() => expect(document.body.textContent).toContain('季度复盘'));
    await act(async () => button('忽略').click());
    expect(document.body.textContent).not.toContain('季度复盘');
    expect(document.body.textContent).toContain('近期没有可抽样的运行');
    expect(onConvert).not.toHaveBeenCalled();
  });
});
