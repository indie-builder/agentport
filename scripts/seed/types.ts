import type { Database } from '@agentport/db';

export interface SeedContext {
  db: Database;
  businessId: string;
  now: Date;
  log: (message: string) => void;
}

export interface DemoAgent {
  id: string;
  slug: string;
  name: string;
}

interface DemoRun {
  conversationId: string;
  runId: string;
}

export interface DemoCatalog {
  agents?: Record<'analyst' | 'support' | 'compliance' | 'engineer', DemoAgent>;
  channels?: Record<'delivery' | 'support', { id: string; name: string }>;
  runs?: { succeeded?: DemoRun; failed?: DemoRun };
}
