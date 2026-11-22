import { useEffect, useState } from 'react';

export const MEDIA_LG = '(min-width: 64rem)';
export const MEDIA_XL = '(min-width: 80rem)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setMatches(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
