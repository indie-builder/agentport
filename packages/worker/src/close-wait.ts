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
