import { Search } from 'lucide-react';
import { useState } from 'react';
import { useKnowledgeFaqTest } from '../../../lib/queries.js';
import { PageSection } from '../../page.js';
import { SearchInput } from '../../search-input.js';
import { ErrorState, LoadingState } from '../../states.js';
import { Button } from '../../ui/button.js';
import { Field, FieldLabel } from '../../ui/field.js';
import { Input } from '../../ui/input.js';
import { Switch } from '../../ui/switch.js';
import { FaqRetrievalControls, KnowledgeSearchResults } from '../knowledge-search.js';

export function FaqTest({ baseId }: { baseId: string }) {
  const [draft, setDraft] = useState('');
  const [term, setTerm] = useState('');
  const [rerank, setRerank] = useState(true);
  const [minVectorScore, setMinVectorScore] = useState(0.3);
  const [faqOptions, setFaqOptions] = useState<{
    onlyRecommended?: boolean | undefined;
    faqPriority?: boolean | undefined;
    faqDirectAnswerThreshold?: number | undefined;
  }>({});
  const result = useKnowledgeFaqTest(baseId, {
    q: term,
    rerank,
    minVectorScore,
    ...faqOptions,
  });
  return (
    <PageSection title="命中测试" divided>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          if (next === term) {
            if (next !== '') void result.refetch();
            return;
          }
          setTerm(next);
        }}
      >
        <SearchInput
          label="FAQ 命中测试"
          placeholder="输入用户问法…"
          value={draft}
          onChange={setDraft}
          className="min-w-48 flex-1 sm:max-w-md"
        />
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={rerank} onCheckedChange={setRerank} aria-label="启用重排" /> 重排
        </span>
        <Field className="w-32 gap-1">
          <FieldLabel htmlFor="faq-test-threshold" className="text-sm">
            向量门槛
          </FieldLabel>
          <Input
            id="faq-test-threshold"
            type="number"
            min={-1}
            max={1}
            step={0.05}
            value={minVectorScore}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') {
                setMinVectorScore(0.3);
                return;
              }
              const next = Number(raw);
              if (Number.isFinite(next) && next >= -1 && next <= 1) setMinVectorScore(next);
            }}
            className="h-8"
          />
        </Field>
        <FaqRetrievalControls
          idPrefix="faq-test"
          value={faqOptions}
          onChange={(patch) => setFaqOptions((current) => ({ ...current, ...patch }))}
        />
        <Button type="submit" disabled={draft.trim() === ''}>
          <Search data-icon="inline-start" aria-hidden="true" /> 测试
        </Button>
      </form>
      {term === '' ? null : result.isPending ? <LoadingState rows={2} /> : null}
      {term !== '' && result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : null}
      {result.data ? (
        <KnowledgeSearchResults result={result.data} emptyTitle="没有命中 FAQ" />
      ) : null}
    </PageSection>
  );
}
