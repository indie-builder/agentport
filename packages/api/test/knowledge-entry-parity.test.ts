import { knowledgeMcpEntry } from '@agentport/shared';
import { describe, expect, it } from 'vitest';

/**
 * 预览与运行时必须渲染出同一个地址形状；这里固定运行时侧构造结果，
 * 防止任一侧再复制一份 URL 拼接逻辑。
 */
describe('knowledge entry parity', () => {
  it('uses the platform /mcp/:id path and run-scoped headers', () => {
    const entry = knowledgeMcpEntry({
      apiUrl: 'http://api:3000',
      serverId: 'srv_1',
      runId: 'run_1',
      runToken: 'tok_1',
    });
    expect(entry.url).toBe('http://api:3000/mcp/srv_1');
    expect(entry.headers['x-agentport-run-id']).toBe('run_1');
    expect(entry.headers.Authorization).toBe('Bearer tok_1');
    expect(entry.type).toBe('http');
  });
});
