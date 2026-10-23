import { AppError } from '@agentport/core';
import pLimit from 'p-limit';

/**
 * 执行池只包住真正打上游的 fetch + 读完响应体：等待批准、协议握手、SSE 订阅不占名额。
 * 多进程部署时每个进程各自计数；全局限额由反向代理兜底。
 */
const execution = pLimit(4);

const MAX_PENDING_EXECUTIONS = 8;

export function runMcpExecution<T>(task: () => Promise<T>): Promise<T> {
  if (execution.pendingCount >= MAX_PENDING_EXECUTIONS) {
    return Promise.reject(new AppError('SERVICE_UNAVAILABLE', '工具执行队列已满，请稍后重试'));
  }
  return execution(task);
}

const MAX_APPROVAL_WAITS = 4;
let approvalWaits = 0;

/**
 * 挂起等待批准的名额：满了立即返回 accepted:false，由调用方走立即拒绝路径，
 * 不排队、不占执行池，否则等待中的调用会把整条链路堵死。
 */
export async function tryApprovalWait<T>(
  task: () => Promise<T>,
): Promise<{ accepted: true; value: T } | { accepted: false }> {
  // 同步检查并占用名额，避免 await 前被其他调用插队。
  if (approvalWaits >= MAX_APPROVAL_WAITS) return { accepted: false };
  approvalWaits++;
  try {
    return { accepted: true, value: await task() };
  } finally {
    approvalWaits--;
  }
}
