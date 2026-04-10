/**
 * Deep Agent Research Graph — a LangGraph StateGraph that orchestrates
 * multi-step research with inline visual output.
 *
 * Graph structure:
 *   START → planner → researcher ⟲ (loop) → synthesizer → END
 */

import { StateGraph, START, END } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { AIMessageChunk } from '@langchain/core/messages';
import { ResearchState } from './state';
import type { StreamBridge } from './streamBridge';
import { setToolBridge } from './tools';

/** Token-count estimate: ~4 chars per token. */
const CHARS_PER_TOKEN = 4;
/** Auto-summarize when accumulated notes + messages exceed this char count (~12K tokens). */
const SUMMARIZE_THRESHOLD = 50_000;

/** Create a system message with optional Anthropic prompt caching. */
function cachedSystemMessage(content: string, isAnthropic: boolean): SystemMessage {
  if (isAnthropic) {
    return new SystemMessage({
      content,
      additional_kwargs: { cache_control: { type: 'ephemeral' } },
    });
  }
  return new SystemMessage(content);
}

const PLAN_EXTRACTION_PROMPT = `Based on the user's research question, create a research plan with 3-7 specific steps.
Output ONLY a JSON array of step labels, like:
["Step 1 label", "Step 2 label", "Step 3 label"]

Be specific about what data to gather in each step. Do NOT output anything else.`;

const SYNTHESIS_PROMPT = `You are synthesizing research findings into a final analytical report with rich inline visuals.

CRITICAL: You MUST output structured JSON fenced code blocks for ALL data. NEVER use matplotlib, plotly, Python, or any executable code for visuals.

VISUAL TYPES — Output as fenced code blocks with these exact formats:

\`\`\`metric
{"title":"Q4 Summary","columns":3,"metrics":[{"label":"Revenue","value":"$94.9B","trend":"+6.1%","trendDirection":"up"}]}
\`\`\`

\`\`\`chart
{"type":"bar","title":"Revenue by Segment","labels":["iPhone","Services","Mac"],"datasets":[{"label":"Revenue ($B)","data":[46.2,26.3,7.7]}]}
\`\`\`

\`\`\`table
{"columns":["Segment","Revenue","Growth"],"rows":[["iPhone","$46.2B","+2.1%"],["Services","$26.3B","+14.2%"]]}
\`\`\`

\`\`\`kpi
{"label":"Total Revenue","value":"$94.9B","trend":"+6.1%","trendDirection":"up"}
\`\`\`

\`\`\`comparison
{"title":"Company Comparison","columns":["Revenue","Growth"],"items":[{"label":"Apple","values":{"Revenue":"$394B","Growth":"6.1%"}},{"label":"Google","values":{"Revenue":"$350B","Growth":"13.4%"},"highlight":true}]}
\`\`\`

\`\`\`timeline
{"title":"Key Events","events":[{"date":"2024-06","title":"WWDC","description":"AI features announced","type":"milestone"}]}
\`\`\`

\`\`\`gauge
{"title":"Confidence","value":78,"max":100,"label":"Buy Rating","unit":"%"}
\`\`\`

\`\`\`citation
{"title":"Sources","sources":[{"title":"Q4 Filing","source":"SEC","date":"2025-11","reliability":"high","snippet":"Revenue of $94.9B"}]}
\`\`\`

MANDATORY RULES:
- EVERY dataset MUST appear as BOTH a visual (chart/metric/comparison) AND a \`\`\`table block
- Include at MINIMUM: 1 metric grid, 2 charts, 1 table, 1 citation block
- NEVER output Python, JavaScript, or executable code — use the JSON blocks above
- NEVER use matplotlib, plotly, seaborn, or any charting library
- Use markdown for narrative text between visuals
- Chart types: line (time series), bar (comparisons), pie (proportions), area, scatter, radar`;

/**
 * Build the research graph with the given LLM, tools, and streaming bridge.
 */
