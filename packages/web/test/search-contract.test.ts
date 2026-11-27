import { describe, expect, it } from 'vitest';
import {
  evalSearchSchema,
  integrationsSearchSchema,
  knowledgeDetailSearchSchema,
  personalWorkSearchSchema,
  runDetailSearchSchema,
  runsSearchSchema,
  serversSearchSchema,
} from '../src/routes/-search.js';

describe('shared search contract', () => {
  it('accepts the known run statuses on the runs list', () => {
    const statuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout'];

    for (const status of statuses) {
      expect(runsSearchSchema.parse({ status })).toEqual({ status });
    }

    expect(runsSearchSchema.parse({ status: 'unknown' })).toEqual({});
  });

  it('carries the backTo source URL and step together', () => {
    expect(
      runDetailSearchSchema.parse({
        step: '3',
        backTo: '/runs?agent=agent_01m5bv0faceh4v4jtw00eta1sn&status=failed',
      }),
    ).toEqual({
      step: 3,
      backTo: '/runs?agent=agent_01m5bv0faceh4v4jtw00eta1sn&status=failed',
    });
    expect(runDetailSearchSchema.parse({ step: '-1' })).toEqual({});
  });

  it('rejects backTo values that leave the site', () => {
    for (const backTo of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '//placeholder.invalid',
      '/\\placeholder.invalid',
      '/\\t/placeholder.invalid',
      '/ placeholder.invalid',
      'runs',
      '',
    ]) {
      expect(runDetailSearchSchema.parse({ backTo })).toEqual({});
    }
    expect(runDetailSearchSchema.parse({ backTo: `/${'a'.repeat(2048)}` })).toEqual({});
  });

  it('keeps in-site backTo links usable', () => {
    expect(runDetailSearchSchema.parse({ backTo: '/personal/usage?days=7&status=failed' })).toEqual(
      { backTo: '/personal/usage?days=7&status=failed' },
    );
  });

  it('keeps the selected run and comparison sides addressable in the eval URL', () => {
    expect(
      evalSearchSchema.parse({
        agent: 'agent-a',
        run: 'evalRun_01m5bv0faceh4v4jtw00eta1sn',
        base: 'evalRun_base',
        head: 'evalRun_head',
      }),
    ).toEqual({
      agent: 'agent-a',
      run: 'evalRun_01m5bv0faceh4v4jtw00eta1sn',
      base: 'evalRun_base',
      head: 'evalRun_head',
    });

    expect(evalSearchSchema.parse({ run: '', base: '', head: '' })).toEqual({});
    expect(evalSearchSchema.parse({ unknown: 'x' })).toEqual({});
    expect(
      evalSearchSchema.parse({
        agent: 'agent-a',
        tab: 'cases',
        q: 'regression',
        filter: 'tools',
      }),
    ).toEqual({
      agent: 'agent-a',
      tab: 'cases',
      q: 'regression',
      filter: 'tools',
    });
    expect(evalSearchSchema.parse({ filter: 'invalid', tab: 'cases' })).toEqual({ tab: 'cases' });
  });

  it('validates knowledge detail document filter and sort parameters', () => {
    expect(
      knowledgeDetailSearchSchema.parse({
        panel: 'documents',
        folder: 'kfd_1',
        document: 'kdoc_1',
        q: '上线',
        status: 'failed',
        tag: '流程',
        sort: 'title',
      }),
    ).toEqual({
      panel: 'documents',
      folder: 'kfd_1',
      document: 'kdoc_1',
      q: '上线',
      status: 'failed',
      tag: '流程',
      sort: 'title',
    });
    expect(
      knowledgeDetailSearchSchema.parse({
        status: 'bogus',
        tag: '',
        sort: 'invalid',
        folder: 'null',
      }),
    ).toEqual({ folder: 'null' });
  });

  it('validates tab and view parameters for integrations, servers and personal work', () => {
    expect(integrationsSearchSchema.parse({ tab: 'webhooks', view: 'table' })).toEqual({
      tab: 'webhooks',
      view: 'table',
    });
    expect(integrationsSearchSchema.parse({ tab: 'invalid', view: 'grid' })).toEqual({});

    expect(serversSearchSchema.parse({ kind: 'http', view: 'cards' })).toEqual({
      kind: 'http',
      view: 'cards',
    });
    expect(serversSearchSchema.parse({ view: 'invalid' })).toEqual({});

    expect(
      personalWorkSearchSchema.parse({ tab: 'outputs', q: 'report', source: 'scheduled' }),
    ).toEqual({
      tab: 'outputs',
      q: 'report',
      source: 'scheduled',
    });
    expect(personalWorkSearchSchema.parse({ tab: 'bad', source: 'auto' })).toEqual({});
  });
});
