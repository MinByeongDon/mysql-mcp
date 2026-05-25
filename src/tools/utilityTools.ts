import DatabaseConnection from "../db/connection";
import { dbConfig } from "../config/config";
import { validateGetTableRelationships, validateGetAllTablesRelationships } from "../validation/schemas";
import fs from "fs";
import path from "path";

interface RuntimeToolDefinition {
  name: string;
  description?: string;
  inputSchema?: any;
  input_schema?: any;
  output_schema?: any;
}

interface ListAllToolsOptions {
  tools?: RuntimeToolDefinition[];
  enabledToolNames?: string[];
  accessProfile?: any;
  serverName?: string;
  serverVersion?: string;
}

export class UtilityTools {
  private db: DatabaseConnection;

  constructor() {
    this.db = DatabaseConnection.getInstance();
  }

  /**
   * Returns the current database connection info
   */
  async describeConnection(): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      // Return connection info without sensitive data
      const connectionInfo = {
        host: dbConfig.host,
        port: dbConfig.port,
        user: dbConfig.user,
        database: dbConfig.database,
        // Exclude password for security
      };

      return {
        status: "success",
        data: connectionInfo,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Tests the DB connection and returns latency
   */
  async testConnection(): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const result = await this.db.testConnection();

      if (!result.connected) {
        // Provide detailed diagnostics based on error code
        const errorCode = result.errorCode || "UNKNOWN";
        const errorMessage = result.error || "Unknown connection error";

        let diagnosticMessage = "❌ Database Connection Failed\n\n";
        diagnosticMessage += `Error: ${errorMessage}\n`;
        diagnosticMessage += `Error Code: ${errorCode}\n\n`;

        // Provide specific guidance based on error code
        if (
          errorCode === "ECONNREFUSED" ||
          errorCode === "ER_CONNECTION_REFUSED"
        ) {
          diagnosticMessage +=
            "🔍 Diagnosis: MySQL server is not accepting connections\n\n";
          diagnosticMessage += "✅ Troubleshooting Steps:\n";
          diagnosticMessage += "1. Check if MySQL server is running:\n";
          diagnosticMessage +=
            '   • Windows: Open Services and look for "MySQL" service\n';
          diagnosticMessage +=
            "   • Linux/Mac: Run `sudo systemctl status mysql` or `brew services list`\n";
          diagnosticMessage += "2. Start MySQL server if it's stopped:\n";
          diagnosticMessage +=
            "   • Windows: Start the MySQL service from Services panel\n";
          diagnosticMessage += "   • Linux: `sudo systemctl start mysql`\n";
          diagnosticMessage += "   • Mac: `brew services start mysql`\n";
          diagnosticMessage +=
            "3. Verify server is listening on the correct port (default: 3306)\n";
        } else if (errorCode === "ENOTFOUND" || errorCode === "EAI_AGAIN") {
          diagnosticMessage += "🔍 Diagnosis: Cannot resolve database host\n\n";
          diagnosticMessage += "✅ Troubleshooting Steps:\n";
          diagnosticMessage += "1. Check your DB_HOST configuration\n";
          diagnosticMessage += "2. Verify network connectivity\n";
          diagnosticMessage +=
            '3. If using "localhost", try "127.0.0.1" instead\n';
        } else if (errorCode === "ER_ACCESS_DENIED_ERROR") {
          diagnosticMessage += "🔍 Diagnosis: Authentication failed\n\n";
          diagnosticMessage += "✅ Troubleshooting Steps:\n";
          diagnosticMessage +=
            "1. Verify DB_USER and DB_PASSWORD in your configuration\n";
          diagnosticMessage += "2. Check MySQL user permissions\n";
          diagnosticMessage += "3. Ensure user has access from your host\n";
        } else if (errorCode === "ER_BAD_DB_ERROR") {
          diagnosticMessage += "🔍 Diagnosis: Database does not exist\n\n";
          diagnosticMessage += "✅ Troubleshooting Steps:\n";
          diagnosticMessage += "1. Verify DB_NAME in your configuration\n";
          diagnosticMessage += "2. Create the database if it doesn't exist\n";
          diagnosticMessage +=
            "3. Check database name spelling and case sensitivity\n";
        } else if (errorCode === "ETIMEDOUT" || errorCode === "ECONNABORTED") {
          diagnosticMessage += "🔍 Diagnosis: Connection timeout\n\n";
          diagnosticMessage += "✅ Troubleshooting Steps:\n";
          diagnosticMessage +=
            "1. Check if firewall is blocking MySQL port (3306)\n";
          diagnosticMessage +=
            "2. Verify MySQL is configured to accept remote connections\n";
          diagnosticMessage +=
            "3. Check network connectivity to database server\n";
        } else {
          diagnosticMessage += "✅ General Troubleshooting Steps:\n";
          diagnosticMessage += "1. Verify MySQL server is running\n";
          diagnosticMessage +=
            "2. Check connection settings in your .env file:\n";
          diagnosticMessage +=
            "   • DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME\n";
          diagnosticMessage += "3. Review MySQL server logs for details\n";
        }

        diagnosticMessage += "\n📋 Current Configuration:\n";
        diagnosticMessage += `   Host: ${(this.db as any).pool.pool.config.connectionConfig.host}\n`;
        diagnosticMessage += `   Port: ${(this.db as any).pool.pool.config.connectionConfig.port}\n`;
        diagnosticMessage += `   User: ${(this.db as any).pool.pool.config.connectionConfig.user}\n`;
        diagnosticMessage += `   Database: ${(this.db as any).pool.pool.config.connectionConfig.database}\n`;

        return {
          status: "error",
          error: diagnosticMessage,
          data: {
            connected: false,
            latency: -1,
            errorCode: errorCode,
            rawError: errorMessage,
          },
        };
      }

      return {
        status: "success",
        data: {
          connected: result.connected,
          latency: result.latency,
          message: `✅ Successfully connected to database in ${result.latency}ms`,
        },
      };
    } catch (error: any) {
      return {
        status: "error",
        error: `❌ Unexpected error while testing connection: ${error?.message || "Unknown error"}`,
      };
    }
  }

  /**
   * Detects and describes foreign key relationships between tables
   */
  async getTableRelationships(params: { table_name: string }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    // Validate input
    if (!validateGetTableRelationships(params)) {
      return {
        status: "error",
        error:
          "Invalid parameters: " +
          JSON.stringify(validateGetTableRelationships.errors),
      };
    }

    try {
      const { table_name } = params;

      // Query to get foreign keys where this table is the parent
      const parentQuery = `
        SELECT
          TABLE_NAME as child_table,
          COLUMN_NAME as child_column,
          REFERENCED_TABLE_NAME as parent_table,
          REFERENCED_COLUMN_NAME as parent_column,
          CONSTRAINT_NAME as constraint_name
        FROM
          INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE
          REFERENCED_TABLE_NAME = ?
          AND REFERENCED_TABLE_SCHEMA = DATABASE()
      `;

      // Query to get foreign keys where this table is the child
      const childQuery = `
        SELECT
          TABLE_NAME as child_table,
          COLUMN_NAME as child_column,
          REFERENCED_TABLE_NAME as parent_table,
          REFERENCED_COLUMN_NAME as parent_column,
          CONSTRAINT_NAME as constraint_name
        FROM
          INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE
          TABLE_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
          AND TABLE_SCHEMA = DATABASE()
      `;

      // Execute both queries
      const parentRelationships = await this.db.query<any[]>(parentQuery, [
        table_name,
      ]);
      const childRelationships = await this.db.query<any[]>(childQuery, [
        table_name,
      ]);

      return {
        status: "success",
        data: {
          as_parent: parentRelationships,
          as_child: childRelationships,
        },
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Gets foreign key relationships for ALL tables in a single call
   * Processes relationships in memory to avoid multiple queries
   */
  async getAllTablesRelationships(params?: { database?: string }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const databaseName = params?.database || (this.db as any).pool.pool.config.connectionConfig.database;

      // Get all tables in the database
      const tablesQuery = `
        SELECT TABLE_NAME as table_name
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
        AND TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `;

      const tablesResult = await this.db.query<any[]>(tablesQuery, [databaseName]);
      const tableNames = tablesResult.map(row => row.table_name);

      // Get ALL foreign key relationships in a single query
      const relationshipsQuery = `
        SELECT
          TABLE_NAME as child_table,
          COLUMN_NAME as child_column,
          REFERENCED_TABLE_NAME as parent_table,
          REFERENCED_COLUMN_NAME as parent_column,
          CONSTRAINT_NAME as constraint_name
        FROM
          INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE
          TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY
          REFERENCED_TABLE_NAME, TABLE_NAME
      `;

      const allRelationships = await this.db.query<any[]>(relationshipsQuery, [databaseName]);

      // Initialize result object with all tables having empty relationships
      const result: { [key: string]: { as_parent: any[], as_child: any[] } } = {};
      
      tableNames.forEach(tableName => {
        result[tableName] = {
          as_parent: [],
          as_child: []
        };
      });

      // Process relationships in memory
      allRelationships.forEach(relationship => {
        const { child_table, parent_table } = relationship;

        // Add to parent table's "as_parent" array
        if (result[parent_table]) {
          result[parent_table].as_parent.push({
            child_table: relationship.child_table,
            child_column: relationship.child_column,
            parent_table: relationship.parent_table,
            parent_column: relationship.parent_column,
            constraint_name: relationship.constraint_name
          });
        }

        // Add to child table's "as_child" array
        if (result[child_table]) {
          result[child_table].as_child.push({
            child_table: relationship.child_table,
            child_column: relationship.child_column,
            parent_table: relationship.parent_table,
            parent_column: relationship.parent_column,
            constraint_name: relationship.constraint_name
          });
        }
      });

      return {
        status: "success",
        data: {
          total_tables: tableNames.length,
          total_relationships: allRelationships.length,
          relationships: result
        }
      };

    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Lists all available tools in this MySQL MCP server
   */
  async listAllTools(params?: ListAllToolsOptions): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      let source = "runtime";
      let serverName = params?.serverName || "mysql-mcp-server";
      let serverVersion = params?.serverVersion || "unknown";
      let toolDefinitions: RuntimeToolDefinition[] = params?.tools || [];

      if (toolDefinitions.length === 0) {
        const manifestPath = path.resolve(__dirname, "..", "..", "manifest.json");

        if (!fs.existsSync(manifestPath)) {
          return {
            status: "error",
            error: "Runtime tool catalog was not supplied and manifest.json was not found.",
          };
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        source = "manifest_fallback";
        serverName = manifest.name || serverName;
        serverVersion = manifest.version || serverVersion;
        toolDefinitions = manifest.tools || [];
      }

      const enabledToolNames = new Set(params?.enabledToolNames || toolDefinitions.map((tool) => tool.name));
      const tools = toolDefinitions.map((tool) => ({
        name: tool.name,
        description: tool.description,
        enabled: enabledToolNames.has(tool.name),
        input_schema: tool.inputSchema || tool.input_schema || {},
        output_schema: tool.output_schema || { type: "object" },
      }));

      return {
        status: "success",
        data: {
          source,
          total_tools: tools.length,
          enabled_tools: tools.filter((tool) => tool.enabled).length,
          disabled_tools: tools.filter((tool) => !tool.enabled).length,
          server_name: serverName,
          server_version: serverVersion,
          access_profile: params?.accessProfile,
          agent_guidance: {
            recommended_first_calls: [
              "describe_connection",
              "list_databases",
              "list_tables",
              "get_schema_rag_context",
            ],
            workflows: {
              explore_schema: [
                "describe_connection",
                "list_tables",
                "get_database_summary",
                "get_schema_rag_context",
              ],
              discover_concept_location: [
                "find_tables_by_keyword",
                "search_schema",
                "read_table_schema on likely matches",
                "read_records on likely matches for verification",
                "search_data_across_tables only when the keyword may exist only in row data",
              ],
              inspect_table: [
                "read_table_schema",
                "get_column_statistics",
                "read_records",
              ],
              run_safe_query: [
                "get_schema_rag_context",
                "run_select_query with dry_run=true",
                "run_select_query",
              ],
              export_data: [
                "export_table_to_csv for simple table exports",
                "export_query_to_csv for SELECT query exports",
              ],
              modify_data: [
                "begin_transaction",
                "execute_in_transaction",
                "commit_transaction or rollback_transaction",
              ],
              seed_relational_data: [
                "infer_seed_rules or seed_from_template when domain/sample-based rules are useful",
                "plan_seed_data",
                "generate_seed_preview",
                "execute_seed_plan with dry_run=false and confirm_token after user approval",
                "validate_seed_integrity",
              ],
            },
            selection_rules: [
              "Use get_schema_rag_context before generating SQL to reduce token usage; add keyword_filter for concept-focused context.",
              "Use find_tables_by_keyword or search_schema when users ask which table stores a concept.",
              "Use search_data_across_tables only as a bounded fallback after schema metadata is inconclusive.",
              "Use run_select_query only for SELECT statements.",
              "Use execute_write_query for INSERT and UPDATE. DELETE requires the delete permission.",
              "Use execute_ddl only for CREATE, ALTER, DROP, TRUNCATE, and RENAME.",
              "Use seed_operations for relational dummy data instead of manually chaining bulk_insert across foreign keys.",
              "Prefer structured tools over raw SQL when possible.",
            ],
          },
          tools,
        },
      };

    } catch (error: any) {
      return {
        status: "error",
        error: `Failed to list tools: ${error.message}`,
      };
    }
  }

  /**
   * Reads the CHANGELOG.md file from the project root
   */
  async readChangelog(params?: { version?: string; limit?: number }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      // Resolve path relative to the built file (dist/tools/utilityTools.js -> ../../CHANGELOG.md)
      // or source file (src/tools/utilityTools.ts -> ../../CHANGELOG.md)
      const changelogPath = path.resolve(__dirname, "..", "..", "CHANGELOG.md");

      if (!fs.existsSync(changelogPath)) {
        return {
          status: "error",
          error: "CHANGELOG.md not found in the project root.",
        };
      }

      const content = fs.readFileSync(changelogPath, "utf-8");

      // If version specified, try to parse and find it
      if (params?.version) {
        // Simple parsing - look for headers like "## [1.2.3]"
        const versionHeader = `## [${params.version}]`;
        const lines = content.split("\n");
        let found = false;
        let versionContent = "";

        for (const line of lines) {
          if (line.startsWith(versionHeader)) {
            found = true;
            versionContent += line + "\n";
            continue;
          }
          if (found) {
            if (line.startsWith("## [")) break; // Next version starts
            versionContent += line + "\n";
          }
        }

        if (!found) {
          return {
            status: "error",
            error: `Version ${params.version} not found in CHANGELOG.md`,
          };
        }

        return {
          status: "success",
          data: {
            version: params.version,
            content: versionContent.trim(),
          },
        };
      }

      // If no version, return the whole file or top N characters/lines?
      // For now, let's return the most recent versions.
      // Limit default to 3000 chars to avoid overflowing context
      const maxLength = params?.limit || 5000;
      const truncated = content.length > maxLength
        ? content.substring(0, maxLength) + "\n... (truncated)"
        : content;

      return {
        status: "success",
        data: {
          content: truncated,
        },
      };

    } catch (error: any) {
      return {
        status: "error",
        error: `Failed to read changelog: ${error.message}`,
      };
    }
  }
}
