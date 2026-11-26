import type { AGENT_ROLES, AgentSummary } from '@agentport/shared';
import {
  BarChart3,
  Bug,
  Check,
  Code,
  FileText,
  Layers,
  type LucideIcon,
  MessageSquare,
  Pencil,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { AgentAvatar } from '../../components/agent/agent-avatar.js';
import { Badge } from '../../components/ui/badge.js';

export interface WelcomeSuggestion {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly prompt: string;
}

const defaultSuggestions: readonly WelcomeSuggestion[] = [
  {
    label: '梳理思路',
    icon: MessageSquare,
    prompt: '帮我梳理一个想法，先通过提问了解我的目标，再整理出重点。',
  },
  {
    label: '制定计划',
    icon: Check,
    prompt: '帮我把一个目标拆成可执行的步骤，先询问我需要完成什么。',
  },
  {
    label: '整理内容',
    icon: Pencil,
    prompt: '帮我整理一段内容，先询问我需要整理的材料和期望的输出。',
  },
  {
    label: '分析问题',
    icon: Wrench,
    prompt: '帮我分析一个问题，先了解背景、现象和已有尝试。',
  },
];

const fallbackSuggestions: readonly WelcomeSuggestion[] = [
  {
    label: '交代新任务',
    icon: MessageSquare,
    prompt: '我有一个新任务交给你，先问清楚目标、输入材料和交付要求再动手。',
  },
  {
    label: '分析问题',
    icon: Search,
    prompt: '帮我排查一个遇到的问题，先了解背景、现象和约束条件。',
  },
  {
    label: '产出方案',
    icon: Layers,
    prompt: '帮我起草一份可行方案，先确认目标场景、边界和重点关注项。',
  },
  {
    label: '整理材料',
    icon: FileText,
    prompt: '帮我把零散材料整理成清晰结论，先询问我有哪些内容和期望格式。',
  },
];

const roleSuggestions: Record<(typeof AGENT_ROLES)[number], readonly WelcomeSuggestion[]> = {
  通用助手: defaultSuggestions,
  前端工程师: [
    {
      label: '搭建页面',
      icon: Layers,
      prompt: '帮我搭建一个前端页面或交互组件，先确认场景、布局结构和交互要求。',
    },
    {
      label: '排查界面',
      icon: Bug,
      prompt: '帮我排查前端渲染、状态或样式问题，先了解报错信息、复现步骤和预期表现。',
    },
    {
      label: '梳理状态',
      icon: Code,
      prompt: '帮我设计组件拆分与状态流转，先确认数据来源、交互路径和边界情况。',
    },
    {
      label: '优化体验',
      icon: Sparkles,
      prompt: '帮我检查并优化页面性能、无障碍或交互细节，先说明当前页面和关注重点。',
    },
  ],
  后端工程师: [
    {
      label: '设计接口',
      icon: Code,
      prompt: '帮我设计后端接口或服务模块，先确认业务场景、入参出参和异常边界。',
    },
    {
      label: '排查故障',
      icon: Bug,
      prompt: '帮我定位接口报错或服务异常，先了解日志现象、触发条件和相关代码。',
    },
    {
      label: '设计数据',
      icon: Layers,
      prompt: '帮我设计数据模型与查询方案，先确认实体关系、读写场景和一致性要求。',
    },
    {
      label: '优化性能',
      icon: Wrench,
      prompt: '帮我分析接口耗时或并发瓶颈，先了解现状指标、调用链路和约束条件。',
    },
  ],
  测试工程师: [
    {
      label: '编写用例',
      icon: Check,
      prompt: '帮我梳理并编写测试用例，先确认需求范围、核心流程和异常场景。',
    },
    {
      label: '定位缺陷',
      icon: Bug,
      prompt: '帮我分析并复现一个缺陷，先了解环境信息、操作步骤和实际与预期差异。',
    },
    {
      label: '设计回归',
      icon: Layers,
      prompt: '帮我规划本次改动的回归测试范围，先确认变更模块和风险点。',
    },
    {
      label: '整理报告',
      icon: FileText,
      prompt: '帮我整理测试结论与缺陷清单，先询问需要汇总的测试结果和关注维度。',
    },
  ],
  产品经理: [
    {
      label: '梳理需求',
      icon: MessageSquare,
      prompt: '帮我梳理一个产品需求，先通过提问明确目标用户、使用场景和核心痛点。',
    },
    {
      label: '撰写文档',
      icon: FileText,
      prompt: '帮我起草产品需求说明或功能方案，先确认背景目标、范围和关键流程。',
    },
    {
      label: '拆解版本',
      icon: Check,
      prompt: '帮我评估需求优先级并拆分阶段版本，先了解目标周期、资源和核心诉求。',
    },
    {
      label: '分析方案',
      icon: Search,
      prompt: '帮我对比不同产品设计方案的利弊，先说明待决策的问题和约束条件。',
    },
  ],
  数据分析师: [
    {
      label: '分析指标',
      icon: BarChart3,
      prompt: '帮我拆解业务指标波动原因，先了解指标口径、时间范围和异常现象。',
    },
    {
      label: '设计口径',
      icon: Layers,
      prompt: '帮我定义分析指标与统计口径，先确认分析目标、数据源和业务规则。',
    },
    {
      label: '提取洞察',
      icon: Search,
      prompt: '帮我从现有数据中提炼关键结论，先询问我手头的数据内容和想回答的问题。',
    },
    {
      label: '整理汇报',
      icon: FileText,
      prompt: '帮我把分析结果整理成数据汇报结构，先确认受众对象和核心结论。',
    },
  ],
  'UI 设计师': [
    {
      label: '设计界面',
      icon: Layers,
      prompt: '帮我构思界面布局与信息层级，先确认页面目标、主要内容和关键操作。',
    },
    {
      label: '走查体验',
      icon: Search,
      prompt: '帮我做一次界面视觉与交互走查，先了解当前页面内容和发现的别扭之处。',
    },
    {
      label: '规范组件',
      icon: Sparkles,
      prompt: '帮我梳理组件状态与样式规范，先确认组件用途、变体和交互场景。',
    },
    {
      label: '打磨文案',
      icon: Pencil,
      prompt: '帮我优化界面标题、按钮、空态或错误提示文案，先告诉我想表达的场景。',
    },
  ],
  内容运营专员: [
    {
      label: '撰写文案',
      icon: Pencil,
      prompt: '帮我撰写一篇推广或产品内容文案，先确认发布渠道、目标读者和核心卖点。',
    },
    {
      label: '策划选题',
      icon: Sparkles,
      prompt: '帮我策划一组内容选题与传播方向，先了解当前阶段目标和受众特点。',
    },
    {
      label: '改写润色',
      icon: FileText,
      prompt: '帮我改写或润色已有文稿，先询问原文内容、目标语气和发布场景。',
    },
    {
      label: '复盘数据',
      icon: BarChart3,
      prompt: '帮我分析内容表现并提出优化建议，先了解过往数据表现和预期目标。',
    },
  ],
  'DevOps 工程师': [
    {
      label: '配置流水线',
      icon: Wrench,
      prompt: '帮我设计或调整 CI/CD 构建发布流程，先确认代码栈、构建步骤和部署目标。',
    },
    {
      label: '排查构建',
      icon: Bug,
      prompt: '帮我排查构建失败或部署流水线卡顿，先了解报错日志和最近变更。',
    },
    {
      label: '整理镜像',
      icon: Layers,
      prompt: '帮我优化容器镜像构建与运行配置，先了解基础环境、体积或启动诉求。',
    },
    {
      label: '制定发布',
      icon: Check,
      prompt: '帮我规划发布变更与回滚检查清单，先确认发布范围和环境依赖。',
    },
  ],
  运维工程师: [
    {
      label: '排查告警',
      icon: Bug,
      prompt: '帮我定位线上告警或服务异常，先了解告警现象、影响范围和最近变更。',
    },
    {
      label: '分析日志',
      icon: Search,
      prompt: '帮我分析系统日志与报错线索，先询问日志片段、时间点和上下文。',
    },
    {
      label: '规划容量',
      icon: BarChart3,
      prompt: '帮我评估系统资源水位与扩容方案，先了解当前负载特征和瓶颈点。',
    },
    {
      label: '梳理预案',
      icon: FileText,
      prompt: '帮我编写故障应急或日常巡检预案，先确认覆盖的服务和关键风险。',
    },
  ],
  项目管理员: [
    {
      label: '制定排期',
      icon: Check,
      prompt: '帮我拆分项目里程碑与任务排期，先确认目标节点、参与角色和依赖关系。',
    },
    {
      label: '同步进展',
      icon: FileText,
      prompt: '帮我整理项目周报或阶段进度同步，先询问当前进展、阻塞项和下周计划。',
    },
    {
      label: '识别风险',
      icon: Search,
      prompt: '帮我梳理项目推进中的风险与卡点，先了解当前阶段目标和主要担忧。',
    },
    {
      label: '整理纪要',
      icon: MessageSquare,
      prompt: '帮我把会议沟通内容整理成结论与待办，先询问原始记录和责任分工。',
    },
  ],
  群聊答疑专员: [
    {
      label: '拟定回复',
      icon: MessageSquare,
      prompt: '帮我起草清晰礼貌的群聊答疑回复，先了解对方提问内容和我想传达的结论。',
    },
    {
      label: '提炼问题',
      icon: Search,
      prompt: '帮我从一段群聊记录中提炼真实诉求与待办，先询问相关对话内容。',
    },
    {
      label: '整理问答',
      icon: FileText,
      prompt: '帮我把高频疑问整理成常见问答条目，先确认覆盖主题和适用读者。',
    },
    {
      label: '梳理公告',
      icon: Pencil,
      prompt: '帮我撰写面向群成员的通知或说明，先确认发布目的、重点事项和时间节点。',
    },
  ],
  数字分身: [
    {
      label: '起草回复',
      icon: MessageSquare,
      prompt: '帮我按我的表达习惯起草一段消息或邮件回复，先了解沟通对象和背景。',
    },
    {
      label: '整理想法',
      icon: Pencil,
      prompt: '帮我把零碎想法整理成条理清晰的表达，先听我说说原始要点。',
    },
    {
      label: '梳理日程',
      icon: Check,
      prompt: '帮我盘点当前待办并排定处理优先级，先询问今天需要处理哪些事。',
    },
    {
      label: '提炼纪要',
      icon: FileText,
      prompt: '帮我汇总一段资料或沟通中的重点与后续动作，先确认输入内容和关注方向。',
    },
  ],
};

export function welcomeSuggestionsFor(agent: AgentSummary | null): readonly WelcomeSuggestion[] {
  if (!agent || agent.isDefault) return defaultSuggestions;
  const role = agent.role?.trim();
  if (!role) return fallbackSuggestions;
  if (Object.hasOwn(roleSuggestions, role)) {
    return roleSuggestions[role as (typeof AGENT_ROLES)[number]];
  }
  return fallbackSuggestions;
}

export function WelcomeState({ agent }: { agent: AgentSummary | null }) {
  if (!agent || agent.isDefault) {
    return (
      <div className="flex w-full flex-col gap-6 py-10 sm:py-12">
        <div className="flex flex-wrap items-center gap-4 sm:gap-5">
          <img
            src="/brand/pace-chat-woodworker.svg"
            alt=""
            aria-hidden="true"
            width={916}
            height={637}
            className="h-auto w-24 shrink-0 object-contain"
          />
          <h2 className="min-w-0 flex-1 text-2xl font-medium tracking-[-0.02em] text-fg">
            今天想完成什么？
          </h2>
        </div>
      </div>
    );
  }

  const role = agent.role?.trim();

  return (
    <div className="flex w-full flex-col gap-6 py-10 sm:py-12">
      <div className="flex flex-wrap items-center gap-4 sm:gap-5">
        <AgentAvatar agent={agent} className="size-12 ring-1 ring-line" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 break-words text-2xl font-medium tracking-[-0.02em] text-fg">
              {agent.name}
            </h2>
            {role && role !== agent.name.trim() ? <Badge variant="secondary">{role}</Badge> : null}
          </div>
          <p className="min-w-0 max-w-[65ch] break-words line-clamp-2 text-sm text-muted-foreground">
            {agent.description.trim() || '今天想交给我什么任务？'}
          </p>
        </div>
      </div>
    </div>
  );
}
