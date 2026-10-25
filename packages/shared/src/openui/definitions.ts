import { z } from 'zod';
import type { OpenUiDefinedComponent, OpenUiDefinitions, OpenUiKit } from './kit.js';
import {
  OPENUI_COMPONENT_GROUPS,
  OPENUI_COMPONENT_NAMES,
  OPENUI_DESCRIPTIONS,
  OPENUI_ROOT,
  type OpenUiComponentName,
} from './meta.js';

/**
 * 官方 chat 库 84 个组件的真实 Zod 契约，逐字段照抄官方源码
 * （@openuidev/react-ui 0.18.1 `src/genui-lib/**`）。
 *
 * 不写成生成的 JSON Schema 再反编译：反编译会丢 `default`、`min(2)`、
 * `z.record` 的值类型、`.refine` 语义约束，以及 `reactive()` 的绑定标记。
 *
 * `shared` 只依赖 zod；两端各自注入官方原语：
 * - web：react-lang 的 defineComponent / action / reactive（含渲染器）；
 * - 服务端不调用本函数，只读官方 CLI 生成的 LibrarySpec。
 *
 * 参数按 props 的 key 顺序定位，字段顺序与组件注册顺序都是线格式，不得重排。
 */

type AnySchema = z.core.$ZodType;

/** 子组件联合：z.union 至少要两个成员。 */
function refUnion(options: AnySchema[]): AnySchema {
  const [first, second, ...rest] = options;
  if (first === undefined || second === undefined) {
    throw new Error('OpenUI union needs at least two members');
  }
  return z.union([first, second, ...rest]);
}

const rules = z
  .object({
    required: z.boolean().optional(),
    email: z.boolean().optional(),
    url: z.boolean().optional(),
    numeric: z.boolean().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().optional(),
    maxLength: z.number().optional(),
    pattern: z.string().optional(),
  })
  .optional();

const trend = z.object({ direction: z.enum(['up', 'down']), value: z.number() });

const entityRow = z.object({
  left: z.string(),
  right: z.string(),
  rightVariant: z.enum(['text', 'number']).default('text'),
});

