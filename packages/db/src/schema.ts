import { agentMembers, rolePermissions, roles, userRoles } from './schema/accounts.js';
import {
  agentHookFiles,
  agentOutputStyles,
  agentRules,
  agentServers,
  agentSkills,
  agents,
  agentVersions,
  agentWorkflows,
} from './schema/agents.js';
import { authAccounts, authSessions, authUsers, authVerifications } from './schema/auth.js';
import {
  agentRuns,
  channelAgentBindings,
  channelMembers,
  channelMessages,
  channels,
  channelWakes,
  conversations,
  messages,
  outputShares,
} from './schema/chat.js';
import {
  dataDomainEnrichmentProposals,
  dataDomainIdentities,
  dataDomainQueryApprovals,
  dataDomainQueryLogs,
  dataDomains,
  dataDomainVersions,
} from './schema/data-domains.js';
import { evalCases, evalResults, evalRuns } from './schema/eval.js';
import {
  budgetLimits,
  departmentMembers,
  departments,
  resourceGrants,
} from './schema/governance.js';
import {
  apiTokens,
  externalRequestKeys,
  webhookDeliveries,
  webhookEndpoints,
} from './schema/integrations.js';
import {
  knowledgeBasePins,
  knowledgeBases,
  knowledgeFolders,
  knowledgeModelProfiles,
  knowledgeTags,
} from './schema/knowledge-bases.js';
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeDocumentTags,
  knowledgeDocumentVersions,
} from './schema/knowledge-documents.js';
import {
  knowledgeDocumentSourceRanges,
  knowledgeJobs,
  knowledgeSourceRanges,
  knowledgeSources,
  knowledgeSyncItems,
  knowledgeSyncRuns,
} from './schema/knowledge-sources.js';
import {
  knowledgeWikiPages,
  knowledgeWikiSources,
  knowledgeWikiVersions,
} from './schema/knowledge-wiki.js';
import { memoryChanges, memoryReviews, userPreferences } from './schema/memory.js';
import { auditLog, notifications, platformBootstrap, platformSettings } from './schema/ops.js';
import { agentSchedules, approvalRequests, runFeedback } from './schema/runs.js';
import { runtimeEnvironments, runtimeEnvironmentVersions } from './schema/runtime-environments.js';
import { apiTools, servers } from './schema/servers.js';
import { skillFiles, skills } from './schema/skills.js';

export * from './schema/accounts.js';
export * from './schema/agents.js';
export * from './schema/auth.js';
export * from './schema/chat.js';
export * from './schema/data-domains.js';
export * from './schema/eval.js';
export * from './schema/governance.js';
export * from './schema/integrations.js';
export * from './schema/knowledge-bases.js';
export * from './schema/knowledge-documents.js';
export * from './schema/knowledge-sources.js';
export * from './schema/knowledge-wiki.js';
export * from './schema/memory.js';
export * from './schema/ops.js';
export * from './schema/plugins.js';
export * from './schema/runs.js';
export * from './schema/runtime-environments.js';
export * from './schema/servers.js';
export * from './schema/skills.js';

export const schema = {
  departments,
  departmentMembers,
  resourceGrants,
  budgetLimits,
  apiTokens,
  webhookEndpoints,
  webhookDeliveries,
  externalRequestKeys,
  servers,
  apiTools,
  agents,
  skills,
  agentSkills,
  skillFiles,
  agentRules,
  agentOutputStyles,
  agentWorkflows,
  agentHookFiles,
  agentServers,
  agentVersions,
  runtimeEnvironmentVersions,
  runtimeEnvironments,
  dataDomainVersions,
  dataDomains,
  dataDomainIdentities,
  dataDomainQueryApprovals,
  dataDomainQueryLogs,
  dataDomainEnrichmentProposals,
  conversations,
  messages,
  channels,
  channelMembers,
  channelAgentBindings,
  channelMessages,
  channelWakes,
  agentRuns,
  approvalRequests,
  agentSchedules,
  runFeedback,
  evalCases,
  evalRuns,
  evalResults,
  auditLog,
  notifications,
  platformBootstrap,
  platformSettings,
  roles,
  rolePermissions,
  userRoles,
  agentMembers,
  authUsers,
  authSessions,
  authAccounts,
  authVerifications,
  outputShares,
  userPreferences,
  memoryReviews,
  memoryChanges,
  knowledgeModelProfiles,
  knowledgeBases,
  knowledgeBasePins,
  knowledgeFolders,
  knowledgeTags,
  knowledgeDocuments,
  knowledgeDocumentVersions,
  knowledgeChunks,
  knowledgeSources,
  knowledgeSourceRanges,
  knowledgeDocumentSourceRanges,
  knowledgeSyncRuns,
  knowledgeSyncItems,
  knowledgeJobs,
  knowledgeWikiPages,
  knowledgeWikiVersions,
  knowledgeWikiSources,
  knowledgeDocumentTags,
};
