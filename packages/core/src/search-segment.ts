const zhWordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function segmentForSearch(text: string): string {
  const words: string[] = [];
  for (const segment of zhWordSegmenter.segment(text)) {
    if (segment.isWordLike) words.push(segment.segment);
  }
  return words.join(' ');
}
