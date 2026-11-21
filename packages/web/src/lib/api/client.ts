export { ApiError, errorMessage } from '../orpc.js';

import agents from './agents.js';
import audit from './audit.js';
import auth from './auth.js';
import channels from './channels.js';
import chat from './chat.js';
import dataDomains from './data-domains.js';
import evalApi from './eval.js';
import health from './health.js';
import knowledge from './knowledge.js';
import market from './market.js';
import memory from './memory.js';
import modelProviders from './model-providers.js';
import notifications from './notifications.js';
import observability from './observability.js';
import ops from './ops.js';
import overview from './overview.js';
import personal from './personal.js';
import plugins from './plugins.js';
import runs from './runs.js';
import runtimeEnvironments from './runtime-environments.js';
import search from './search.js';
import security from './security.js';
import servers from './servers.js';
import skills from './skills.js';
import workflows from './workflows.js';

export const api = {
  ...agents,
  ...audit,
  ...auth,
  ...channels,
  ...chat,
  ...dataDomains,
  ...evalApi,
  ...health,
  ...knowledge,
  ...market,
  ...memory,
  ...modelProviders,
  ...notifications,
  ...observability,
  ...ops,
  ...overview,
  ...personal,
  ...plugins,
  ...runs,
  ...runtimeEnvironments,
  ...search,
  ...security,
  ...servers,
  ...skills,
  ...workflows,
};
