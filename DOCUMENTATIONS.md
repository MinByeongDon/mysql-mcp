# MySQL MCP Server - Documentation

**Last Updated:** 2026-05-04 18:07:52
**Version:** 1.40.6
**Total Tools:** 79

Comprehensive documentation for the MySQL MCP Server. For quick start, see [README.md](README.md).

---

## Table of Contents

1. [Configuration](#configuration)
2. [Tools Overview](#tools-overview)
3. [Permission System](#permission-system)
4. [Tool Categories](#tool-categories)
5. [Core Operations](#core-operations)
6. [Advanced Features](#advanced-features)
7. [Security Features](#security-features)

---

## Configuration

### Dual-Layer Access Control

Configure MySQL MCP with two access-control layers:

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
        "list,read,utility",
        "database_discovery,custom_queries,analysis"
      ]
    }
  }
}
```

**Layer 1 (Permissions)**: Broad operation control  
**Layer 2 (Categories)**: Fine-grained tool filtering  

### Environment Variables

```json
{
  "env": {
    "DB_HOST": "localhost",
    "DB_PORT": "3306", 
    "DB_USER": "root",
    "DB_PASSWORD": "your_password",
    "DB_NAME": "your_database",
    "MCP_PERMISSIONS": "list,read,utility",
    "MCP_CATEGORIES": "database_discovery,custom_queries,analysis"
  }
}
```

---

### Cursor Compatibility Bridge

Some Cursor MCP wrappers can call a tool by name but cannot pass `arguments`. For that flow, write a request file at `.cursor/mysql-mcp-request.json` and call the no-argument `cursor_execute_request` tool.

Execute any existing MCP tool:

```json
{
  "tool": "execute_ddl",
  "arguments": {
    "query": "DROP TABLE IF EXISTS spark_processes;"
  }
}
```

Or execute SQL directly with automatic routing:

```json
{
  "query": "DROP TABLE IF EXISTS spark_processes;",
  "mode": "auto"
}
```

Supported `mode` values are `auto`, `select`, `write`, and `ddl`. Set `MYSQL_MCP_CURSOR_REQUEST_FILE` to override the request file path.

---

## Permission System

### Available Permissions

| Permission | Operations | Example Tools |
|------------|------------|---------------|
| `list` | List/discover objects | `list_databases`, `list_tables` |
| `read` | Read data | `read_records`, `run_select_query` |
| `create` | Insert records | `create_record`, `bulk_insert` |
| `update` | Update records | `update_record`, `bulk_update` |
| `delete` | Delete records | `delete_record`, `bulk_delete` |
| `execute` | Custom SQL | `execute_write_query` |
| `ddl` | Schema changes | `create_table`, `alter_table` |
| `utility` | Utility operations | `test_connection`, `analyze_table` |
| `transaction` | Transaction management | `begin_transaction`, `commit_transaction` |
| `procedure` | Stored procedures | `create_stored_procedure`, `execute_stored_procedure` |

### Filtering Logic

```
Tool enabled = (Has Permission) AND (Has Category OR No categories specified)
```

---

## Tool Categories

### 1. Database Discovery (5 tools)
- `list_databases` - List all databases
- `list_tables` - List tables in database
- `read_table_schema` - Get table structure
- `get_all_tables_relationships` - Get all FK relationships
- `list_all_tools` - List available MCP tools

### 2. Analysis (4 tools)
- `get_database_summary` - Database overview with statistics
- `get_schema_erd` - Generate Mermaid.js ER diagram
- `get_schema_rag_context` - Compact schema for LLM context
- `get_column_statistics` - Column data profiling

### 3. Data Operations (7 tools)
- `create_record` - Insert single record
- `read_records` - Query with filtering/pagination
- `update_record` - Update records
- `delete_record` - Delete records
- `bulk_insert` - Batch insert (performance)
- `bulk_update` - Batch update (performance)
- `bulk_delete` - Batch delete (performance)

### 4. Query Management (3 tools)
- `run_select_query` - Execute SELECT queries
- `execute_write_query` - Execute INSERT/UPDATE/DELETE
- `repair_query` - Diagnose and fix SQL errors

### 5. Schema Management (4 tools)
- `create_table` - Create new tables
- `alter_table` - Modify table structure
- `drop_table` - Delete tables
- `execute_ddl` - Execute raw DDL

### 6. Index Management (10 tools)
- `list_indexes` - List table indexes
- `get_index_info` - Get index details
- `create_index` - Create indexes
- `drop_index` - Drop indexes
- `create_fulltext_index` - Create FULLTEXT indexes for text search
- `fulltext_search` - Perform full-text search with MATCH AGAINST
- `get_fulltext_info` - Get FULLTEXT index information
- `drop_fulltext_index` - Drop FULLTEXT indexes
- `get_fulltext_stats` - Get FULLTEXT index statistics
- `optimize_fulltext` - Optimize FULLTEXT indexes

### 7. Constraint Management (7 tools)
- `list_foreign_keys` - List foreign keys
- `list_constraints` - List all constraints
- `add_foreign_key` - Add foreign key
- `drop_foreign_key` - Remove foreign key
- `add_unique_constraint` - Add unique constraint
- `drop_constraint` - Remove constraint
- `add_check_constraint` - Add check constraint

### 8. Stored Procedures (6 tools)
- `list_stored_procedures` - List procedures
- `get_stored_procedure_info` - Get procedure details
- `execute_stored_procedure` - Execute procedures
- `create_stored_procedure` - Create procedures
- `drop_stored_procedure` - Remove procedures
- `show_create_procedure` - Show CREATE statement

### 9. Views Management (6 tools)
- `list_views` - List views
- `get_view_info` - Get view details
- `create_view` - Create views
- `alter_view` - Modify views
- `drop_view` - Remove views
- `show_create_view` - Show CREATE statement

### 10. Triggers Management (5 tools)
- `list_triggers` - List triggers
- `get_trigger_info` - Get trigger details
- `create_trigger` - Create triggers
- `drop_trigger` - Remove triggers
- `show_create_trigger` - Show CREATE statement

### 11. Table Maintenance (8 tools)
- `analyze_table` - Update statistics
- `optimize_table` - Reclaim space
- `check_table` - Check for errors
- `repair_table` - Repair corrupted tables
- `truncate_table` - Remove all rows
- `get_table_status` - Get table statistics
- `flush_table` - Close/reopen table
- `get_table_size` - Get size information

### 12. Transaction Management (5 tools)
- `begin_transaction` - Start transaction
- `commit_transaction` - Commit transaction
- `rollback_transaction` - Rollback transaction
- `get_transaction_status` - Check transaction state
- `execute_in_transaction` - Execute within transaction

### 13. Query Optimization (3 tools)
- `analyze_query` - Analyze query performance
- `get_optimization_hints` - Get optimizer hints
- `repair_query` - Repair broken SQL queries

### 14. Utilities (5 tools)
- `test_connection` - Test connectivity
- `describe_connection` - Connection info
- `read_changelog` - Read changelog
- `invalidate_table_cache` - Clear table cache
- `cursor_execute_request` - Execute a file-backed request for clients that cannot send MCP arguments

---

## Core Operations

### Database Discovery

Start with these tools to explore any database:

```javascript
// List all databases
await mcp.call("list_databases", {});

// List tables in current database
await mcp.call("list_tables", {});

// Get comprehensive overview
await mcp.call("get_database_summary", {
  max_tables: 50,
  include_relationships: true
});

// Visualize relationships
await mcp.call("get_schema_erd", {});
```

### Data Operations

Basic CRUD operations:

```javascript
// Create record
await mcp.call("create_record", {
  table_name: "users",
  data: { name: "John", email: "john@example.com" }
});

// Read with filtering
await mcp.call("read_records", {
  table_name: "users",
  filters: [{ field: "status", operator: "eq", value: "active" }],
  pagination: { page: 1, limit: 10 }
});

// Update records
await mcp.call("update_record", {
  table_name: "users",
  data: { status: "inactive" },
  conditions: [{ field: "last_login", operator: "lt", value: "2024-01-01" }]
});

// Delete records
await mcp.call("delete_record", {
  table_name: "users",
  conditions: [{ field: "status", operator: "eq", value: "deleted" }]
});
```

### Performance Operations

```javascript
// Analyze slow query
await mcp.call("analyze_query", {
  query: "SELECT * FROM users WHERE email LIKE '%@gmail.com'"
});

// Get optimization hints
await mcp.call("get_optimization_hints", {
  goal: "SPEED"
});
```

---

## Advanced Features

### Analysis

The server includes analysis tools for database insights:

- **Database Summary**: Provides readable overviews with statistics
- **ER Diagram Generation**: Automatic Mermaid.js diagrams
- **RAG Context**: Compact schema for LLM prompts
- **Column Profiling**: Data quality and distribution analysis

### Bulk Operations

For high-performance operations with large datasets:

- **Bulk Insert**: Handle thousands of records efficiently
- **Bulk Update**: Update multiple records with different conditions
- **Bulk Delete**: Delete multiple record sets in batches

### Transaction Management

Full ACID transaction support:

```javascript
await mcp.call("begin_transaction", {});
await mcp.call("create_record", { table_name: "orders", data: {...} });
await mcp.call("update_record", { table_name: "inventory", data: {...} });
await mcp.call("commit_transaction", {});
```

---

## Security Features

### Permission-Based Access Control

- **Layer 1**: Broad permission categories (list, read, create, etc.)
- **Layer 2**: Fine-grained tool category filtering
- **Tool-level**: Each tool requires specific permissions

### Data Protection

- **PII Masking**: Automatic sensitive data redaction in exports
- **Safe Exports**: `safe_export_table` masks emails, credit cards, passwords
- **Query Validation**: Input validation and SQL injection prevention

### Connection Security

- **Environment Variables**: Secure credential management
- **Connection Testing**: Validation before operations
- **Error Handling**: Comprehensive error reporting

---

## Migration & Schema Management

### Schema Versioning

Complete migration support with tracking:

```javascript
// Initialize migration tracking
await mcp.call("init_migrations_table", {});

// Create migration
await mcp.call("create_migration", {
  name: "add_user_avatar",
  up_sql: "ALTER TABLE users ADD COLUMN avatar VARCHAR(255);",
  down_sql: "ALTER TABLE users DROP COLUMN avatar;"
});

// Apply migrations
await mcp.call("apply_migrations", { dry_run: false });
```

### Schema Comparison

```javascript
// Compare table structures
await mcp.call("compare_table_structure", {
  table1: "users_old",
  table2: "users_new"
});
```

---

## Troubleshooting

### Common Issues

1. **Permission Denied**: Check both permission layers in error messages
2. **Connection Failed**: Verify database credentials and network
3. **Query Errors**: Use `repair_query` for diagnosis
4. **Performance Issues**: Use `analyze_query` and optimization hints

### MCP error `-32000: Connection closed` (local server)

If your client reports `MCP error -32000: Connection closed`, the server process is usually crashing on startup.

If you see `ReferenceError: exports is not defined in ES module scope` in the server stderr logs, update to **v1.33.2+** (fixes an ESM/CJS mismatch that caused the MCP process to exit immediately).

### Error Messages

The system provides detailed error messages indicating:

- Which permission layer blocked access
- Required permissions vs current permissions
- Specific category requirements
- SQL syntax and logic errors

---

*For detailed examples and advanced usage patterns, see the project README.md.*
