# Schema Discovery & Natural Language Query — Agent Build Guide

**Purpose:** Guide for AI agents and developers building new MySQL MCP tools that answer natural-language questions like *"Which table stores survey data?"*

**Last Updated:** 2026-05-25  
**Related code:** `src/tools/analysisTools.ts`, `src/tools/databaseTools.ts`, `src/tools/fulltextSearchTools.ts`, `src/tools/smartQueryBuilderTools.ts`, `src/mcp-server.ts`

---

## How It Works Today

MySQL MCP is **not** a natural-language query engine. It exposes **tools**; the AI agent (Cursor, Claude, etc.) interprets user questions and chains tool calls.

```text
User (natural language)
  → AI Agent / LLM
    → MCP tools (list_tables, get_schema_rag_context, read_records, …)
      → MySQL INFORMATION_SCHEMA / table data
  → Answer to user
```

**Recommended discovery workflow** (from `list_all_tools` agent guidance):

```text
describe_connection → list_tables → get_database_summary → get_schema_rag_context
```

For verification: `read_table_schema` → `read_records` (sample rows).

---

## When Answers Are Accurate

### Scenarios That Usually Succeed

| Signal | Example | Why it works |
|--------|---------|--------------|
| Descriptive table names | `surveys`, `survey_responses`, `survey_answers` | Keyword match in `list_tables` / `get_schema_rag_context` |
| Descriptive column names | `survey_id`, `survey_title`, `question_text` | Visible in schema metadata without reading row data |
| Small schema footprint | < ~50 tables, < ~12 columns per table (defaults) | No truncation in `get_schema_rag_context` |
| Clear FK relationships | `survey_answers.survey_id → surveys.id` | `get_all_tables_relationships` / RAG context links related tables |

**Example flow (high confidence):**

1. User asks: *"Which table has survey data?"*
2. Agent calls `get_schema_rag_context`.
3. Response includes `surveys (~1200 rows)` with columns `title`, `created_at`, `status`.
4. Agent answers: **`surveys`** (and optionally related tables) with high confidence.

---

## When Answers Fail or Are Unreliable

| Problem | Impact | Current workaround |
|---------|--------|-------------------|
| Generic table names (`forms`, `responses`, `data_entries`) | Agent must guess; wrong table likely | Manual `read_table_schema` + `read_records` on candidates |
| Keyword only in **row data**, not schema names | No automatic cross-table scan | Iterative `read_records` on many tables (slow, incomplete) |
| Database > **50 tables** (default `max_tables`) | Tables omitted from RAG context | Pass `max_tables: 200` — still capped, no relevance ranking |
| Table > **12 columns** (default `max_columns`) | Important columns hidden | Pass `max_columns: 50` — still no smart column selection |
| No `TABLE_COMMENT` / `COLUMN_COMMENT` in metadata | DBA hints lost | None |
| Permissions `list,read,utility` **without** `analysis` | `get_schema_rag_context` disabled | Enable `analysis` category or permission |

### Truncation limits (source of truth)

File: `src/tools/analysisTools.ts` — `getSchemaRagContext()`

```typescript
const maxTables = Math.min(Math.max(params.max_tables ?? 50, 1), 200);
const maxColumns = Math.min(Math.max(params.max_columns ?? 12, 1), 200);
```

Tables are ordered **alphabetically**, not by relevance. A table named `zzz_surveys` may be omitted while unrelated early-alphabet tables are included.

---

## Gaps — Tools Not Yet in MCP

Use this section as a **build backlog**. Each gap maps to a proposed tool.

### Gap 1: No concept / keyword search across schema

**Problem:** User asks *"Where is survey data?"* but no table/column name contains `survey`.

**Proposed tool:** `find_tables_by_keyword`

| Field | Spec |
|-------|------|
| **Input** | `keyword` (required), `search_in` (`table_names` \| `column_names` \| `comments` \| `all`), `database?`, `limit?` |
| **Behavior** | Query `INFORMATION_SCHEMA.TABLES`, `INFORMATION_SCHEMA.COLUMNS`; include `TABLE_COMMENT`, `COLUMN_COMMENT`; score matches (exact > prefix > contains); return ranked list |
| **Output** | `[{ table_name, matched_on, matched_field, score, column_names[] }]` |
| **Category** | `analysis` or new `schema_discovery` |
| **Permission** | `list` |

