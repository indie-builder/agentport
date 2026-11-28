import { type OpenUiToolDescriptor, openUiPromptOptions } from '@agentport/shared';
import {
  generateSystemPrompt,
  type LibrarySpec,
  type SystemPromptSpec,
  type ToolSpec,
} from '@openuidev/lang-core';
import { LRUCache } from 'lru-cache';
import spec from './generated/openui.spec.json' with { type: 'json' };

const cache = new LRUCache<string, string>({ max: 32 });

const INLINE_PREAMBLE = [
  'You are an AI assistant that can respond in plain Markdown or embed interactive UI using `openui-lang`, a declarative UI language.',
  'Only code wrapped in a ```openui-lang ... ``` fenced block is rendered as UI — never output bare, unfenced openui-lang code.',
  'The Examples below show only the inner program body; whenever you output UI, always wrap it in a ```openui-lang fence.',
  'Reply in plain Markdown for simple questions or pure explanations. When rendering structured UI, start each fenced block with `root = Card(...)` (or emit only changed/new statements when editing an existing UI).',
].join(' ');

const TOOL_EXAMPLE_PROGRAM = [
  'root = Card([header, controls, tbl])',
  '$status = "open"',
  '$newTitle = ""',
  'tickets = Query("list_tickets", { status: $status }, { rows: [{ title: "Sample ticket", status: "open" }] })',
  'createTicket = Mutation("create_ticket", { title: $newTitle, status: $status })',
  'header = CardHeader("Tickets", "Live query with filter and creation")',
  'controls = Form("ticket-controls", formBtns, [statusField, titleField])',
  'statusField = FormControl("Status", Select("status", [stOpen, stClosed], null, null, $status))',
  'stOpen = SelectItem("open", "Open")',
  'stClosed = SelectItem("closed", "Closed")',
  'titleField = FormControl("New Ticket", Input("title", "Enter title", "text", { required: true }, $newTitle))',
  'formBtns = Buttons([createBtn, refreshBtn], "row")',
  'createBtn = Button("Create", Action([@Run(createTicket), @Run(tickets), @Reset($newTitle)]), "primary")',
  'refreshBtn = Button("Refresh", Action([@Run(tickets)]), "secondary")',
  'tbl = Table([Col("Title", tickets.rows.title, "string"), Col("Status", tickets.rows.status, "string")])',
].join('\n');

const TOOL_EXAMPLES = [
  `Example 6 — Live data with Query, filter binding, and Mutation refresh:\n\n${TOOL_EXAMPLE_PROGRAM}`,
];

/** lang-core 的 ToolSpec 要求 outputSchema；平台侧可以没有，用 object 占位以保留入参签名。 */
function toToolSpec(tool: OpenUiToolDescriptor): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? { type: 'object' },
  };
}

export function openuiSystemPrompt(tools: OpenUiToolDescriptor[] = []): string {
  const key = tools
    .map(
      (tool) =>
        `${tool.name}:${tool.description}:${JSON.stringify(tool.inputSchema ?? null)}:${JSON.stringify(tool.outputSchema ?? null)}`,
    )
    .sort()
    .join('|');
  const cached = cache.peek(key);
  if (cached !== undefined) return cached;

  const { tools: _ignored, examples, ...options } = openUiPromptOptions();
  const input: SystemPromptSpec = {
    library: spec as unknown as LibrarySpec,
    promptOptions: {
      ...options,
      preamble: INLINE_PREAMBLE,
      examples,
      ...(tools.length === 0 ? {} : { tools: tools.map(toToolSpec), toolExamples: TOOL_EXAMPLES }),
    },
  };
  const prompt = generateSystemPrompt(input);
  cache.set(key, prompt);
  return prompt;
}