export function buildResearchGraph(
  llm: BaseChatModel,
  tools: StructuredToolInterface[],
  bridge: StreamBridge,
  systemPrompt: string,
  options?: { isAnthropic?: boolean }
) {
  const isAnthropic = options?.isAnthropic ?? false;
  if (isAnthropic) {
    console.log('[DeepAgent] Anthropic prompt caching enabled');
  }
  const llmWithTools = llm.bindTools(tools);

  // Wire the StreamBridge into tools that need to emit UI events (write_todos etc.)
  setToolBridge(bridge);

  // ─── Planner Node ─────────────────────────────────────────────────
  async function plannerNode(state: typeof ResearchState.State): Promise<Partial<typeof ResearchState.State>> {
    bridge.emitStepStarted('Planning research');
    bridge.emitActivity('planning', 'Analyzing question and creating research plan...');

    const response = await llm.invoke([
      cachedSystemMessage(PLAN_EXTRACTION_PROMPT, isAnthropic),
      new HumanMessage(state.question),
    ]);

    let plan: string[] = [];
    const text = typeof response.content === 'string' ? response.content : '';

    // Extract JSON array from the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown;
        if (Array.isArray(parsed)) {
          plan = parsed.filter((s): s is string => typeof s === 'string');
        }
      } catch {
        // Fallback: split by newlines
        plan = text
          .split('\n')
          .map((l) => l.replace(/^[\d.)\-*]+\s*/, '').trim())
          .filter((l) => l.length > 0);
      }
    }

    if (plan.length === 0) {
      plan = ['Gather relevant data', 'Analyze findings', 'Produce summary with visuals'];
    }

    // Emit the plan as content so it shows in the chat
    bridge.startNewMessage();
    const planText =
      `## Research Plan\n\n` + plan.map((step, i) => `${String(i + 1)}. ${step}`).join('\n') + '\n\n---\n\n';
    bridge.emitContentDelta(planText);

    // Emit task progress (agentic generative UI)
    bridge.emitTaskProgress(
      plan.map((step) => ({ description: step, status: 'pending' as const })),
      'Research Plan'
    );

    // HITL: let user confirm/modify the plan steps
    const hitlResponse = await bridge.emitInterrupt(
      plan.map((step) => ({ description: step, status: 'enabled' as const })),
      'Review the research steps. Uncheck any you want to skip, then confirm.'
    );

    let confirmedPlan = plan;
    if (!hitlResponse.accepted) {
      // User rejected — use a minimal fallback plan
      confirmedPlan = ['Gather relevant data', 'Produce summary with visuals'];
    } else if (hitlResponse.steps) {
      confirmedPlan = hitlResponse.steps.map((s) => s.description);
    }

    bridge.emitStepFinished('Planning research');

    // Emit state for progress bar
    bridge.emitStateSnapshot({
      progress: 10,
      currentPhase: 'planning',
      findings: [],
      dataSources: [],
    });

    return {
      plan: confirmedPlan,
      currentStepIndex: 0,
      messages: [new HumanMessage(state.question)],
    };
  }

  // ─── Researcher Node ──────────────────────────────────────────────
  async function researcherNode(state: typeof ResearchState.State): Promise<Partial<typeof ResearchState.State>> {
    const stepIdx = state.currentStepIndex;
    const stepLabel = state.plan[stepIdx] ?? `Step ${String(stepIdx + 1)}`;
    const totalSteps = state.plan.length;
    const progressBase = 10 + (stepIdx / totalSteps) * 70;

    bridge.emitStepStarted(stepLabel);
    bridge.emitActivity('researching', `Executing: ${stepLabel}`);

    // Emit task progress with current step executing
    bridge.emitTaskProgress(
      state.plan.map((step, i) => ({
        description: step,
        status: i < stepIdx ? ('completed' as const) : i === stepIdx ? ('executing' as const) : ('pending' as const),
      })),
      'Research Progress'
    );

    bridge.emitStateSnapshot({
      progress: Math.round(progressBase),
      currentPhase: 'researching',
      findings: state.researchNotes.map((n, i) => ({
        id: `finding_${String(i)}`,
        title: state.plan[i] ?? `Finding ${String(i + 1)}`,
        content: n,
      })),
      dataSources: [],
    });

    // ─── Auto-Summarization: compact old notes if context is too large ──
    let workingNotes = [...state.researchNotes];
    const totalChars = workingNotes.reduce((sum, n) => sum + n.length, 0);
    let summaryCount = state.summaryCount ?? 0;

    if (totalChars > SUMMARIZE_THRESHOLD && workingNotes.length > 2) {
      console.log(
        `[DeepAgent-Summarize] Context too large (${String(totalChars)} chars, ~${String(Math.round(totalChars / CHARS_PER_TOKEN))} tokens). Compacting ${String(workingNotes.length)} notes...`
      );
      bridge.emitActivity('summarizing', 'Compacting research context to prevent overflow...');

      try {
        const compactResponse = await llm.invoke([
          new SystemMessage(
            'Summarize the following research findings into a concise summary. Preserve all specific data points, numbers, and key facts. Output a single compact paragraph per original section.'
          ),
          new HumanMessage(workingNotes.map((n, i) => `[Step ${String(i + 1)}]\n${n}`).join('\n\n')),
        ]);
        const compactText = typeof compactResponse.content === 'string' ? compactResponse.content : '';
        if (compactText.length > 0 && compactText.length < totalChars * 0.7) {
          console.log(
            `[DeepAgent-Summarize] Compacted: ${String(totalChars)} → ${String(compactText.length)} chars (${String(Math.round((1 - compactText.length / totalChars) * 100))}% reduction)`
          );
          workingNotes = [compactText];
          summaryCount++;
        }
      } catch (err) {
        console.warn('[DeepAgent-Summarize] Compaction failed, continuing with full context:', err);
      }
    }

    // Build step-specific prompt
    const stepPrompt = [
      cachedSystemMessage(
        `${systemPrompt}\n\nYou are executing step ${String(stepIdx + 1)} of ${String(totalSteps)}: "${stepLabel}"\n` +
          `Previous findings:\n${workingNotes.map((n, i) => `[Step ${String(i + 1)}] ${n.slice(0, 200)}`).join('\n')}\n\n` +
          `Use available tools to gather data for this step. Be thorough and specific.\n` +
          `You can call write_todos to break complex steps into sub-tasks, and save_to_memory to persist key findings.`,
        isAnthropic
      ),
      ...state.messages,
      new HumanMessage(
        `Execute step ${String(stepIdx + 1)}: ${stepLabel}. ` +
          `Search for specific data, numbers, and facts. When you have enough, summarize your findings for this step. ` +
          `Any data found MUST be output as fenced code block visuals (chart, kpi, metric, table) — NEVER as matplotlib or executable code.`
      ),
    ];

    // Stream the LLM response with tool calling
    bridge.startNewMessage();
    bridge.emitContentDelta(`### Step ${String(stepIdx + 1)}: ${stepLabel}\n\n`);

    let stepContent = '';
    const newMessages = [];

    // Initial LLM call (may produce tool calls)
    const result = await llmWithTools.invoke(stepPrompt);
    newMessages.push(result);

    // Handle tool calls in a loop
    const toolCalls = result.tool_calls ?? [];
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        bridge.emitToolCall(tc.name, JSON.stringify(tc.args));

        // Execute the tool
        const matchedTool = tools.find((t) => t.name === tc.name);
        if (matchedTool) {
          const toolResult = await matchedTool.invoke(tc.args);
          const resultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
          bridge.emitToolResult(tc.name, resultStr.slice(0, 500));
          stepContent += `[${tc.name}]: ${resultStr.slice(0, 300)}\n`;
        }
      }

      // Follow-up LLM call to summarize tool results with inline visuals
      const followUp = await llm.invoke([
        new SystemMessage(
          `Summarize the findings from step "${stepLabel}". Be concise but include specific numbers and data points.\n\n` +
            `CRITICAL: If ANY numerical data, statistics, metrics, or comparisons are present, you MUST output them as fenced code block visuals:\n` +
            '- Numbers/metrics → ```kpi or ```metric blocks with JSON config\n' +
            '- Comparisons → ```comparison block with JSON config\n' +
            '- Time series data → ```chart block with type "line" and JSON config\n' +
            '- Category data → ```chart block with type "bar" and JSON config\n' +
            '- Any dataset → ALSO include a ```table block showing the raw data\n' +
            '- NEVER use matplotlib, plotly, or Python code for visuals\n' +
            '- Output the JSON config directly in fenced code blocks, NOT executable code\n\n' +
            'Example: ```chart\n{"type":"bar","title":"...","labels":[...],"datasets":[{"label":"...","data":[...]}]}\n```'
        ),
        new HumanMessage(
          `Tool results:\n${stepContent}\n\nSummarize the key findings. ` +
            `For ANY data found, output BOTH a visual (chart/kpi/metric/comparison) AND a data table as fenced code blocks.`
        ),
      ]);

      const summary = typeof followUp.content === 'string' ? followUp.content : '';
      bridge.emitContentDelta(summary + '\n\n');
      stepContent = summary;
    } else {
      // No tool calls — LLM answered directly
      const directContent = typeof result.content === 'string' ? result.content : '';
      bridge.emitContentDelta(directContent + '\n\n');
      stepContent = directContent;
    }

    bridge.emitStepFinished(stepLabel);

    // If notes were compacted, replace all with compacted + new step
    const updatedNotes =
      workingNotes.length < state.researchNotes.length
        ? [...workingNotes, stepContent] // compacted: replace old with summary + new
        : [stepContent]; // no compaction: just append new step

    return {
      currentStepIndex: stepIdx + 1,
      researchNotes: updatedNotes,
      messages: newMessages,
      done: stepIdx + 1 >= totalSteps,
      summaryCount,
    };
  }

  // ─── Synthesizer Node ─────────────────────────────────────────────
  async function synthesizerNode(state: typeof ResearchState.State): Promise<Partial<typeof ResearchState.State>> {
    bridge.emitStepStarted('Synthesizing final report');
    bridge.emitActivity('synthesizing', 'Creating final report with visualizations...');
    bridge.emitStateSnapshot({
      progress: 85,
      currentPhase: 'generating',
      findings: state.researchNotes.map((n, i) => ({
        id: `finding_${String(i)}`,
        title: state.plan[i] ?? `Finding ${String(i + 1)}`,
        content: n,
      })),
      dataSources: [],
    });

    const notesText = state.researchNotes
      .map((note, i) => `### Step ${String(i + 1)}: ${state.plan[i] ?? 'Research'}\n${note}`)
      .join('\n\n');

    bridge.startNewMessage();

    // Stream the synthesis response token by token
    const stream: AsyncIterable<AIMessageChunk> = await llm.stream([
      cachedSystemMessage(`${systemPrompt}\n\n${SYNTHESIS_PROMPT}`, isAnthropic),
      new HumanMessage(
        `Original question: ${state.question}\n\n` +
          `Research findings:\n${notesText}\n\n` +
          `Produce a comprehensive analytical report. For EVERY data point, output BOTH a visual AND a table:\n\n` +
          `1. Executive summary → \`\`\`metric grid with 4-6 KPIs\n` +
          `2. Key metrics → \`\`\`kpi blocks for headline numbers\n` +
          `3. Trends over time → \`\`\`chart with type "line" + \`\`\`table with the data\n` +
          `4. Comparisons → \`\`\`chart with type "bar" + \`\`\`comparison or \`\`\`table\n` +
          `5. Proportions → \`\`\`chart with type "pie" + \`\`\`table\n` +
          `6. Sources → \`\`\`citation block\n` +
          `7. Confidence → \`\`\`gauge block\n\n` +
          `CRITICAL: Output JSON fenced code blocks ONLY. NEVER use matplotlib, Python code, or any executable code for visuals. ` +
          `The chat UI renders these JSON blocks as interactive charts natively.`
      ),
    ]);

    let fullContent = '';
    for await (const chunk of stream) {
      const delta = typeof chunk.content === 'string' ? chunk.content : '';
      if (delta) {
        bridge.emitContentDelta(delta);
        fullContent += delta;
      }
    }

    bridge.emitStepFinished('Synthesizing final report');
    bridge.emitStateSnapshot({
      progress: 100,
      currentPhase: 'complete',
      findings: state.researchNotes.map((n, i) => ({
        id: `finding_${String(i)}`,
        title: state.plan[i] ?? `Finding ${String(i + 1)}`,
        content: n,
      })),
      dataSources: [],
    });

    return {
      messages: [new HumanMessage('Synthesis complete')],
      researchNotes: [fullContent],
    };
  }

  // ─── Conditional Edge ─────────────────────────────────────────────
  function shouldContinue(state: typeof ResearchState.State): 'researcher' | 'synthesizer' {
    if (state.done || state.currentStepIndex >= state.plan.length) {
      return 'synthesizer';
    }
    return 'researcher';
  }

  // ─── Build Graph ──────────────────────────────────────────────────
  const graph = new StateGraph(ResearchState)
    .addNode('planner', plannerNode)
    .addNode('researcher', researcherNode)
    .addNode('synthesizer', synthesizerNode)
    .addEdge(START, 'planner')
    .addEdge('planner', 'researcher')
    .addConditionalEdges('researcher', shouldContinue)
    .addEdge('synthesizer', END);

  return graph.compile();
}