**Acceptance criteria:**

- [ ] Finds `surveys` when keyword is `survey`
- [ ] Finds `form_responses` when column comment says "survey response"
- [ ] Does not require knowing table name upfront
- [ ] Works without FULLTEXT index

---

### Gap 2: No NL-to-SQL engine in MCP

**Problem:** All natural-language interpretation happens in the host AI agent, not in MCP.

**Options for builders:**

| Approach | Pros | Cons |
|----------|------|------|
| Keep agent-side only | No new MCP code | Inconsistent across agents |
| Add `interpret_intent` tool | Returns structured intent + suggested tables | Still needs LLM or rule engine |
| Expose `SmartQueryBuilderTools` to MCP | Code already exists in repo | Limited keywords; not registered today |

**Note:** `SmartQueryBuilderTools` (`src/tools/smartQueryBuilderTools.ts`) has `startQueryBuilder({ intent })` and `suggestNextTables()` but is **not** registered in `mcp-server.ts` or `manifest.json`. Hardcoded keywords: `customer`, `order`, `product`, `sales`, `payment`, `category` — **no `survey`**.

---

### Gap 3: `fulltext_search` is not schema discovery

**Current tool:** `fulltext_search` — searches **one known table** via MySQL `MATCH … AGAINST`.

| Limitation | Detail |
|------------|--------|
| Requires | `table_name` upfront |
| Requires | FULLTEXT index on searched columns |
| Scope | Row content, not schema metadata |
| Use case | Search text inside a table — **not** "which table?" |

Do **not** use `fulltext_search` to answer *"Which table has survey data?"* unless the agent already knows the candidate table.

---

### Gap 4: `aiTools` is query repair only

**Current tool:** `repair_query` (guided query fixer)

- Runs `EXPLAIN FORMAT=JSON` on a SQL string
- Suggests optimizations (e.g. add `LIMIT`)
- Does **not** parse natural language or map concepts to tables

---

### Gap 5: Metadata incomplete for discovery

`get_schema_rag_context` and `get_database_summary` currently fetch:

```sql
-- Tables
SELECT TABLE_NAME, TABLE_ROWS FROM INFORMATION_SCHEMA.TABLES ...

-- Columns
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS ...
```

**Missing for discovery:**

- `TABLE_COMMENT`
- `COLUMN_COMMENT`
- Match scoring / keyword filter
- Sample distinct values for enum-like columns

**Enhancement (no new tool name):** extend `get_schema_rag_context` with optional `include_comments: true` and `keyword_filter?: string`.

---

## Accuracy Matrix — Example Question

**User question:** *"Apakah kamu tau di tabel mana data survey?"* / *"Which table stores survey data?"*

| Database condition | Estimated accuracy | Recommended tool chain |
|--------------------|-------------------|------------------------|
| Table/column names contain `survey` | **High (80–95%)** | `get_schema_rag_context` → confirm with `read_records` |
| Unclear names but typical structure (`questions`, `answers`, `responses`) | **Medium (50–70%)** | `list_tables` → `read_table_schema` on candidates → `read_records` |
| Generic names; survey data in JSON/text columns | **Low (<50%)** | Needs **`find_tables_by_keyword`** or cross-table sample scan (not built) |
| Large DB (>50 tables) without raising limits | **Low** — target table may be truncated | `get_schema_rag_context({ max_tables: 200 })` + keyword tool |
| Keyword only in cell values | **Very low** without new tool | Proposed: `search_data_across_tables` (see below) |

---

## Proposed Tool: `search_data_across_tables` (Advanced)

For when the word `survey` exists only in **data**, not in schema names.

| Field | Spec |
|-------|------|
| **Input** | `keyword`, `tables?` (default: all), `columns?` (default: text types), `limit_per_table?`, `max_tables?` |
| **Behavior** | For each table, `SELECT … WHERE col LIKE '%keyword%'` on VARCHAR/TEXT/JSON columns; return hits with table, column, sample value |
| **Risk** | Slow on large DBs; must enforce limits and read-only |
| **Category** | `analysis` |
| **Permission** | `read` |

**Guardrails:**

- Max tables scanned per call (e.g. 20)
- Max rows per table (e.g. 5)
- Timeout per query
- Only `SELECT`; no writes

---

## Proposed Tool: `search_schema` (Unified Discovery)

