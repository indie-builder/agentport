/** 把历史与当前请求拼成一次 prompt；沙盒每次是新容器，没有可续用的 session。 */
export function composePrompt(prompt: string, history?: string): string {
  if (history === undefined || history.length === 0) return prompt;
  return `之前的对话：\n${history}\n（以上为历史，仅供参考）\n\n当前请求：${prompt}`;
}
