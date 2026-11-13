/** true = closing 在超时前结束；false = 超时后仍在运行。只结束等待，不取消后台任务。 */
export function waitClose(closing: Promise<unknown>, ms: number): Promise<boolean> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  return Promise.race([
    closing.then(
      () => true,
      () => true,
    ),
    deadline,
  ]).finally(() => clearTimeout(timer));
}
