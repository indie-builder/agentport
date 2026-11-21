export type ReviewWindow<T> =
  | { kind: 'ok'; from: number; through: number; messages: T[] }
  | { kind: 'missing'; anchor: 'from' | 'through'; messageId: string };

export function selectReviewWindow<T extends { id: string; role: string; text: string }>(
  messages: T[],
  anchors: { fromMessageId?: string | undefined; throughMessageId?: string | undefined },
): ReviewWindow<T> {
  let from = 0;
  let through = messages.length;
  if (anchors.fromMessageId !== undefined) {
    const index = messages.findIndex((message) => message.id === anchors.fromMessageId);
    if (index < 0) {
      return { kind: 'missing', anchor: 'from', messageId: anchors.fromMessageId };
    }
    from = index;
  }
  if (anchors.throughMessageId !== undefined) {
    const index = messages.findIndex((message) => message.id === anchors.throughMessageId);
    if (index < 0) {
      return { kind: 'missing', anchor: 'through', messageId: anchors.throughMessageId };
    }
    through = index + 1;
  }
  return {
    kind: 'ok',
    from,
    through,
    messages: messages
      .slice(from, through)
      .filter(
        (message) =>
          (message.role === 'user' || message.role === 'assistant') && message.text !== '',
      ),
  };
}