/** 构建整份定义；`C` 是渲染器类型，web 传 react-lang 的 ComponentRenderer。 */
export function createOpenUiDefinitions<C>(
  kit: OpenUiKit<C>,
  renderers: Record<string, C> = {},
): OpenUiDefinitions<C> {
  const def = <T extends z.core.$ZodObject>(
    name: OpenUiComponentName,
    props: T,
  ): OpenUiDefinedComponent<C, T> =>
    kit.defineComponent({
      name,
      description: OPENUI_DESCRIPTIONS[name],
      props,
      component: renderers[name] as C,
    });

  // ── 内容 ────────────────────────────────────────────────────────────────────
  const Icon = def(
    'Icon',
    z.object({
      name: z
        .string()
        .describe("lucide-react icon name in kebab-case (e.g. 'circle-check', 'rocket')."),
      category: z
        .string()
        .optional()
        .describe(
          "Optional icon category (e.g. 'finance', 'charts', 'security', 'travel', 'people', 'time') used to pick a topical fallback icon when `name` doesn't resolve.",
        ),
    }),
  );
  const Image = def('Image', z.object({ alt: z.string(), src: z.string().optional() }));
  const ImageBlock = def('ImageBlock', z.object({ src: z.string(), alt: z.string().optional() }));
  const ImageGallery = def(
    'ImageGallery',
    z.object({
      images: z.array(
        z.object({ src: z.string(), alt: z.string().optional(), details: z.string().optional() }),
      ),
    }),
  );
  const TextContent = def(
    'TextContent',
    z.object({
      text: z.string(),
      size: z.enum(['small', 'default', 'large', 'small-heavy', 'large-heavy']).optional(),
    }),
  );
  const MarkDownRenderer = def(
    'MarkDownRenderer',
    z.object({ textMarkdown: z.string(), variant: z.enum(['clear', 'card', 'sunk']).optional() }),
  );
  const CardHeader = def(
    'CardHeader',
    z.object({ title: z.string().optional(), subtitle: z.string().optional() }),
  );
  const Callout = def(
    'Callout',
    z.object({
      variant: z.enum(['info', 'warning', 'error', 'success', 'neutral']),
      title: z.string(),
      description: z.string(),
      // 官方是 reactive：模型可以写 $visible 并在 3 秒后由运行时置 false。
      visible: kit.reactive(z.boolean().optional()),
    }),
  );
  const TextCallout = def(
    'TextCallout',
    z.object({
      variant: z.enum(['neutral', 'info', 'warning', 'success', 'danger']).optional(),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
  );
  const CodeBlock = def('CodeBlock', z.object({ language: z.string(), codeString: z.string() }));
  const Separator = def(
    'Separator',
    z.object({
      orientation: z.enum(['horizontal', 'vertical']).optional(),
      decorative: z.boolean().optional(),
    }),
  );

  // ── 图表 ────────────────────────────────────────────────────────────────────
  const Series = def('Series', z.object({ category: z.string(), values: z.array(z.number()) }));
  const chart2D = <V extends string>(variants: readonly [V, ...V[]]) =>
    z.object({
      labels: z.array(z.string()),
      series: z.array(Series.ref),
      variant: z.enum(variants).optional(),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
      height: z.number().optional(),
    });
  const BarChart = def('BarChart', chart2D(['grouped', 'stacked']));
  const LineChart = def('LineChart', chart2D(['linear', 'natural', 'step']));
  const AreaChart = def('AreaChart', chart2D(['linear', 'natural', 'step']));
  const RadarChart = def(
    'RadarChart',
    z.object({ labels: z.array(z.string()), series: z.array(Series.ref) }),
  );
  const HorizontalBarChart = def(
    'HorizontalBarChart',
    z.object({
      labels: z.array(z.string()),
      series: z.array(Series.ref),
      variant: z.enum(['grouped', 'stacked']).optional(),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
    }),
  );
  const PieChart = def(
    'PieChart',
    z.object({
      labels: z.array(z.string()),
      values: z.array(z.number()),
      variant: z.enum(['pie', 'donut']).optional(),
      appearance: z.enum(['circular', 'semiCircular']).optional(),
    }),
  );
  const RadialChart = def(
    'RadialChart',
    z.object({ labels: z.array(z.string()), values: z.array(z.number()) }),
  );
  const SingleStackedBarChart = def(
    'SingleStackedBarChart',
    z.object({ labels: z.array(z.string()), values: z.array(z.number()) }),
  );
  const Slice = def('Slice', z.object({ category: z.string(), value: z.number() }));
  const Point = def('Point', z.object({ x: z.number(), y: z.number(), z: z.number().optional() }));
  const ScatterSeries = def(
    'ScatterSeries',
    z.object({ name: z.string(), points: z.array(Point.ref) }),
  );
  const ScatterChart = def(
    'ScatterChart',
    z.object({
      datasets: z.array(ScatterSeries.ref),
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
    }),
  );

  // ── 表格与数据展示 ──────────────────────────────────────────────────────────
  const Col = def(
    'Col',
    z.object({
      label: z.string(),
      data: z.any(),
      type: z.enum(['string', 'number', 'action']).optional(),
    }),
  );
  const Table = def('Table', z.object({ columns: z.array(Col.ref) }));
  const TagBlock = def(
    'TagBlock',
    z.object({ tags: z.array(z.string()), size: z.enum(['sm', 'md', 'lg']).optional() }),
  );
  const Tag = def(
    'Tag',
    z.object({
      text: z.string(),
      icon: z.optional(Icon.ref),
      size: z.enum(['sm', 'md', 'lg']).optional(),
      variant: z.enum(['neutral', 'info', 'success', 'warning', 'danger']).optional(),
    }),
  );

  // ── 按钮 ────────────────────────────────────────────────────────────────────
  const Button = def(
    'Button',
    z.object({
      label: z.string(),
      action: kit.action().optional(),
      variant: z.enum(['primary', 'secondary', 'tertiary']).optional(),
      type: z.enum(['normal', 'destructive']).optional(),
      size: z.enum(['extra-small', 'small', 'medium', 'large']).optional(),
    }),
  );
  const Buttons = def(
    'Buttons',
    z.object({ buttons: z.array(Button.ref), direction: z.enum(['row', 'column']).optional() }),
  );
  const IconButton = def(
    'IconButton',
    z.object({
      name: z.string(),
      icon: Icon.ref,
      action: kit.action().optional(),
      variant: z.enum(['primary', 'secondary', 'tertiary']).optional(),
      size: z.enum(['extra-small', 'small', 'medium', 'large']).optional(),
      shape: z.enum(['square', 'circle']).optional(),
    }),
  );

  // ── 列表与后续建议（卡片体里会引用，必须先声明） ────────────────────────────
  const ListItem = def(
    'ListItem',
    z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      image: z.object({ src: z.string(), alt: z.string() }).optional(),
      actionLabel: z.string().optional(),
      action: kit.action().optional(),
    }),
  );
  const ListBlock = def(
    'ListBlock',
    z.object({
      items: z.array(ListItem.ref),
      variant: z.enum(['number', 'image']).optional(),
      size: z.enum(['default', 'small']).optional(),
    }),
  );
  const FollowUpItem = def('FollowUpItem', z.object({ text: z.string() }));
  const FollowUpBlock = def('FollowUpBlock', z.object({ items: z.array(FollowUpItem.ref) }));

  // ── 表单控件 ────────────────────────────────────────────────────────────────
  const Input = def(
    'Input',
    z.object({
      name: z.string(),
      placeholder: z.string().optional(),
      type: z.enum(['text', 'email', 'password', 'number', 'url']).optional(),
      rules,
      value: kit.reactive(z.string().optional()),
    }),
  );
  const TextArea = def(
    'TextArea',
    z.object({
      name: z.string(),
      placeholder: z.string().optional(),
      rows: z.number().optional(),
      rules,
      value: kit.reactive(z.string().optional()),
    }),
  );
  const SelectItem = def('SelectItem', z.object({ value: z.string(), label: z.string() }));
  const Select = def(
    'Select',
    z.object({
      name: z.string(),
      items: z.array(SelectItem.ref),
      placeholder: z.string().optional(),
      rules,
      value: kit.reactive(z.string().optional()),
      size: z.enum(['small', 'medium', 'large']).optional(),
    }),
  );
  const DatePicker = def(
    'DatePicker',
    z.object({
      name: z.string(),
      mode: z.enum(['single', 'range']).optional(),
      rules,
      value: kit.reactive(z.unknown().optional()),
    }),
  );
  const Slider = def(
    'Slider',
    z.object({
      name: z.string(),
      variant: z.enum(['continuous', 'discrete']),
      min: z.number(),
      max: z.number(),
      step: z.number().optional(),
      defaultValue: z.array(z.number()).optional(),
      label: z.string().optional(),
      rules,
      value: kit.reactive(z.array(z.number()).optional()),
    }),
  );
  const CheckBoxItem = def(
    'CheckBoxItem',
    z.object({
      label: z.string(),
      description: z.string(),
      name: z.string(),
      defaultChecked: z.boolean().optional(),
    }),
  );
  const CheckBoxGroup = def(
    'CheckBoxGroup',
    z.object({
      name: z.string(),
      items: z.array(CheckBoxItem.ref),
      rules,
      // 值类型必须保留；反编译成 z.unknown() 会让复选框字典丢掉布尔语义。
      value: kit.reactive(z.record(z.string(), z.boolean()).optional()),
    }),
  );
  const RadioItem = def(
    'RadioItem',
    z.object({ label: z.string(), description: z.string(), value: z.string() }),
  );
  const RadioGroup = def(
    'RadioGroup',
    z.object({
      name: z.string(),
      items: z.array(RadioItem.ref),
      defaultValue: z.string().optional(),
      rules,
      value: kit.reactive(z.string().optional()),
    }),
  );
  const SwitchItem = def(
    'SwitchItem',
    z.object({
      label: z.string().optional(),
      description: z.string().optional(),
      name: z.string(),
      defaultChecked: z.boolean().optional(),
    }),
  );
  const SwitchGroup = def(
    'SwitchGroup',
    z.object({
      name: z.string(),
      items: z.array(SwitchItem.ref),
      variant: z.enum(['clear', 'card', 'sunk']).optional(),
      value: kit.reactive(z.record(z.string(), z.boolean()).optional()),
    }),
  );
  const ChipItem = def(
    'ChipItem',
    z.object({
      value: z.string(),
      label: z.string(),
      icon: z.optional(Icon.ref),
      disabled: z.boolean().optional(),
    }),
  );
  const Chips = def(
    'Chips',
    z.object({
      name: z.string(),
      type: z.enum(['single', 'multiple']).default('multiple'),
      items: z.array(ChipItem.ref).default([]),
      rules,
      defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
    }),
  );
  const OptionCard = def(
    'OptionCard',
    z.object({
      value: z.string(),
      title: z.string(),
      subtitle: z.string().optional(),
      topContent: z.union([Icon.ref, Image.ref]).optional(),
      disabled: z.boolean().optional(),
    }),
  );
  const OptionCards = def(
    'OptionCards',
    z.object({
      name: z.string(),
      type: z.enum(['single', 'multiple']).default('single'),
      items: z.array(OptionCard.ref).default([]),
      rules,
      defaultValue: z.union([z.string(), z.array(z.string())]).optional(),
    }),
  );
  const FormControl = def(
    'FormControl',
    z.object({
      label: z.string(),
      input: z.union([
        Input.ref,
        TextArea.ref,
        Select.ref,
        DatePicker.ref,
        Slider.ref,
        CheckBoxGroup.ref,
        RadioGroup.ref,
        Chips.ref,
        OptionCards.ref,
      ]),
      hint: z.string().optional(),
    }),
  );
  const Form = def(
    'Form',
    z.object({
      name: z.string(),
      buttons: Buttons.ref,
      fields: z.array(FormControl.ref).default([]),
    }),
  );

  // ── 其它布局 ────────────────────────────────────────────────────────────────
  const StepsItem = def('StepsItem', z.object({ title: z.string(), details: z.string() }));
  const Steps = def('Steps', z.object({ items: z.array(StepsItem.ref) }));
  const InlineHeader = def(
    'InlineHeader',
    z.object({ heading: z.string(), description: z.string().optional() }),
  );
  const EntityList = def(
    'EntityList',
    z
      .object({
        rows: z.array(entityRow).default([]),
        size: z.enum(['small', 'default']).default('default'),
        header: entityRow.optional(),
        footer: entityRow.optional(),
      })
      // 官方语义约束：small 不支持 header/footer。
      .refine(({ size, header, footer }) => size === 'default' || (!header && !footer), {
        message: 'EntityList size="small" does not support header or footer.',
        path: ['size'],
      }),
  );
  const EditableTable = def(
    'EditableTable',
    z.object({
      name: z.string().default(''),
      columns: z
        .array(
          z.object({
            type: z.enum(['text', 'number', 'date-single', 'select', 'url']),
            key: z.string().default('default'),
            header: z.string().default(''),
            width: z.number().optional(),
            options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
          }),
        )
        .default([]),
      data: z
        .array(
          z.object({
            id: z.string(),
            values: z.array(z.union([z.string(), z.number()])),
          }),
        )
        .default([]),
    }),
  );
  const Label = def('Label', z.object({ text: z.string() }));

  // ── 卡片内联元素 ────────────────────────────────────────────────────────────
  const inlineText = () =>
    z.object({
      variant: z.enum(['text', 'number']).default('text'),
      value: z.string(),
      subtext: z.string().optional(),
      subtextVariant: z.enum(['text', 'number', 'metric']).default('text'),
      size: z.enum(['xs', 'sm', 'md', 'lg']).default('sm'),
    });
  const Text = def('Text', inlineText());
  const BoldText = def('BoldText', inlineText());
  const IconText = def(
    'IconText',
    z.object({
      icon: Icon.ref,
      iconVariant: z
        .enum(['neutral', 'info', 'success', 'warning', 'danger', 'inverted', 'filled', 'soft'])
        .default('neutral'),
      iconSize: z.enum(['xs', 's', 'm', 'l', 'xl', 'sm', 'md', 'lg']).default('m'),
      title: z.string(),
      subtitle: z.string().optional(),
      bold: z.boolean().default(false),
      layout: z.enum(['horizontal', 'vertical']).default('horizontal'),
    }),
  );
  const ImageText = def(
    'ImageText',
    z.object({
      src: z.string(),
      alt: z.string().optional(),
      title: z.string(),
      subtitle: z.string().optional(),
      bold: z.boolean().default(false),
      layout: z.enum(['horizontal', 'vertical']).default('horizontal'),
      imageSize: z.number().optional(),
    }),
  );
  const ImageTextLarge = def(
    'ImageTextLarge',
    z.object({
      src: z.string(),
      alt: z.string().optional(),
      title: z.string(),
      subtitle: z.string().optional(),
      bold: z.boolean().default(false),
    }),
  );
  const MetricIndicatorInline = def(
    'MetricIndicatorInline',
    z.object({ value: z.string(), subtext: z.string().optional(), trend: trend.optional() }),
  );
  const MetricIndicatorWithStrikethrough = def(
    'MetricIndicatorWithStrikethrough',
    z.object({
      value: z.string(),
      subtext: z.string().optional(),
      previousValue: z.string().optional(),
      trend: trend.optional(),
    }),
  );

  // ── 卡片块：2 件起，同块结构一致 ────────────────────────────────────────────
  const cardBlock = (items: AnySchema) =>
    z.object({
      items,
      layout: z.enum(['grid', 'carousel']).default('grid'),
      responsive: z.boolean().default(true),
      action: kit.action().optional(),
      gap: z.union([z.number(), z.string()]).optional(),
    });
  const SnippetCardItem = def(
    'SnippetCardItem',
    z.object({
      id: z.string().optional(),
      lhs: z.union([IconText.ref, ImageText.ref]),
      rhs: z.union([Text.ref, BoldText.ref]).optional(),
    }),
  );
  const SnippetCardBlock = def(
    'SnippetCardBlock',
    z.object({
      items: z.array(SnippetCardItem.ref).min(2),
      layout: z.enum(['grid']).default('grid'),
      responsive: z.boolean().default(true),
      action: kit.action().optional(),
      gap: z.union([z.number(), z.string()]).optional(),
    }),
  );
  const OverviewCardItem = def(
    'OverviewCardItem',
    z.object({
      id: z.string().optional(),
      top: z.union([IconText.ref, ImageText.ref, Text.ref]),
      bottom: z.optional(MetricIndicatorInline.ref),
    }),
  );
  const OverviewCardBlock = def(
    'OverviewCardBlock',
    cardBlock(z.array(OverviewCardItem.ref).min(2)),
  );
  const ContextCardItem = def(
    'ContextCardItem',
    z.object({
      id: z.string().optional(),
      title: z.union([z.string(), Tag.ref]),
      body: z.string().optional(),
      bgColor: z.enum(['gray']).optional(),
      bgImageSrc: z.string().optional(),
      bgImageAlt: z.string().optional(),
    }),
  );
  const ContextCardBlock = def('ContextCardBlock', cardBlock(z.array(ContextCardItem.ref).min(2)));
  const CompositeCardItem = def(
    'CompositeCardItem',
    z.object({
      id: z.string().optional(),
      header: z
        .union([IconText.ref, ImageText.ref, ImageTextLarge.ref, Text.ref, Image.ref])
        .optional(),
      body: z
        .array(
          z.union([
            Text.ref,
            BoldText.ref,
            MetricIndicatorInline.ref,
            IconText.ref,
            Image.ref,
            AreaChart.ref,
            BarChart.ref,
            LineChart.ref,
            ListBlock.ref,
            TagBlock.ref,
            EntityList.ref,
          ]),
        )
        .default([]),
      footer: z
        .object({
          price: z.union([BoldText.ref, MetricIndicatorWithStrikethrough.ref]).optional(),
          button: z.optional(Button.ref),
        })
        .optional(),
    }),
  );
  const CompositeCardBlock = def(
    'CompositeCardBlock',
    cardBlock(z.array(CompositeCardItem.ref).min(2)),
  );
  const VisualCardItem = def(
    'VisualCardItem',
    z.object({
      body: BoldText.ref,
      id: z.string().optional(),
      bgImageSrc: z.string().optional(),
      tag: z.optional(Tag.ref),
      bgImageAlt: z.string().optional(),
    }),
  );
  const VisualCardBlock = def('VisualCardBlock', cardBlock(z.array(VisualCardItem.ref).min(2)));

  // ── 对话容器 ────────────────────────────────────────────────────────────────
  // 嵌套内容联合：不含 SectionBlock（它自身不能嵌套），但含列表与后续建议。
  const nestedContent = [
    TextContent.ref,
    MarkDownRenderer.ref,
    CardHeader.ref,
    Callout.ref,
    TextCallout.ref,
    CodeBlock.ref,
    Image.ref,
    ImageBlock.ref,
    ImageGallery.ref,
    Separator.ref,
    HorizontalBarChart.ref,
    RadarChart.ref,
    PieChart.ref,
    RadialChart.ref,
    SingleStackedBarChart.ref,
    ScatterChart.ref,
    AreaChart.ref,
    BarChart.ref,
    LineChart.ref,
    Table.ref,
    TagBlock.ref,
    Form.ref,
    Buttons.ref,
    IconButton.ref,
    Steps.ref,
    InlineHeader.ref,
    EntityList.ref,
    EditableTable.ref,
    SnippetCardBlock.ref,
    OverviewCardBlock.ref,
    ContextCardBlock.ref,
    CompositeCardBlock.ref,
    VisualCardBlock.ref,
    ListBlock.ref,
    FollowUpBlock.ref,
  ];
  const NestedContent = refUnion(nestedContent);

  const AccordionItem = def(
    'AccordionItem',
    z.object({ value: z.string(), trigger: z.string(), content: z.array(NestedContent) }),
  );
  const Accordion = def('Accordion', z.object({ items: z.array(AccordionItem.ref) }));
  const TabItem = def(
    'TabItem',
    z.object({
      value: z.string(),
      trigger: z.string(),
      content: z.array(refUnion([...nestedContent, Accordion.ref])),
    }),
  );
  const Tabs = def('Tabs', z.object({ items: z.array(TabItem.ref) }));
  const Carousel = def(
    'Carousel',
    z.object({
      children: z.array(z.array(NestedContent)),
      variant: z.enum(['card', 'sunk']).optional(),
    }),
  );
  const SectionItem = def(
    'SectionItem',
    z.object({
      value: z.string(),
      trigger: z.string(),
      content: z.array(refUnion([...nestedContent, Tabs.ref, Accordion.ref])),
    }),
  );
  const SectionBlock = def(
    'SectionBlock',
    z.object({ sections: z.array(SectionItem.ref), isFoldable: z.boolean().optional() }),
  );
  const Card = def(
    'Card',
    z.object({
      children: z.array(refUnion([...nestedContent, SectionBlock.ref, Tabs.ref, Carousel.ref])),
      sources: z
        .array(z.object({ url: z.string().optional(), title: z.string(), sourceName: z.string() }))
        .optional(),
    }),
  );

  // 官方注册顺序是线格式的一部分：提示词、$defs 与 spec 都按它排列。
  const byName = new Map<string, OpenUiDefinedComponent<C>>(
    [
      Icon,
      Image,
      ImageBlock,
      ImageGallery,
      TextContent,
      MarkDownRenderer,
      CardHeader,
      Callout,
      TextCallout,
      CodeBlock,
      Separator,
      Series,
      BarChart,
      LineChart,
      AreaChart,
      RadarChart,
      HorizontalBarChart,
      PieChart,
      RadialChart,
      SingleStackedBarChart,
      Slice,
      Point,
      ScatterSeries,
      ScatterChart,
      Col,
      Table,
      TagBlock,
      Tag,
      Button,
      Buttons,
      IconButton,
      ListItem,
      ListBlock,
      FollowUpItem,
      FollowUpBlock,
      Input,
      TextArea,
      SelectItem,
      Select,
      DatePicker,
      Slider,
      CheckBoxItem,
      CheckBoxGroup,
      RadioItem,
      RadioGroup,
      SwitchItem,
      SwitchGroup,
      ChipItem,
      Chips,
      OptionCard,
      OptionCards,
      FormControl,
      Form,
      StepsItem,
      Steps,
      InlineHeader,
      EntityList,
      EditableTable,
      Label,
      Text,
      BoldText,
      IconText,
      ImageText,
      ImageTextLarge,
      MetricIndicatorInline,
      MetricIndicatorWithStrikethrough,
      SnippetCardItem,
      SnippetCardBlock,
      OverviewCardItem,
      OverviewCardBlock,
      ContextCardItem,
      ContextCardBlock,
      CompositeCardItem,
      CompositeCardBlock,
      VisualCardItem,
      VisualCardBlock,
      AccordionItem,
      Accordion,
      TabItem,
      Tabs,
      Carousel,
      SectionItem,
      SectionBlock,
      Card,
    ].map((component) => [component.name, component]),
  );

  const missing = OPENUI_COMPONENT_NAMES.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`OpenUI definitions missing components: ${missing.join(', ')}`);
  }
  const components = OPENUI_COMPONENT_NAMES.map((name) => {
    const component = byName.get(name);
    if (component === undefined) throw new Error(`OpenUI component ${name} is missing`);
    return component;
  });

  return {
    root: OPENUI_ROOT,
    components,
    componentGroups: OPENUI_COMPONENT_GROUPS.map((group) => ({
      name: group.name,
      components: [...group.components],
      ...('notes' in group && group.notes !== undefined ? { notes: [...group.notes] } : {}),
    })),
  };
}
