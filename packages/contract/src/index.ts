import { agentsContract } from './agents.js';
import { auditContract } from './audit.js';
import { authContract, authNativeContract } from './auth.js';
import { channelsContract } from './channels.js';
import { chatContract } from './chat.js';
import { evalContract } from './eval.js';
import { knowledgeContract } from './knowledge.js';
import { marketContract } from './market.js';
import { memoryContract } from './memory.js';
import { memoryReviewsContract } from './memory-reviews.js';
import { opsContract } from './ops.js';
import { outputSharesContract } from './output-shares.js';
import { overviewContract } from './overview.js';
import { personalContract } from './personal.js';
import { pluginsContract } from './plugins.js';
import { runsContract } from './runs.js';
import { runtimeEnvironmentsContract } from './runtime-environments.js';
import { serversContract } from './servers.js';
import { skillsContract } from './skills.js';

export * from './access.js';
export * from './agents.js';
export * from './audit.js';
export * from './auth.js';
export * from './base.js';
export * from './channels.js';
export * from './chat.js';
export * from './errors.js';
export * from './eval.js';
export * from './knowledge.js';
export * from './market.js';
export * from './memory.js';
export * from './memory-reviews.js';
export * from './ops.js';
export * from './output-shares.js';
export * from './overview.js';
export * from './personal.js';
export * from './plugins.js';
export * from './runs.js';
export * from './runtime-environments.js';
export * from './servers.js';
export * from './skills.js';

export const apiContract: {
  agents: typeof agentsContract;
  audit: typeof auditContract;
  auth: typeof authContract & typeof authNativeContract;
  channels: typeof channelsContract;
  chat: typeof chatContract;
  eval: typeof evalContract;
  knowledge: typeof knowledgeContract;
  market: typeof marketContract;
  memory: typeof memoryContract;
  memoryReviews: typeof memoryReviewsContract;
  ops: typeof opsContract;
  outputShares: typeof outputSharesContract;
  overview: typeof overviewContract;
  personal: typeof personalContract;
  plugins: typeof pluginsContract;
  runs: typeof runsContract;
  runtimeEnvironments: typeof runtimeEnvironmentsContract;
  servers: typeof serversContract;
  skills: typeof skillsContract;
} = {
  agents: agentsContract,
  audit: auditContract,
  auth: { ...authContract, ...authNativeContract },
  channels: channelsContract,
  chat: chatContract,
  eval: evalContract,
  knowledge: knowledgeContract,
  market: marketContract,
  memory: memoryContract,
  memoryReviews: memoryReviewsContract,
  ops: opsContract,
  outputShares: outputSharesContract,
  overview: overviewContract,
  personal: personalContract,
  plugins: pluginsContract,
  runs: runsContract,
  runtimeEnvironments: runtimeEnvironmentsContract,
  servers: serversContract,
  skills: skillsContract,
};
