import DatabaseConnection from "../db/connection";
import { SecurityLayer } from "../security/securityLayer";

export class DdlTools {
  private db: DatabaseConnection;
  private security: SecurityLayer;

  constructor(security: SecurityLayer) {
    this.db = DatabaseConnection.getInstance();
    this.security = security;
  }

  /**
   * Sanitize default value for SQL safety
   */
  private sanitizeDefaultValue(defaultValue: any): string {
    if (defaultValue === null || defaultValue === undefined) {
      return "NULL";
    }

    if (typeof defaultValue === "number") {
      return String(defaultValue);
    }

    if (typeof defaultValue === "boolean") {
      return defaultValue ? "1" : "0";
    }

    if (typeof defaultValue === "string") {
      // Check for dangerous SQL patterns in default values
      const dangerousPatterns = [
        /;/g, // Statement separators
        /--/g, // SQL comments
        /\/\*/g, // Block comment start
        /\*\//g, // Block comment end
        /\bUNION\b/gi, // UNION operations
        /\bSELECT\b/gi, // SELECT statements
        /\bINSERT\b/gi, // INSERT statements
        /\bUPDATE\b/gi, // UPDATE statements
        /\bDELETE\b/gi, // DELETE statements
        /\bDROP\b/gi, // DROP statements
        /\bCREATE\b/gi, // CREATE statements
        /\bALTER\b/gi, // ALTER statements
      ];

      let sanitized = defaultValue;
      for (const pattern of dangerousPatterns) {
        if (pattern.test(sanitized)) {
          throw new Error(
            `Dangerous SQL pattern detected in default value: ${pattern.source}`,
          );
        }
      }

      // Escape single quotes and backslashes
      sanitized = sanitized.replace(/\\/g, "\\\\").replace(/'/g, "''");

      return `'${sanitized}'`;
    }

    // For other types, convert to string and escape
    return `'${String(defaultValue).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }

  private validateColumnType(columnType: string): { valid: boolean; error?: string } {
    if (!columnType || typeof columnType !== "string") {
      return { valid: false, error: "Column type must be a non-empty string" };
    }

    const normalizedType = columnType.trim().replace(/\s+/g, " ");
    if (normalizedType.length > 128) {
      return { valid: false, error: "Column type is too long" };
    }

    const safeTypePattern =
      /^(?:(?:TINY|SMALL|MEDIUM|BIG)?INT(?:EGER)?|DECIMAL|NUMERIC|FLOAT|DOUBLE(?: PRECISION)?|REAL|BIT|BOOL(?:EAN)?|CHAR|VARCHAR|BINARY|VARBINARY|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|DATE|DATETIME|TIMESTAMP|TIME|YEAR|JSON)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+(?:UNSIGNED|ZEROFILL))*$/i;

    if (!safeTypePattern.test(normalizedType)) {
      return {
        valid: false,
        error:
          "Invalid or unsupported column type. Use a standard MySQL data type such as INT, VARCHAR(255), DECIMAL(10,2), TEXT, DATETIME, or JSON.",
      };
    }

    return { valid: true };
  }

  private validateIdentifier(identifier: string, label: string): { valid: boolean; error?: string } {
    const validation = this.security.validateIdentifier(identifier);
    if (!validation.valid) {
      return {
        valid: false,
        error: `Invalid ${label}: ${validation.error}`,
      };
    }
    return { valid: true };
  }

  /**
   * Create a new table
   */
  async createTable(params: {
    table_name: string;
    columns: Array<{
      name: string;
      type: string;
      nullable?: boolean;
      primary_key?: boolean;
      auto_increment?: boolean;
      default?: string;
    }>;
    indexes?: Array<{
      name: string;
      columns: string[];
      unique?: boolean;
    }>;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const { table_name, columns, indexes } = params;

      const tableValidation = this.validateIdentifier(table_name, "table name");
      if (!tableValidation.valid) {
        return { status: "error", error: tableValidation.error };
      }

      if (!Array.isArray(columns) || columns.length === 0) {
        return { status: "error", error: "At least one column is required" };
      }

      const escapedTableName = this.security.escapeIdentifier(table_name);

      // Build column definitions
      const columnDefs = columns
        .map((col) => {
          const columnValidation = this.validateIdentifier(col.name, "column name");
          if (!columnValidation.valid) {
            throw new Error(columnValidation.error);
          }

          const typeValidation = this.validateColumnType(col.type);
          if (!typeValidation.valid) {
            throw new Error(`Invalid column type for '${col.name}': ${typeValidation.error}`);
          }

          let def = `${this.security.escapeIdentifier(col.name)} ${col.type.trim()}`;

          if (col.nullable === false) {
            def += " NOT NULL";
          }

          if (col.auto_increment) {
            def += " AUTO_INCREMENT";
          }

          if (col.default !== undefined) {
            // SECURITY: Properly sanitize default values to prevent SQL injection
            const sanitizedDefault = this.sanitizeDefaultValue(col.default);
            def += ` DEFAULT ${sanitizedDefault}`;
          }

          if (col.primary_key) {
            def += " PRIMARY KEY";
          }

          return def;
        })
        .join(", ");

      // Build the CREATE TABLE query
      let query = `CREATE TABLE ${escapedTableName} (${columnDefs})`;

      // Execute the query
      await this.db.query(query);

      // Create indexes if specified
      let queryCount = 1;
      if (indexes && indexes.length > 0) {
        for (const index of indexes) {
          const indexValidation = this.validateIdentifier(index.name, "index name");
          if (!indexValidation.valid) {
            return { status: "error", error: indexValidation.error };
          }

          if (!Array.isArray(index.columns) || index.columns.length === 0) {
            return { status: "error", error: "Index columns are required" };
          }

          const indexType = index.unique ? "UNIQUE INDEX" : "INDEX";
          const indexColumns = index.columns.map((c) => {
            const columnValidation = this.validateIdentifier(c, "index column name");
            if (!columnValidation.valid) {
              throw new Error(columnValidation.error);
            }
            return this.security.escapeIdentifier(c);
          }).join(", ");
          const indexQuery = `CREATE ${indexType} ${this.security.escapeIdentifier(index.name)} ON ${escapedTableName} (${indexColumns})`;
          await this.db.query(indexQuery);
          queryCount++;
        }
      }

      return {
        status: "success",
        data: {
          message: `Table '${table_name}' created successfully`,
          table_name,
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
   * Alter an existing table
   */
  async alterTable(params: {
    table_name: string;
    operations: Array<{
      type:
      | "add_column"
      | "drop_column"
      | "modify_column"
      | "rename_column"
      | "add_index"
      | "drop_index";
      column_name?: string;
      new_column_name?: string;
      column_type?: string;
      nullable?: boolean;
      default?: string;
      index_name?: string;
      index_columns?: string[];
      unique?: boolean;
    }>;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const { table_name, operations } = params;

      const tableValidation = this.validateIdentifier(table_name, "table name");
      if (!tableValidation.valid) {
        return { status: "error", error: tableValidation.error };
      }

      if (!Array.isArray(operations) || operations.length === 0) {
        return { status: "error", error: "At least one alter operation is required" };
      }

      const escapedTableName = this.security.escapeIdentifier(table_name);

      for (const op of operations) {
        let query = `ALTER TABLE ${escapedTableName}`;

        switch (op.type) {
          case "add_column":
            if (!op.column_name || !op.column_type) {
              return {
                status: "error",
                error: "column_name and column_type required for add_column",
              };
            }
            const addColumnValidation = this.validateIdentifier(op.column_name, "column name");
            if (!addColumnValidation.valid) return { status: "error", error: addColumnValidation.error };
            const addTypeValidation = this.validateColumnType(op.column_type);
            if (!addTypeValidation.valid) return { status: "error", error: addTypeValidation.error };
            query += ` ADD COLUMN ${this.security.escapeIdentifier(op.column_name)} ${op.column_type.trim()}`;
            if (op.nullable === false) query += " NOT NULL";
            if (op.default !== undefined) {
              // SECURITY: Properly sanitize default values to prevent SQL injection
              const sanitizedDefault = this.sanitizeDefaultValue(op.default);
              query += ` DEFAULT ${sanitizedDefault}`;
            }
            break;

          case "drop_column":
            if (!op.column_name) {
              return {
                status: "error",
                error: "column_name required for drop_column",
              };
            }
            const dropColumnValidation = this.validateIdentifier(op.column_name, "column name");
            if (!dropColumnValidation.valid) return { status: "error", error: dropColumnValidation.error };
            query += ` DROP COLUMN ${this.security.escapeIdentifier(op.column_name)}`;
            break;

          case "modify_column":
            if (!op.column_name || !op.column_type) {
              return {
                status: "error",
                error: "column_name and column_type required for modify_column",
              };
            }
            const modifyColumnValidation = this.validateIdentifier(op.column_name, "column name");
            if (!modifyColumnValidation.valid) return { status: "error", error: modifyColumnValidation.error };
            const modifyTypeValidation = this.validateColumnType(op.column_type);
            if (!modifyTypeValidation.valid) return { status: "error", error: modifyTypeValidation.error };
            query += ` MODIFY COLUMN ${this.security.escapeIdentifier(op.column_name)} ${op.column_type.trim()}`;
            if (op.nullable === false) query += " NOT NULL";
            if (op.default !== undefined) {
              // SECURITY: Properly sanitize default values to prevent SQL injection
              const sanitizedDefault = this.sanitizeDefaultValue(op.default);
              query += ` DEFAULT ${sanitizedDefault}`;
            }
            break;

          case "rename_column":
            if (!op.column_name || !op.new_column_name || !op.column_type) {
              return {
                status: "error",
                error:
                  "column_name, new_column_name, and column_type required for rename_column",
              };
            }
            const oldColumnValidation = this.validateIdentifier(op.column_name, "column name");
            if (!oldColumnValidation.valid) return { status: "error", error: oldColumnValidation.error };
            const newColumnValidation = this.validateIdentifier(op.new_column_name, "new column name");
            if (!newColumnValidation.valid) return { status: "error", error: newColumnValidation.error };
            const renameTypeValidation = this.validateColumnType(op.column_type);
            if (!renameTypeValidation.valid) return { status: "error", error: renameTypeValidation.error };
            query += ` CHANGE COLUMN ${this.security.escapeIdentifier(op.column_name)} ${this.security.escapeIdentifier(op.new_column_name)} ${op.column_type.trim()}`;
            break;

          case "add_index":
            if (!op.index_name || !op.index_columns) {
              return {
                status: "error",
                error: "index_name and index_columns required for add_index",
              };
            }
            const addIndexValidation = this.validateIdentifier(op.index_name, "index name");
            if (!addIndexValidation.valid) return { status: "error", error: addIndexValidation.error };
            const indexType = op.unique ? "UNIQUE INDEX" : "INDEX";
            const columns = op.index_columns.map((c) => {
              const columnValidation = this.validateIdentifier(c, "index column name");
              if (!columnValidation.valid) {
                throw new Error(columnValidation.error);
              }
              return this.security.escapeIdentifier(c);
            }).join(", ");
            query += ` ADD ${indexType} ${this.security.escapeIdentifier(op.index_name)} (${columns})`;
            break;

          case "drop_index":
            if (!op.index_name) {
              return {
                status: "error",
                error: "index_name required for drop_index",
              };
            }
            const dropIndexValidation = this.validateIdentifier(op.index_name, "index name");
            if (!dropIndexValidation.valid) return { status: "error", error: dropIndexValidation.error };
            query += ` DROP INDEX ${this.security.escapeIdentifier(op.index_name)}`;
            break;

          default:
            return {
              status: "error",
              error: `Unknown operation type: ${op.type}`,
            };
        }

        await this.db.query(query);
      }

      return {
        status: "success",
        data: {
          message: `Table '${table_name}' altered successfully`,
          table_name,
          operations_count: operations.length,
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
   * Drop a table
   */
  async dropTable(params: {
    table_name: string;
    if_exists?: boolean;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const { table_name, if_exists } = params;

      const tableValidation = this.validateIdentifier(table_name, "table name");
      if (!tableValidation.valid) {
        return { status: "error", error: tableValidation.error };
      }

      const ifExistsClause = if_exists ? "IF EXISTS " : "";
      const query = `DROP TABLE ${ifExistsClause}${this.security.escapeIdentifier(table_name)}`;

      await this.db.query(query);

      return {
        status: "success",
        data: {
          message: `Table '${table_name}' dropped successfully`,
          table_name,
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
   * Execute raw DDL SQL
   */
  async executeDdl(params: { query: string }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const { query } = params;

      const queryValidation = this.security.validateQuery(query);
      if (!queryValidation.valid) {
        return {
          status: "error",
          error: `DDL validation failed: ${queryValidation.error}`,
        };
      }

      const isDdl = ["CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"].includes(
        queryValidation.queryType || "",
      );

      if (!isDdl) {
        return {
          status: "error",
          error:
            "Only DDL operations (CREATE, ALTER, DROP, TRUNCATE, RENAME) are allowed with execute_ddl. For SELECT queries, use the 'run_select_query' tool instead. For INSERT/UPDATE/DELETE, use the 'execute_write_query' tool.",
        };
      }

      const result = await this.db.query<any>(query);

      return {
        status: "success",
        data: {
          message: "DDL query executed successfully",
          affected_rows: result.affectedRows || 0,
        },
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }
}
