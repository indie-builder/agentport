import type {
  MarketInstallInput,
  MarketView,
  SkillInput,
  SkillWithAgentCount,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api.js';
import { toast, toastError, toastSuccess } from '../toast.js';
import { useDebouncedValue } from '../use-debounced-value.js';

export const skillsQuery = queryOptions<SkillWithAgentCount[]>({
  queryKey: ['skills'],
  queryFn: api.skills,
});

/** 「录制学习」：把一次运行沉淀为技能草稿，成功后刷新技能列表。 */
export function useSkillDraftFromRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.skillDraftFromRun(runId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useSkills(enabled = true) {
  return useQuery({ ...skillsQuery, enabled });
}

export function useCreateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SkillInput) => api.createSkill(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useImportSkillFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.importSkillFile(content),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

/** 市场搜索要求至少 2 个字符；空查询走 skills.sh 榜单。 */
export function useMarketSkills(view: MarketView, query: string) {
  // 每个字符都打一次 skills.sh 会把外部榜单打爆：停 300ms 再换 queryKey。
  const settled = useDebouncedValue(query.trim(), 300);
  const result = useQuery({
    queryKey: ['market-skills', view, settled],
    queryFn: ({ signal }) =>
      api.marketSkills({ view, ...(settled === '' ? {} : { q: settled }) }, signal),
    enabled: settled.length === 0 || settled.length >= 2,
    staleTime: 5 * 60_000,
  });
  // 防抖窗口里页面要显示加载态，不能继续展示上一个词的结果。
  return { ...result, isDebouncing: settled !== query.trim() };
}

export function useInstallMarketSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarketInstallInput) => api.installMarketSkill(input),
    onSuccess: ({ skill, warnings }) => {
      toastSuccess(`已安装「${skill.name}」`);
      for (const warning of warnings) toast.info(warning);
      // 安装总是新建，安装接口不返回 agentCount：先插一条 0，再由服务端结果校正。
      client.setQueryData<SkillWithAgentCount[]>(['skills'], (old) =>
        old ? [{ ...skill, agentCount: 0 }, ...old] : old,
      );
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: toastError,
  });
}

export function useUpdateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<SkillInput>; expectedUpdatedAt?: string }) =>
      api.updateSkill(vars.id, vars.input, vars.expectedUpdatedAt),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
    // 冲突说明列表里是旧版本：重取一次，关闭重开后拿到最新数据。
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CONFLICT_STALE') {
        void client.invalidateQueries({ queryKey: ['skills'] });
      }
    },
  });
}

export function useDeleteSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
