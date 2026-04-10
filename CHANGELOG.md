# Changelog

All notable changes to TitanX are documented in this file.

---

## [1.9.11] - 2026-04-09

### Added

#### Deep Agent — AG-UI Research Engine

- **LangGraph research graph**: In-process planner → researcher (loop) → synthesizer pipeline with 3 tools (web_search, fetch_url, analyze_data)
- **13+ inline visual types**: chart (line/bar/pie/area/scatter/radar/doughnut/bubble), kpi, metric grid, table, pivot, timeline, gauge, comparison, citation, plan — all rendered as interactive Chart.js cards in chat
- **Human-in-the-Loop (HITL)**: Agent proposes steps, user confirms/rejects via inline checkbox UI with IPC callback to resume graph
- **AG-UI task progress**: Live step-by-step progress with status icons (pending/executing/completed), updates in-place via IPC merge
- **Subgraph status**: Multi-agent delegation display showing active sub-agent with color-coded indicators
- **Tool card registry**: Rich visual cards for weather, web search, and URL fetch tool results with pattern-matching registration
- **InlineVisualCard**: Shared card wrapper for consistent AG-UI component styling across fenced blocks and IPC messages
- **Deep Agent page**: Two-panel layout (conversation + insights) with progress bar, connector selection, and visual extraction

#### Smart Data Auto-Visualization

- **Universal data point extractor**: 5-pass tokenizer extracts label-value pairs from any text format (structured pairs, inline prose, temporal series, percentages, change patterns)
- **Dynamic visual decision**: Feeds extracted data into existing `analyzeTableData()` decision tree — automatically picks line/bar/pie/scatter/radar based on data shape
- **Markdown table detection**: Existing tables auto-converted to best chart type (date+numeric → line, categorical → bar, proportions → pie)
- **KPI pattern detection**: Bold patterns like `**Revenue: $12.4M** (+8.2% YoY)` auto-wrapped as KPI cards
- **Percentage breakdown detection**: Lists summing to ~100% auto-rendered as pie/doughnut charts
- **Trend data detection**: Temporal sequences (Q1, Q2, months, years) auto-rendered as line charts

#### Send Box Redesign

- **Single-container layout**: Clean rounded input with bottom bar (matching reference design)
- **Inline selectors**: `+` file upload button, connector chip dropdown, MCP server chip dropdown — all inside the input container
- **Dynamic MCP fetching**: McpServerSelector now self-fetches server list via IPC on popover open
- **Focus highlight**: Input container border turns primary color on focus

### Fixed

- **`transformMessage()` missing AG-UI cases**: Added `case 'agui_interrupt'` and `case 'agui_task_progress'` to `chatLib.ts` — previously hit default case and returned undefined, blocking all AG-UI message rendering
- **`useAcpMessage` silent drop**: Added explicit handling for AG-UI types with proper running state management
- **LLM visual output**: Strengthened prompts to enforce JSON fenced code blocks over matplotlib/Python code — researcher follow-up, synthesizer, and system prompt all now include concrete JSON examples and mandatory visualization rules

### Changed

- **Removed `DeepAgentToolbar.tsx`**: Toolbar absorbed into redesigned SendBox bottom bar
- **McpServerSelector**: No longer requires `servers` prop — fetches dynamically from IPC
- **CodeBlock**: Extended visual language detection with `task-progress`, `hitl`, `subgraph` tags
- **VisualCodeBlock**: Added direct-render mode for interactive types (no click-to-expand modal), lazy imports for AG-UI components

---

## [1.9.10] - 2026-04-09

- Fix: bundle team MCP stdio bridge for production builds
- Perf: lazy-load heavy deps, split startup init, and optimize build output
- Perf: parallelize startup init and replace blocking readdirSync
- Chore: rebrand AionUi to TitanX across build config, packaging, and docs