Single entry point for agents answering *"where is X?"* questions.

**Input:**

```json
{
  "query": "survey",
  "modes": ["table_names", "column_names", "comments", "sample_data"],
  "max_results": 20,
  "database": "optional"
}
```

**Output:**

```json
{
  "status": "success",
  "data": {
    "query": "survey",
    "matches": [
      {
        "table_name": "surveys",
        "match_type": "table_name",
        "score": 100,
        "columns": ["id", "title", "created_at"],
        "row_estimate": 1200
      },
      {
        "table_name": "form_entries",
        "match_type": "column_comment",
        "score": 60,
        "matched_column": "payload",
        "comment": "JSON survey submission"
      }
    ],
    "recommended_next_steps": [
      "read_table_schema({ table_name: 'surveys' })",
      "read_records({ table_name: 'surveys', pagination: { limit: 5 } })"
    ]
  }
}
```

---

## Implementation Checklist for Agents

When adding a new discovery tool to MySQL MCP, follow project conventions (`AGENTS.md`):

1. **Implement** handler in `src/tools/` (e.g. `schemaDiscoveryTools.ts`)
2. **Register** in `src/index.ts` with `checkToolEnabled`
3. **Register** tool definition + handler in `src/mcp-server.ts`
4. **Add** to `manifest.json`
5. **Map** in `src/config/featureConfig.ts` (category + permission)
6. **Validate** args in `src/tools/toolArgumentValidation.ts`
7. **Update** `DOCUMENTATIONS.md` (tool list, count, examples)
8. **Update** `README.md` if user-facing
9. **Update** `CHANGELOG.md` + bump `package.json` version
10. **Update** `list_all_tools` agent guidance workflows in `src/tools/utilityTools.ts`

### Suggested permission mapping

| Tool | Permission | Doc category |
|------|------------|--------------|
| `find_tables_by_keyword` | `list` | `analysis` |
| `search_schema` | `list` + `read` (if sample_data mode) | `analysis` |
| `search_data_across_tables` | `read` | `analysis` |

### Minimum MCP config for discovery questions

```text
Permissions:  list,read,utility,analysis
Categories:   database_discovery,analysis,custom_queries
```

---

## Existing Tools Reference (Quick)

| Tool | Role in discovery | Limitation |
|------|-------------------|------------|
| `list_tables` | All table names | Names only |
| `read_table_schema` | Full column detail for one table | One table at a time |
| `get_schema_rag_context` | Compact multi-table context for LLM | Default 50 tables / 12 cols; alphabetical order |
| `get_database_summary` | Markdown overview | Same metadata limits |
| `get_all_tables_relationships` | FK graph | No name/content search |
| `read_records` | Sample data verification | Needs known table |
| `fulltext_search` | Full-text in one table | Needs table + FULLTEXT index |
| `list_all_tools` | Agent workflows & guidance | Meta only |

---

## Decision Tree for Agents (Current vs Future)

```text
User asks "which table has X?"
│
├─ Call get_schema_rag_context (max_tables: 200 if large DB)
│
├─ Any table/column name match X?
│   ├─ YES → read_table_schema + read_records → answer
│   └─ NO  → [FUTURE] search_schema({ query: X })
│              ├─ comment/name match → answer
│              └─ no match → [FUTURE] search_data_across_tables (limited)
│
└─ Report confidence + tables checked + truncation warnings
```

---

## Summary

| Aspect | Status |
|--------|--------|
| User can ask in natural language | Yes — via host AI agent |
| MCP analyzes all tables automatically | Partial — metadata only, with limits |
| Accurate without descriptive naming | No — needs new tools |
| `find_tables_by_keyword` | **Not built — priority #1** |
| `search_schema` (unified) | **Not built — recommended** |
| `search_data_across_tables` | **Not built — for hard cases** |
| Expose `SmartQueryBuilderTools` | **Code exists, not in MCP** |
| Include TABLE/COLUMN comments | **Not in current schema tools** |

**Build priority:**

1. `find_tables_by_keyword` — low cost, high impact  
2. Extend `get_schema_rag_context` with comments + optional keyword filter  
3. `search_schema` — unified agent entry point  
4. `search_data_across_tables` — guarded, optional deep scan  
5. Register or extend `SmartQueryBuilderTools` with domain-agnostic keyword matching  
