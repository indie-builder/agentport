import { AppError } from '@agentport/core';
import pLimit from 'p-limit';

const execution = pLimit(4);

const MAX_PENDING_EXECUTIONS = 8;

export function runMcpExecution<T>(task: () => Promise<T>): Promise<T> {
  if (execution.pendingCount >= MAX_PENDING_EXECUTIONS) {
    return Promise.reject(new AppError('SERVICE_UNAVAILABLE', '工具执行队列已满，请稍后重试'));
  }
  return execution(task);
}
