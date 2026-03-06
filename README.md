# MySQL MCP Server

<div align="center">

**A production-ready Model Context Protocol (MCP) server for MySQL database integration with AI agents**

**Last Updated:** 2026-03-06 12:00:00

[![npm version](https://img.shields.io/npm/v/@berthojoris/mcp-mysql-server)](https://www.npmjs.com/package/@berthojoris/mcp-mysql-server)
[![npm downloads](https://img.shields.io/npm/dm/@berthojoris/mcp-mysql-server)](https://www.npmjs.com/package/@berthojoris/mcp-mysql-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)

[Installation](#-installation) · [Quick Start](#-quick-start) · [Configuration](#-ai-agent-configuration) · [Permissions](#-permission-system) · [Tools](#-available-tools) · [Documentation](DOCUMENTATIONS.md)

</div>

---

## TL;DR - Quick Setup

Run directly with `npx`:

```bash
npx @berthojoris/mcp-mysql-server mysql://user:pass@localhost:3306/mydb "list,read,utility"
```

Add to your AI agent config (`.mcp.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "type": "stdio",
      "args": [
        "-y",
        "@berthojoris/mcp-mysql-server",
        "mysql://user:pass@localhost:3306/mydb",
        "list,read,utility"
      ]
    }
  }
}
```

For agent-specific examples (Codex TOML, Zed, local path, multi-DB), see **[DOCUMENTATIONS.md → Setup & Configuration](DOCUMENTATIONS.md#setup--configuration-extended)**.

---

## Installation

### Option 1: Quick Start with npx (Recommended)

No installation required - run directly:

```bash
npx @berthojoris/mcp-mysql-server mysql://user:pass@localhost:3306/db "list,read,utility"
```

### Option 2: Global Installation

```bash
npm install -g @berthojoris/mcp-mysql-server
mcp-mysql mysql://user:pass@localhost:3306/db "list,read,utility"
```

---

## Quick Start

### 1. Set Up Environment (Optional)

Create `.env` file for local development:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=yourpassword
DB_NAME=yourdatabase
MCP_CONFIG=list,read,utility
```

### 2. Build Project (If Cloned Locally)

```bash
npm install
npm run build
```

### 3. Configure Your AI Agent

See [AI Agent Configuration](#-ai-agent-configuration) section below.

### 4. Restart Your AI Agent

Completely restart your AI agent application to load the MCP server.

### 5. Test It!

Try asking your AI:

> "What databases are available?"
> "Show me all tables in my database"
> "What's the structure of the users table?"
> "Show me the first 5 records from users"

---

## AI Agent Configuration

### Standard JSON Configuration

Most AI agents use a similar JSON configuration format (the file location varies by tool).

If you want ready-to-copy snippets per client (Claude Code/Cursor/Windsurf/Cline/Codex/Zed), see **[DOCUMENTATIONS.md → Agent Configuration Examples](DOCUMENTATIONS.md#agent-configuration-examples)**.

**Universal Configuration Template:**

**Option 1: Single-Layer (Permissions Only) - Simple Setup**
```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "type": "stdio",
      "args": [
        "-y",
        "@berthojoris/mcp-mysql-server",
        "mysql://user:password@localhost:3306/database",
        "list,read,utility,create,update,ddl"
      ]
    }
  }
}
```

**Option 2: Dual-Layer (Permissions + Categories) - Recommended for Fine Control**
```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "type": "stdio",
      "args": [
        "-y",
        "@berthojoris/mcp-mysql-server",
        "mysql://user:password@localhost:3306/database_name_here",
        "list,read,utility,create,update,ddl",
        "database_discovery,crud_operations,custom_queries,schema_management,index_management,constraint_management,table_maintenance,query_optimization,analysis"
      ]
    }
  }
}
```

> **💡 Tip:** The dual-layer approach provides granular control. The 4th argument (permissions) controls broad access levels, while the 5th argument (categories) fine-tunes which specific tools are available.

### Environment Variables Configuration

Alternative approach using environment variables instead of connection string:

**Option 1: Permissions Only (Simple)**

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "type": "stdio",
      "args": ["-y", "@berthojoris/mcp-mysql-server"],
      "env": {
        "DB_HOST": "localhost",
        "DB_PORT": "3306",
        "DB_USER": "root",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "your_database",
        "MCP_PERMISSIONS": "list,read,utility,create,update,delete"
      }
    }
  }
}
```

**Option 2: Permissions + Categories (Recommended)**

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "type": "stdio",
      "args": ["-y", "@berthojoris/mcp-mysql-server"],
      "env": {
        "DB_HOST": "localhost",
        "DB_PORT": "3306",
        "DB_USER": "root",
        "DB_PASSWORD": "your_password",
        "DB_NAME": "your_database",
        "MCP_PERMISSIONS": "list,read,utility,create,update,delete",
        "MCP_CATEGORIES": "database_discovery,performance_monitoring,custom_queries"
      }
    }
  }
}
```

For more client-specific config snippets, see **[DOCUMENTATIONS.md → Setup & Configuration](DOCUMENTATIONS.md#setup--configuration-extended)**.

---

## Permission System

Control database access with a **dual-layer filtering system** that provides both broad and fine-grained control:

- **Layer 1 (Permissions)**: Broad operation-level control using legacy categories
- **Layer 2 (Categories)**: Optional fine-grained tool-level filtering using documentation categories

**Filtering Logic**: `Tool enabled = (Has Permission) AND (Has Category OR No categories specified)`

### Permissions

| Permission | Operations | Use Case |
|------------|------------|----------|
| `list` | List databases, tables, schemas | Database exploration |
| `read` | SELECT queries, read data | Analytics, reporting |
| `create` | INSERT new records | Data entry |
| `update` | UPDATE existing records | Data maintenance |
| `delete` | DELETE records | Data cleanup |
| `execute` | Execute custom SQL (DML) + Advanced SQL | Complex operations |
| `ddl` | CREATE/ALTER/DROP tables | Schema management |
| `procedure` | Stored procedures (CREATE/DROP/EXECUTE) | Procedure management |
| `transaction` | BEGIN, COMMIT, ROLLBACK | ACID operations |
| `utility` | Connection testing, diagnostics | Troubleshooting |

Common configuration examples are documented in **[DOCUMENTATIONS.md → Category Filtering System](DOCUMENTATIONS.md#🆕-category-filtering-system)**.

---

### Documentation Categories (Recommended)

Use documentation categories to fine-tune which tools are exposed (Layer 2):

| Category List | Use Case | List Tools |
|---------------|----------|-----------|
| `database_discovery` | Explore databases, tables, and schema structure | `get_all_tables_relationships, get_table_relationships, list_databases, list_tables, read_table_schema` |
| `crud_operations` | Create, read, update, delete operations on data | `create_record, delete_record, read_records, update_record` |
| `bulk_operations` | High-performance batch processing operations | `bulk_delete, bulk_insert, bulk_update` |
| `custom_queries` | Execute custom SQL queries and advanced operations | `execute_write_query, run_select_query` |
| `schema_management` | Manage database schema, tables, and structure | `alter_table, create_table, drop_table, execute_ddl` |
| `utilities` | Database utilities, diagnostics, and helper functions | `describe_connection, export_query_to_csv, export_table_to_csv, list_all_tools, read_changelog, test_connection` |
| `transaction_management` | Handle ACID transactions and rollback operations | `begin_transaction, commit_transaction, execute_in_transaction, get_transaction_status, rollback_transaction` |
| `stored_procedures` | Create, execute, and manage stored procedures | `create_stored_procedure, drop_stored_procedure, execute_stored_procedure, get_stored_procedure_info, list_stored_procedures, show_create_procedure` |
| `views_management` | Create and manage database views | `alter_view, create_view, drop_view, get_view_info, list_views, show_create_view` |
| `triggers_management` | Create and manage database triggers | `create_trigger, drop_trigger, get_trigger_info, list_triggers, show_create_trigger` |
| `functions_management` | Create and manage database functions | `create_function, drop_function, execute_function, get_function_info, list_functions, show_create_function` |
| `index_management` | Optimize performance with index management | `analyze_index, create_index, drop_index, get_index_info, list_indexes` |
| `constraint_management` | Manage data integrity constraints | `add_check_constraint, add_foreign_key, add_unique_constraint, drop_constraint, drop_foreign_key, list_constraints, list_foreign_keys` |
| `table_maintenance` | Table optimization, repair, and maintenance | `analyze_table, check_table, flush_table, get_table_size, get_table_status, optimize_table, repair_table, truncate_table` |
| `server_management` | MySQL server configuration and administration | `explain_query, get_server_info, kill_process, show_binary_logs, show_engine_status, show_process_list, show_replication_status, show_status, show_variables` |
| `performance_monitoring` | Monitor and analyze database performance | `get_connection_pool_stats, get_database_health_check, get_index_usage_stats, get_performance_metrics, get_slow_queries, get_table_io_stats, get_top_queries_by_count, get_top_queries_by_time, get_unused_indexes, reset_performance_stats` |
| `cache_management` | Manage query cache and optimization | `clear_cache, configure_cache_settings, get_cache_config, get_cache_stats, invalidate_cache_for_table` |
| `query_optimization` | Analyze and optimize SQL queries | `analyze_query, get_optimization_hints` |
| `backup_restore` | Create backups and restore databases | `backup_database, backup_table, get_create_table_statement, get_database_schema, restore_from_sql` |
| `schema_migrations` | Version control for database schema changes | `apply_migrations, create_migration, generate_migration_from_diff, get_migration_status, get_schema_version, init_migrations_table, reset_failed_migration, rollback_migration, validate_migrations` |
| `analysis` | Data analysis and reporting tools | `get_column_statistics, get_database_summary, get_schema_erd, get_schema_rag_context` |

<details>
  <summary>Copy/paste list (comma-separated, no spaces)</summary>

```text
database_discovery,crud_operations,bulk_operations,custom_queries,schema_management,utilities,transaction_management,stored_procedures,views_management,triggers_management,functions_management,index_management,constraint_management,table_maintenance,server_management,performance_monitoring,cache_management,query_optimization,backup_restore,schema_migrations,analysis
```

</details>

Full category → tool mapping (and examples) lives in **[DOCUMENTATIONS.md → Category Filtering System](DOCUMENTATIONS.md#🆕-category-filtering-system)**.

---

## Available Tools

The server exposes **106 tools** organized into categories (CRUD, schema, migrations, and perf/monitoring).

- Complete list of tools: **[DOCUMENTATIONS.md → Complete Tools Reference](DOCUMENTATIONS.md#🔧-complete-tools-reference)**

---

## Detailed Documentation

For comprehensive documentation, see **[DOCUMENTATIONS.md](DOCUMENTATIONS.md)**:

- **DDL Operations** - Create, alter, and drop tables
- **Data Export Tools** - Export to CSV, JSON, and SQL formats
- **Data Import Tools** - Import from CSV and JSON sources
- **Database Backup & Restore** - Full backup/restore with SQL dumps
- **Data Migration Tools** - Copy, move, clone, compare, and sync data
- **Schema Versioning** - Version control for database schema changes
- **Transaction Management** - ACID transactions
- **Stored Procedures** - Create and execute with IN/OUT/INOUT parameters
- **Query Logging** - See all SQL queries executed automatically
- **Security Features** - Built-in security and best practices
- **Bulk Operations** - High-performance batch processing
- **Troubleshooting** - Common issues and solutions

---

## MySQL MCP vs Manual Database Access

This MySQL MCP is a **powerful intermediary layer** between AI assistants and MySQL databases.

For full feature coverage and usage examples, see **[DOCUMENTATIONS.md](DOCUMENTATIONS.md)**.

---

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

<div align="center">

**Made with care for the AI development community**

*Enabling AI agents to interact with MySQL databases safely and efficiently*

[Report Bug](https://github.com/berthojoris/mysql-mcp/issues) · [Request Feature](https://github.com/berthojoris/mysql-mcp/issues) · [Documentation](DOCUMENTATIONS.md)

</div>
