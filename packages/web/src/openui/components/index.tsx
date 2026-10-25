import { OPENUI_COMPONENT_NAMES } from '@agentport/shared';
import type { ComponentType } from 'react';
import {
  AreaChartRenderer,
  BarChartRenderer,
  HorizontalBarChartRenderer,
  LineChartRenderer,
  PieChartRenderer,
  PointRenderer,
  RadarChartRenderer,
  RadialChartRenderer,
  ScatterChartRenderer,
  ScatterSeriesRenderer,
  SeriesRenderer,
  SingleStackedBarChartRenderer,
  SliceRenderer,
} from './charts.js';
import {
  Callout,
  CodeBlock,
  ImageBlock,
  ImageGallery,
  ImageRenderer,
  ImageText,
  ImageTextLarge,
  MarkDownRenderer,
  Tag,
  TagBlock,
  TextCallout,
  TextContentRenderer,
} from './content.js';
import {
  ColRenderer,
  CompositeCardBlockRenderer,
  ContextCardBlockRenderer,
  EditableTableRenderer,
  MetricIndicatorInlineRenderer,
  MetricIndicatorWithStrikethroughRenderer,
  OverviewCardBlockRenderer,
  SnippetCardBlockRenderer,
  TableRenderer,
  VisualCardBlockRenderer,
} from './data.js';
import {
  ButtonRenderer,
  ButtonsRenderer,
  CheckBoxGroupRenderer,
  CheckBoxItemRenderer,
  ChipItemRenderer,
  ChipsRenderer,
  DatePickerRenderer,
  FormControlRenderer,
  FormRenderer,
  IconButtonRenderer,
  InputRenderer,
  LabelRenderer,
  OptionCardRenderer,
  OptionCardsRenderer,
  RadioGroupRenderer,
  RadioItemRenderer,
  SelectItemRenderer,
  SelectRenderer,
  SliderRenderer,
  SwitchGroupRenderer,
  SwitchItemRenderer,
  TextAreaRenderer,
} from './forms.js';
import {
  AccordionRenderer,
  BoldTextRenderer,
  CardHeaderRenderer,
  CardRenderer,
  CarouselRenderer,
  EntityListRenderer,
  FollowUpBlockRenderer,
  IconRenderer,
  IconTextRenderer,
  InlineHeaderRenderer,
  ListRenderer,
  SectionBlockRenderer,
  SeparatorRenderer,
  StepsRenderer,
  TabsRenderer,
  TextRenderer,
} from './layout.js';
import type { RenderProps } from './shared.js';

/**
 * OpenUI 组件名 → 项目实现。键必须与 shared 生成的 `OPENUI_COMPONENT_NAMES`
 * 一一对应：缺一个，模型生成到该组件时就会静默渲染成 null。
 */

type AnyRenderer = ComponentType<RenderProps<never>>;

const RENDERERS: Record<string, AnyRenderer> = {
  // Content
  TextContent: TextContentRenderer,
  MarkDownRenderer,
  CardHeader: CardHeaderRenderer,
  Callout,
  TextCallout,
  CodeBlock,
  Image: ImageRenderer,
  ImageBlock,
  ImageGallery,
  Separator: SeparatorRenderer,
  // Inline text
  InlineHeader: InlineHeaderRenderer,
  Icon: IconRenderer,
  Text: TextRenderer,
  BoldText: BoldTextRenderer,
  IconText: IconTextRenderer,
  ImageText,
  ImageTextLarge,
  Tag,
  TagBlock,
  // Charts — 虚拟组件也要有实现，父图表通过 renderNode 之外的方式读取数据
  Series: SeriesRenderer,
  Slice: SliceRenderer,
  Point: PointRenderer,
  ScatterSeries: ScatterSeriesRenderer,
  BarChart: BarChartRenderer,
  LineChart: LineChartRenderer,
  AreaChart: AreaChartRenderer,
  HorizontalBarChart: HorizontalBarChartRenderer,
  RadarChart: RadarChartRenderer,
  PieChart: PieChartRenderer,
  RadialChart: RadialChartRenderer,
  SingleStackedBarChart: SingleStackedBarChartRenderer,
  ScatterChart: ScatterChartRenderer,
  // Table
  Col: ColRenderer,
  Table: TableRenderer,
  EditableTable: EditableTableRenderer,
  // Cards
  Card: CardRenderer,
  SnippetCardBlock: SnippetCardBlockRenderer,
  SnippetCardItem: () => null,
  OverviewCardBlock: OverviewCardBlockRenderer,
  OverviewCardItem: () => null,
  ContextCardBlock: ContextCardBlockRenderer,
  ContextCardItem: () => null,
  CompositeCardBlock: CompositeCardBlockRenderer,
  CompositeCardItem: () => null,
  VisualCardBlock: VisualCardBlockRenderer,
  VisualCardItem: () => null,
  MetricIndicatorInline: MetricIndicatorInlineRenderer,
  MetricIndicatorWithStrikethrough: MetricIndicatorWithStrikethroughRenderer,
  // Layout
  Tabs: TabsRenderer,
  TabItem: () => null,
  Accordion: AccordionRenderer,
  AccordionItem: () => null,
  SectionBlock: SectionBlockRenderer,
  SectionItem: () => null,
  Carousel: CarouselRenderer,
  Steps: StepsRenderer,
  StepsItem: () => null,
  ListBlock: ListRenderer,
  ListItem: () => null,
  FollowUpBlock: FollowUpBlockRenderer,
  FollowUpItem: () => null,
  EntityList: EntityListRenderer,
  // Forms
  Form: FormRenderer,
  FormControl: FormControlRenderer,
  Label: LabelRenderer,
  Input: InputRenderer,
  TextArea: TextAreaRenderer,
  Select: SelectRenderer,
  SelectItem: SelectItemRenderer,
  DatePicker: DatePickerRenderer,
  Slider: SliderRenderer,
  CheckBoxGroup: CheckBoxGroupRenderer,
  CheckBoxItem: CheckBoxItemRenderer,
  RadioGroup: RadioGroupRenderer,
  RadioItem: RadioItemRenderer,
  SwitchGroup: SwitchGroupRenderer,
  SwitchItem: SwitchItemRenderer,
  Chips: ChipsRenderer,
  ChipItem: ChipItemRenderer,
  OptionCards: OptionCardsRenderer,
  OptionCard: OptionCardRenderer,
  // Buttons
  Button: ButtonRenderer,
  Buttons: ButtonsRenderer,
  IconButton: IconButtonRenderer,
};

export const OPENUI_RENDERERS: Record<
  string,
  ComponentType<RenderProps<unknown>>
> = RENDERERS as Record<string, ComponentType<RenderProps<unknown>>>;

/** 契约里有、但 RENDERERS 漏掉的名字；测试与运行时都靠它发现缺口。 */
export function missingOpenUiRenderers(): string[] {
  return OPENUI_COMPONENT_NAMES.filter((name) => !(name in RENDERERS));
}
