import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Service {
  environment?: Record<string, string>;
  image?: string;
  command?: string[];
  volumes?: Array<{ source: string; target: string; type: string }>;
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test?: string[] };
}

// config is read-only: it parses the deployment without starting containers or exposing env values.
const config = JSON.parse(
  execFileSync(
    'docker',
    [
      'compose',
      '--project-directory',
      fileURLToPath(new URL('../../../', import.meta.url)),
      'config',
      '--no-env-resolution',
      '--no-interpolate',
      '--format',
      'json',
    ],
    { encoding: 'utf8' },
  ),
) as { services: Record<string, Service> };

describe('native memory deployment', () => {
  it('gives API and worker the same persistent workspace path and volume', () => {
    for (const name of ['api', 'worker']) {
      const service = config.services[name];
      expect(service?.environment?.WORKSPACES_DIR).toBe('/workspaces');
      expect(service?.volumes).toContainEqual(
        expect.objectContaining({ source: 'workspaces', target: '/workspaces', type: 'volume' }),
      );
      expect(service?.depends_on?.init?.condition).toBe('service_completed_successfully');
    }
    expect(config.services.api?.image).toBe(config.services.worker?.image);
    expect(config.services.init?.command?.slice(0, 3)).toEqual(['chown', '-R', '1000:1000']);
    expect(config.services.init?.command).toContain('/w');
    expect(config.services.init?.command).toContain('/k');
    expect(config.services.init?.volumes).toContainEqual(
      expect.objectContaining({ source: 'knowledgedata', target: '/k', type: 'volume' }),
    );
    expect(config.services.init?.volumes).toContainEqual(
      expect.objectContaining({ source: 'workspaces', target: '/w', type: 'volume' }),
    );
  });

  it('checks API readiness with a compose healthcheck', () => {
    expect(config.services.api?.healthcheck?.test?.join(' ')).toContain('/health/ready');
  });
});
