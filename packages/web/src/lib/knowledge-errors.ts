/** worker 把内部常量写进 job.error：已知原因换成可判断的中文，未知错误原样返回。 */
const workerErrorLabels = new Map([
  ['knowledge worker lost track of this job', '后台任务中断，本次未完成；重试会重新执行'],
  ['worker shutting down', '后台服务重启，任务未完成；重试会重新执行'],
  ['cancelled', '任务已取消'],
]);

export function knowledgeJobErrorText(error: string | null | undefined): string | null {
  if (error === null || error === undefined || error.trim() === '') return null;
  return workerErrorLabels.get(error) ?? error;
}
