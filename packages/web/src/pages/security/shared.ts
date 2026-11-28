import type {
  ContentPolicyAction,
  ContentPolicyDirection,
  ContentPolicyMatchType,
  PolicyApprovalStatus,
  PolicySourceKind,
  ViolationCase,
  ViolationCaseStatus,
  ViolationSeverity,
} from '@agentport/shared';

export const DIRECTION_LABEL: Record<ContentPolicyDirection, string> = {
  inbound: '入站',
  outbound: '出站',
};

export const ACTION_LABEL: Record<ContentPolicyAction, string> = {
  block: '拦截',
  redact: '脱敏',
  require_approval: '人工审批',
};

export const MATCH_LABEL: Record<ContentPolicyMatchType, string> = {
  keyword: '关键词',
  regex: '正则',
  secret: '密钥',
  pii: 'PII',
};

export const SOURCE_LABEL: Record<PolicySourceKind, string> = {
  run_prompt: '运行输入',
  channel_message: '频道消息',
  model_request: '模型请求',
  assistant_output: '助手输出',
};

export const APPROVAL_STATUS_LABEL: Record<PolicyApprovalStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
  expired: '已过期',
};

export const VIOLATION_STATUS_LABEL: Record<ViolationCaseStatus, string> = {
  open: '待处理',
  investigating: '调查中',
  resolved: '已解决',
  dismissed: '已忽略',
};

export const SEVERITY_LABEL: Record<ViolationSeverity, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export const SUBJECT_LABEL: Record<ViolationCase['subjectKind'], string> = {
  user: '用户',
  agent: '专家',
  channel: '频道',
};

export const TABS = [
  { value: 'policies', label: '策略' },
  { value: 'approvals', label: '外发审批' },
  { value: 'events', label: '事件' },
  { value: 'violations', label: '违规处置' },
] as const;

export const DIRECTION_OPTIONS = Object.entries(DIRECTION_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export const ACTION_OPTIONS = Object.entries(ACTION_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export const OUTBOUND_ACTION_OPTIONS = ACTION_OPTIONS.filter(
  ({ value }) => value !== 'require_approval',
);

export const MATCH_OPTIONS = Object.entries(MATCH_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export const APPROVAL_STATUS_OPTIONS = Object.entries(APPROVAL_STATUS_LABEL).map(
  ([value, label]) => ({
    value,
    label,
  }),
);

export const EVENT_ACTION_OPTIONS = [{ value: 'all', label: '全部动作' }, ...ACTION_OPTIONS];

export const EVENT_SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label })),
];

export const VIOLATION_STATUS_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...Object.entries(VIOLATION_STATUS_LABEL).map(([value, label]) => ({ value, label })),
];

export const VIOLATION_STATUS_ITEMS = Object.entries(VIOLATION_STATUS_LABEL).map(
  ([value, label]) => ({
    value,
    label,
  }),
);

export function policyActionTone(action: ContentPolicyAction): 'danger' | 'warn' | 'default' {
  if (action === 'block') return 'danger';
  if (action === 'require_approval') return 'warn';
  return 'default';
}

export function approvalStatusTone(
  status: PolicyApprovalStatus,
): 'success' | 'danger' | 'warn' | 'default' {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  if (status === 'pending') return 'warn';
  return 'default';
}

export function violationSeverityTone(severity: ViolationSeverity): 'danger' | 'warn' | 'default' {
  if (severity === 'high') return 'danger';
  if (severity === 'medium') return 'warn';
  return 'default';
}

export function violationStatusTone(
  status: ViolationCaseStatus,
): 'success' | 'brand' | 'warn' | 'default' {
  if (status === 'resolved') return 'success';
  if (status === 'investigating') return 'brand';
  if (status === 'open') return 'warn';
  return 'default';
}
