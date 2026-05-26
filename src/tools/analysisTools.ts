import DatabaseConnection from "../db/connection";
import { SecurityLayer } from "../security/securityLayer";
import { dbConfig } from "../config/config";

type SchemaSearchScope = "table_names" | "column_names" | "comments" | "all";
type SearchSchemaMode = "table_names" | "column_names" | "comments" | "sample_data";

interface SchemaKeywordMatch {
  table_name: string;
  row_estimate: number;
  score: number;
  matched_on: string[];
  matched_fields: Array<{
    type: string;
    field: string;
    value?: string;
    score: number;
  }>;
  column_names: string[];
  table_comment?: string;
}

export class AnalysisTools {
  private db: DatabaseConnection;
  private security: SecurityLayer;

  constructor(security: SecurityLayer) {
    this.db = DatabaseConnection.getInstance();
    this.security = security;
  }

  /**
   * Validate database access - ensures only the connected database can be accessed
   */
  private validateDatabaseAccess(requestedDatabase?: string): {
    valid: boolean;
    database: string;
    error?: string;
  } {
    const connectedDatabase = dbConfig.database;

    if (!connectedDatabase) {
      return {
        valid: false,
        database: "",
        error:
          "No database specified in connection string. Cannot access any database.",
      };
    }

    if (!requestedDatabase) {
      return {
        valid: true,
        database: connectedDatabase,
      };
    }

    if (requestedDatabase !== connectedDatabase) {
      return {
        valid: false,
        database: "",
        error: `Access denied. You can only access the connected database '${connectedDatabase}'. Requested database '${requestedDatabase}' is not allowed.`,
      };
    }

    return {
      valid: true,
      database: connectedDatabase,
    };
  }

  private clampNumber(value: any, fallback: number, min: number, max: number): number {
    const numeric = Number(value ?? fallback);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(Math.max(Math.floor(numeric), min), max);
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }

  private quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, "``")}\``;
  }

  private truncateValue(value: any, maxLength = 180): string {
    if (value === null || value === undefined) return "";
    const stringValue = typeof value === "string" ? value : JSON.stringify(value);
    if (stringValue.length <= maxLength) return stringValue;
    return `${stringValue.slice(0, maxLength)}...`;
  }

  private getMatchScore(value: any, keyword: string, baseScore: number): number {
    if (value === null || value === undefined) return 0;

    const normalizedValue = String(value).toLowerCase();
    const normalizedKeyword = keyword.toLowerCase();

    if (!normalizedValue || !normalizedKeyword) return 0;
    if (normalizedValue === normalizedKeyword) return baseScore;
    if (normalizedValue.startsWith(normalizedKeyword)) return Math.max(baseScore - 10, 1);
    if (normalizedValue.includes(normalizedKeyword)) return Math.max(baseScore - 20, 1);
    return 0;
  }

  private addMatchedField(
    match: SchemaKeywordMatch,
    field: SchemaKeywordMatch["matched_fields"][number],
  ): void {
    const key = `${field.type}:${field.field}:${field.value || ""}`;
    const exists = match.matched_fields.some(
      (item) => `${item.type}:${item.field}:${item.value || ""}` === key,
    );

    if (!exists) {
      match.matched_fields.push(field);
    }

    if (!match.matched_on.includes(field.type)) {
      match.matched_on.push(field.type);
    }

    match.score = Math.max(match.score, field.score);
  }

  private async getTablesByName(database: string, tableNames: string[]): Promise<any[]> {
    if (!tableNames.length) return [];

    const placeholders = tableNames.map(() => "?").join(",");
    return await this.db.query<any[]>(
      `
        SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME IN (${placeholders})
        ORDER BY TABLE_NAME
      `,
      [database, ...tableNames],
    );
  }

  /**
   * Get statistics for a specific column
   */
  async getColumnStatistics(params: {
    table_name: string;
    column_name: string;
    database?: string;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const dbValidation = this.validateDatabaseAccess(params?.database);
      if (!dbValidation.valid) {
        return { status: "error", error: dbValidation.error! };
      }

      const { table_name, column_name } = params;
      const database = dbValidation.database;

      // Validate names
      if (!this.security.validateIdentifier(table_name).valid) {
        return { status: "error", error: "Invalid table name" };
      }
      if (!this.security.validateIdentifier(column_name).valid) {
        return { status: "error", error: "Invalid column name" };
      }

      // Check if column exists and get its type
      const colCheckQuery = `
        SELECT DATA_TYPE 
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      `;
      const colCheck = await this.db.query<any[]>(colCheckQuery, [
        database,
        table_name,
        column_name,
      ]);

      if (colCheck.length === 0) {
        return {
          status: "error",
          error: `Column '${column_name}' not found in table '${table_name}'`,
        };
      }

      const dataType = colCheck[0].DATA_TYPE;
      const isNumeric = [
        "int",
        "tinyint",
        "smallint",
        "mediumint",
        "bigint",
        "float",
        "double",
        "decimal",
      ].includes(dataType);
      const isDate = [
        "date",
        "datetime",
        "timestamp",
        "time",
        "year",
      ].includes(dataType);

      // Build statistics query
      let query = `
        SELECT
          COUNT(*) as total_rows,
          COUNT(\`${column_name}\`) as non_null_count,
          COUNT(DISTINCT \`${column_name}\`) as distinct_count,
          SUM(CASE WHEN \`${column_name}\` IS NULL THEN 1 ELSE 0 END) as null_count
      `;

      if (isNumeric || isDate) {
        query += `,
          MIN(\`${column_name}\`) as min_value,
          MAX(\`${column_name}\`) as max_value
        `;
      }

      if (isNumeric) {
        query += `,
          AVG(\`${column_name}\`) as avg_value
        `;
      }

      query += ` FROM \`${database}\`.\`${table_name}\``;

      const statsResult = await this.db.query<any[]>(query);
      const stats = statsResult[0];

      // Get top frequent values
      const topValuesQuery = `
        SELECT \`${column_name}\` as value, COUNT(*) as count
        FROM \`${database}\`.\`${table_name}\`
        GROUP BY \`${column_name}\`
        ORDER BY count DESC
        LIMIT 5
      `;
      const topValues = await this.db.query<any[]>(topValuesQuery);

      return {
        status: "success",
        data: {
          column_name,
          data_type: dataType,
          statistics: {
            total_rows: stats.total_rows,
            non_null_count: stats.non_null_count,
            null_count: stats.null_count,
            distinct_count: stats.distinct_count,
            unique_ratio:
              stats.total_rows > 0
                ? (stats.distinct_count / stats.total_rows).toFixed(4)
                : 0,
            ...(isNumeric || isDate
              ? { min_value: stats.min_value, max_value: stats.max_value }
              : {}),
            ...(isNumeric ? { avg_value: stats.avg_value } : {}),
          },
          top_values: topValues,
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
   * Find candidate tables by keyword across schema metadata.
   */
  async findTablesByKeyword(params: {
    keyword: string;
    search_in?: SchemaSearchScope;
    database?: string;
    limit?: number;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const dbValidation = this.validateDatabaseAccess(params?.database);
      if (!dbValidation.valid) {
        return { status: "error", error: dbValidation.error! };
      }

      const keyword = params.keyword?.trim();
      if (!keyword) {
        return { status: "error", error: "keyword is required" };
      }

      const searchIn = params.search_in || "all";
      if (!["table_names", "column_names", "comments", "all"].includes(searchIn)) {
        return {
          status: "error",
          error: "search_in must be one of table_names, column_names, comments, all",
        };
      }

      const limit = this.clampNumber(params.limit, 20, 1, 100);
      const database = dbValidation.database;
      const likePattern = `%${this.escapeLikePattern(keyword)}%`;
      const conditions: string[] = [];
      const queryParams: any[] = [database];

      if (searchIn === "table_names" || searchIn === "all") {
        conditions.push("t.TABLE_NAME LIKE ? ESCAPE '\\\\'");
        queryParams.push(likePattern);
      }

      if (searchIn === "column_names" || searchIn === "all") {
        conditions.push("c.COLUMN_NAME LIKE ? ESCAPE '\\\\'");
        queryParams.push(likePattern);
      }

      if (searchIn === "comments" || searchIn === "all") {
        conditions.push(
          "(t.TABLE_COMMENT LIKE ? ESCAPE '\\\\' OR c.COLUMN_COMMENT LIKE ? ESCAPE '\\\\')",
        );
        queryParams.push(likePattern, likePattern);
      }

      const rows = await this.db.query<any[]>(
        `
          SELECT
            t.TABLE_NAME,
            t.TABLE_ROWS,
            t.TABLE_COMMENT,
            c.COLUMN_NAME,
            c.COLUMN_COMMENT,
            c.ORDINAL_POSITION
          FROM INFORMATION_SCHEMA.TABLES t
          LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
            ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
           AND c.TABLE_NAME = t.TABLE_NAME
          WHERE t.TABLE_SCHEMA = ?
            AND (${conditions.join(" OR ")})
          ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
        `,
        queryParams,
      );

      const matchMap = new Map<string, SchemaKeywordMatch>();
      const allowsTable = searchIn === "table_names" || searchIn === "all";
      const allowsColumn = searchIn === "column_names" || searchIn === "all";
      const allowsComments = searchIn === "comments" || searchIn === "all";

      for (const row of rows) {
        if (!matchMap.has(row.TABLE_NAME)) {
          matchMap.set(row.TABLE_NAME, {
            table_name: row.TABLE_NAME,
            row_estimate:
              typeof row.TABLE_ROWS === "number"
                ? row.TABLE_ROWS
                : parseInt(row.TABLE_ROWS || "0", 10) || 0,
            score: 0,
            matched_on: [],
            matched_fields: [],
            column_names: [],
            table_comment: row.TABLE_COMMENT || undefined,
          });
        }

        const match = matchMap.get(row.TABLE_NAME)!;
        if (row.COLUMN_NAME && !match.column_names.includes(row.COLUMN_NAME)) {
          match.column_names.push(row.COLUMN_NAME);
        }

        if (allowsTable) {
          const score = this.getMatchScore(row.TABLE_NAME, keyword, 100);
          if (score > 0) {
            this.addMatchedField(match, {
              type: "table_name",
              field: row.TABLE_NAME,
              score,
            });
          }
        }

        if (allowsColumn && row.COLUMN_NAME) {
          const score = this.getMatchScore(row.COLUMN_NAME, keyword, 90);
          if (score > 0) {
            this.addMatchedField(match, {
              type: "column_name",
              field: row.COLUMN_NAME,
              score,
            });
          }
        }

        if (allowsComments) {
          const tableCommentScore = this.getMatchScore(row.TABLE_COMMENT, keyword, 75);
          if (tableCommentScore > 0) {
            this.addMatchedField(match, {
              type: "table_comment",
              field: "TABLE_COMMENT",
              value: this.truncateValue(row.TABLE_COMMENT),
              score: tableCommentScore,
            });
          }

          const columnCommentScore = this.getMatchScore(row.COLUMN_COMMENT, keyword, 65);
          if (columnCommentScore > 0) {
            this.addMatchedField(match, {
              type: "column_comment",
              field: row.COLUMN_NAME,
              value: this.truncateValue(row.COLUMN_COMMENT),
              score: columnCommentScore,
            });
          }
        }
      }

      const matches = Array.from(matchMap.values())
        .map((match) => ({
          ...match,
          score: Math.min(
            100,
            match.score + Math.min(20, Math.max(match.matched_fields.length - 1, 0) * 5),
          ),
        }))
        .sort((a, b) => b.score - a.score || a.table_name.localeCompare(b.table_name))
        .slice(0, limit);

      return {
        status: "success",
        data: {
          database,
          keyword,
          search_in: searchIn,
          matches,
          total_matches: matches.length,
          recommended_next_steps: matches.slice(0, 5).flatMap((match) => [
            `read_table_schema({ table_name: '${match.table_name}' })`,
            `read_records({ table_name: '${match.table_name}', pagination: { page: 1, limit: 5 } })`,
          ]),
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
   * Guarded read-only keyword search across text-like data columns.
   */
  async searchDataAcrossTables(params: {
    keyword: string;
    tables?: string[];
    columns?: string[];
    database?: string;
    limit_per_table?: number;
    max_tables?: number;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const dbValidation = this.validateDatabaseAccess(params?.database);
      if (!dbValidation.valid) {
        return { status: "error", error: dbValidation.error! };
      }

      const keyword = params.keyword?.trim();
      if (!keyword) {
        return { status: "error", error: "keyword is required" };
      }

      const database = dbValidation.database;
      const maxTables = this.clampNumber(params.max_tables, 20, 1, 100);
      const limitPerTable = this.clampNumber(params.limit_per_table, 5, 1, 20);

      if (params.tables) {
        for (const table of params.tables) {
          if (!this.security.validateIdentifier(table).valid) {
            return { status: "error", error: `Invalid table name: ${table}` };
          }
        }
      }

      if (params.columns) {
        for (const column of params.columns) {
          if (!this.security.validateIdentifier(column).valid) {
            return { status: "error", error: `Invalid column name: ${column}` };
          }
        }
      }

      const candidateTables = params.tables?.length
        ? (await this.getTablesByName(database, params.tables)).slice(0, maxTables)
        : await this.db.query<any[]>(
            `
              SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
              FROM INFORMATION_SCHEMA.TABLES
              WHERE TABLE_SCHEMA = ?
              ORDER BY TABLE_NAME
              LIMIT ?
            `,
            [database, maxTables],
          );

      if (!candidateTables.length) {
        return {
          status: "success",
          data: {
            database,
            keyword,
            matches: [],
            total_hits: 0,
            tables_scanned: 0,
            message: "No tables found to scan.",
          },
        };
      }

      const tableNames = candidateTables.map((table) => table.TABLE_NAME);
      const tablePlaceholders = tableNames.map(() => "?").join(",");
      const textTypes = [
        "char",
        "varchar",
        "tinytext",
        "text",
        "mediumtext",
        "longtext",
        "json",
        "enum",
        "set",
      ];
      const typePlaceholders = textTypes.map(() => "?").join(",");
      const columnParams: any[] = [database, ...tableNames, ...textTypes];
      let columnFilter = "";

      if (params.columns?.length) {
        columnFilter = ` AND COLUMN_NAME IN (${params.columns.map(() => "?").join(",")})`;
        columnParams.push(...params.columns);
      }

      const columns = await this.db.query<any[]>(
        `
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME IN (${tablePlaceholders})
            AND DATA_TYPE IN (${typePlaceholders})
            ${columnFilter}
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `,
        columnParams,
      );

      const columnsByTable = new Map<string, any[]>();
      for (const column of columns) {
        if (!columnsByTable.has(column.TABLE_NAME)) {
          columnsByTable.set(column.TABLE_NAME, []);
        }
        columnsByTable.get(column.TABLE_NAME)!.push(column);
      }

      const likePattern = `%${this.escapeLikePattern(keyword)}%`;
      const keywordLower = keyword.toLowerCase();
      const matches: any[] = [];
      const skippedTables: Array<{ table_name: string; reason: string }> = [];

      for (const table of candidateTables) {
        const tableColumns = columnsByTable.get(table.TABLE_NAME) || [];
        if (!tableColumns.length) {
          skippedTables.push({
            table_name: table.TABLE_NAME,
            reason: "No searchable text-like columns found.",
          });
          continue;
        }

        const selectList = tableColumns
          .map((column) => `CAST(${this.quoteIdentifier(column.COLUMN_NAME)} AS CHAR) AS ${this.quoteIdentifier(column.COLUMN_NAME)}`)
          .join(", ");
        const whereClause = tableColumns
          .map((column) => `CAST(${this.quoteIdentifier(column.COLUMN_NAME)} AS CHAR) LIKE ? ESCAPE '\\\\'`)
          .join(" OR ");
        const queryParams = [...tableColumns.map(() => likePattern), limitPerTable];
        const dataRows = await this.db.query<any[]>(
          `
            SELECT ${selectList}
            FROM ${this.quoteIdentifier(database)}.${this.quoteIdentifier(table.TABLE_NAME)}
            WHERE ${whereClause}
            LIMIT ?
          `,
          queryParams,
          false,
        );

        if (!dataRows.length) {
          continue;
        }

        const rowHits = dataRows
          .map((row) => {
            const matchedColumns = tableColumns
              .map((column) => {
                const rawValue = row[column.COLUMN_NAME];
                const sampleValue = this.truncateValue(rawValue);
                return sampleValue.toLowerCase().includes(keywordLower)
                  ? {
                      column_name: column.COLUMN_NAME,
                      data_type: column.DATA_TYPE,
                      sample_value: sampleValue,
                    }
                  : undefined;
              })
              .filter(Boolean);

            return matchedColumns.length
              ? {
                  matched_columns: matchedColumns,
                }
              : undefined;
          })
          .filter(Boolean);

        if (rowHits.length) {
          matches.push({
            table_name: table.TABLE_NAME,
            row_estimate:
              typeof table.TABLE_ROWS === "number"
                ? table.TABLE_ROWS
                : parseInt(table.TABLE_ROWS || "0", 10) || 0,
            hit_count: rowHits.length,
            hits: rowHits,
          });
        }
      }

      return {
        status: "success",
        data: {
          database,
          keyword,
          matches,
          total_hits: matches.reduce((sum, match) => sum + match.hit_count, 0),
          tables_scanned: candidateTables.length - skippedTables.length,
          skipped_tables: skippedTables,
          limits: {
            max_tables: maxTables,
            limit_per_table: limitPerTable,
          },
          recommended_next_steps: matches.slice(0, 5).flatMap((match) => [
            `read_table_schema({ table_name: '${match.table_name}' })`,
            `read_records({ table_name: '${match.table_name}', pagination: { page: 1, limit: 5 } })`,
          ]),
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
   * Unified discovery entry point for "where is X?" questions.
   */
  async searchSchema(params: {
    query: string;
    modes?: SearchSchemaMode[];
    max_results?: number;
    database?: string;
    tables?: string[];
    columns?: string[];
    max_tables?: number;
    limit_per_table?: number;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const dbValidation = this.validateDatabaseAccess(params?.database);
      if (!dbValidation.valid) {
        return { status: "error", error: dbValidation.error! };
      }

      const query = params.query?.trim();
      if (!query) {
        return { status: "error", error: "query is required" };
      }

      const database = dbValidation.database;
      const maxResults = this.clampNumber(params.max_results, 20, 1, 100);
      const modes = params.modes?.length
        ? Array.from(new Set(params.modes))
        : ["table_names", "column_names", "comments"];
      const validModes = ["table_names", "column_names", "comments", "sample_data"];
      for (const mode of modes) {
        if (!validModes.includes(mode)) {
          return {
            status: "error",
            error: `Invalid mode '${mode}'. Must be one of ${validModes.join(", ")}`,
          };
        }
      }

      const schemaModes = modes.filter((mode) => mode !== "sample_data");
      const combinedMatches: any[] = [];
      let schemaMatches: any[] = [];
      let dataMatches: any[] = [];

      if (schemaModes.length) {
        const schemaResult = await this.findTablesByKeyword({
          keyword: query,
          search_in: schemaModes.length === 1 ? schemaModes[0] as SchemaSearchScope : "all",
          database,
          limit: maxResults,
        });

        if (schemaResult.status === "error") {
          return schemaResult;
        }

        const allowedTypes = new Set(
          schemaModes.flatMap((mode) =>
            mode === "comments"
              ? ["table_comment", "column_comment"]
              : [mode === "table_names" ? "table_name" : "column_name"],
          ),
        );

        schemaMatches = (schemaResult.data?.matches || [])
          .map((match: any) => ({
            ...match,
            matched_fields: match.matched_fields.filter((field: any) =>
              allowedTypes.has(field.type),
            ),
          }))
          .filter((match: any) => match.matched_fields.length)
          .map((match: any) => ({
            source: "schema",
            table_name: match.table_name,
            match_type: match.matched_fields[0]?.type || "schema",
            score: match.score,
            columns: match.column_names,
            row_estimate: match.row_estimate,
            matched_fields: match.matched_fields,
            table_comment: match.table_comment,
          }));

        combinedMatches.push(...schemaMatches);
      }

      if (modes.includes("sample_data")) {
        const dataResult = await this.searchDataAcrossTables({
          keyword: query,
          database,
          tables: params.tables,
          columns: params.columns,
          max_tables: params.max_tables,
          limit_per_table: params.limit_per_table,
        });

        if (dataResult.status === "error") {
          return dataResult;
        }

        dataMatches = (dataResult.data?.matches || []).map((match: any) => ({
          source: "sample_data",
          table_name: match.table_name,
          match_type: "sample_data",
          score: 50,
          row_estimate: match.row_estimate,
          hit_count: match.hit_count,
          hits: match.hits,
        }));

        combinedMatches.push(...dataMatches);
      }

      const matches = combinedMatches
        .sort((a, b) => b.score - a.score || a.table_name.localeCompare(b.table_name))
        .slice(0, maxResults);

      return {
        status: "success",
        data: {
          database,
          query,
          modes,
          matches,
          schema_matches: schemaMatches,
          data_matches: dataMatches,
          total_matches: matches.length,
          recommended_next_steps: Array.from(
            new Set(
              matches.slice(0, 5).flatMap((match) => [
                `read_table_schema({ table_name: '${match.table_name}' })`,
                `read_records({ table_name: '${match.table_name}', pagination: { page: 1, limit: 5 } })`,
              ]),
            ),
          ),
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
   * Build a compact, schema-aware context pack for RAG (tables, PK/FK, columns, row estimates)
   */
  async getSchemaRagContext(params: {
    database?: string;
    max_tables?: number;
    max_columns?: number;
    include_relationships?: boolean;
    include_comments?: boolean;
    keyword_filter?: string;
  } = {}): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const dbValidation = this.validateDatabaseAccess(params?.database);
      if (!dbValidation.valid) {
        return { status: "error", error: dbValidation.error! };
      }

      const database = dbValidation.database;
      const maxTables = this.clampNumber(params.max_tables, 50, 1, 200);
      const maxColumns = this.clampNumber(params.max_columns, 12, 1, 200);
      const includeRelationships = params.include_relationships ?? true;
      const includeComments = params.include_comments ?? false;
      const keywordFilter = params.keyword_filter?.trim();

      // Count total tables for truncation note
      const totalTablesResult = await this.db.query<any[]>(
        `SELECT COUNT(*) as total FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
        [database],
      );
      const totalTables = totalTablesResult[0]?.total ?? 0;

      // Fetch tables limited for context pack. Keyword searches are relevance ordered.
      let tables: any[];
      if (keywordFilter) {
        const searchResult = await this.findTablesByKeyword({
          keyword: keywordFilter,
          search_in: "all",
          database,
          limit: maxTables,
        });

        if (searchResult.status === "error") {
          return searchResult;
        }

        const rankedNames = (searchResult.data?.matches || []).map(
          (match: any) => match.table_name,
        );
        const fetchedTables = await this.getTablesByName(database, rankedNames);
        const tableByName = new Map(fetchedTables.map((table) => [table.TABLE_NAME, table]));
        tables = rankedNames
          .map((tableName: string) => tableByName.get(tableName))
          .filter(Boolean);
      } else {
        tables = await this.db.query<any[]>(
          `
            SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME
            LIMIT ?
          `,
          [database, maxTables],
        );
      }

      if (!tables.length) {
        return {
          status: "success",
          data: {
            database,
            total_tables: 0,
            tables: [],
            relationships: [],
            context_text: `Schema-Aware RAG Context Pack (${database}): no tables found${
              keywordFilter ? ` for keyword "${keywordFilter}"` : ""
            }.`,
          },
        };
      }

      const tableNames = tables.map((t) => t.TABLE_NAME);
      const placeholders = tableNames.map(() => "?").join(",");
      const columnParams = [database, ...tableNames];
      const columns = await this.db.query<any[]>(
        `
          SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY, IS_NULLABLE, COLUMN_COMMENT
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ?
            AND TABLE_NAME IN (${placeholders})
          ORDER BY TABLE_NAME, ORDINAL_POSITION
        `,
        columnParams,
      );

      let foreignKeys: any[] = [];
      if (includeRelationships) {
        const fkParams = [database, ...tableNames, ...tableNames];
        foreignKeys = await this.db.query<any[]>(
          `
            SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
            FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = ?
              AND TABLE_NAME IN (${placeholders})
              AND REFERENCED_TABLE_NAME IN (${placeholders})
              AND REFERENCED_TABLE_NAME IS NOT NULL
          `,
          fkParams,
        );
      }

      const fkLookup = new Map<string, { table: string; column: string }>();
      foreignKeys.forEach((fk) => {
        fkLookup.set(`${fk.TABLE_NAME}.${fk.COLUMN_NAME}`, {
          table: fk.REFERENCED_TABLE_NAME,
          column: fk.REFERENCED_COLUMN_NAME,
        });
      });

      const tableEntries = tables.map((table) => {
        const tableColumns = columns.filter(
          (c) => c.TABLE_NAME === table.TABLE_NAME,
        );
        const truncatedColumns =
          tableColumns.length > maxColumns ? tableColumns.length - maxColumns : 0;

        const columnsForContext = tableColumns.slice(0, maxColumns).map((col) => {
          const key =
            col.COLUMN_KEY === "PRI"
              ? "PK"
              : col.COLUMN_KEY === "UNI"
                ? "UNI"
                : undefined;
          const fkRef = fkLookup.get(`${col.TABLE_NAME}.${col.COLUMN_NAME}`);

          return {
            name: col.COLUMN_NAME,
            data_type: col.DATA_TYPE,
            nullable: col.IS_NULLABLE === "YES",
            key: fkRef ? "FK" : key,
            references: fkRef
              ? `${fkRef.table}.${fkRef.column}`
              : undefined,
            comment: includeComments && col.COLUMN_COMMENT
              ? col.COLUMN_COMMENT
              : undefined,
          };
        });

        const primaryKeys = tableColumns
          .filter((col) => col.COLUMN_KEY === "PRI")
          .map((col) => col.COLUMN_NAME);

        const foreignKeyList = foreignKeys
          .filter((fk) => fk.TABLE_NAME === table.TABLE_NAME)
          .map((fk) => ({
            column: fk.COLUMN_NAME,
            references: `${fk.REFERENCED_TABLE_NAME}.${fk.REFERENCED_COLUMN_NAME}`,
          }));

        return {
          table_name: table.TABLE_NAME,
          row_estimate: typeof table.TABLE_ROWS === "number"
            ? table.TABLE_ROWS
            : parseInt(table.TABLE_ROWS || "0", 10) || 0,
          table_comment: includeComments && table.TABLE_COMMENT
            ? table.TABLE_COMMENT
            : undefined,
          primary_keys: primaryKeys,
          columns: columnsForContext,
          foreign_keys: foreignKeyList,
          truncated_columns: truncatedColumns > 0 ? truncatedColumns : 0,
        };
      });

      const relationships = foreignKeys.map((fk) => ({
        from_table: fk.TABLE_NAME,
        from_column: fk.COLUMN_NAME,
        to_table: fk.REFERENCED_TABLE_NAME,
        to_column: fk.REFERENCED_COLUMN_NAME,
      }));

      const lines: string[] = [];
      lines.push(`Schema-Aware RAG Context Pack (${database})`);
      if (keywordFilter) {
        lines.push(`Keyword filter: "${keywordFilter}"`);
      }
      lines.push(
        `Tables shown: ${tableEntries.length}/${
          totalTables || tableEntries.length
        } (rows are approximate)`,
      );
      lines.push(
        `Per-table column limit: ${maxColumns}${
          tableEntries.some((t) => t.truncated_columns > 0)
            ? " (additional columns truncated)"
            : ""
        }`,
      );
      lines.push("");

      tableEntries.forEach((t) => {
        const approxRows =
          typeof t.row_estimate === "number" && t.row_estimate >= 0
            ? `~${t.row_estimate}`
            : "~0";

        const columnSnippets = t.columns.map((c) => {
          const tags = [];
          if (c.key) tags.push(c.key);
          if (c.references) tags.push(`-> ${c.references}`);
          const nullability = c.nullable ? "null" : "not null";
          const comment = c.comment
            ? ` — ${this.truncateValue(c.comment, 120)}`
            : "";
          return `${c.name} ${c.data_type} (${nullability})${
            tags.length ? ` [${tags.join(", ")}]` : ""
          }${comment}`;
        });

        lines.push(
          `- ${t.table_name} (${approxRows} rows) PK: ${
            t.primary_keys.length ? t.primary_keys.join(", ") : "none"
          }`,
        );
        if (t.table_comment) {
          lines.push(`  Comment: ${this.truncateValue(t.table_comment, 240)}`);
        }
        lines.push(`  Columns: ${columnSnippets.join("; ")}`);
        if (t.truncated_columns) {
          lines.push(`  ...and ${t.truncated_columns} more columns not shown`);
        }
      });

      if (includeRelationships && relationships.length) {
        lines.push("");
        lines.push("Relationships:");
        relationships.forEach((rel) => {
          lines.push(
            `- ${rel.from_table}.${rel.from_column} -> ${rel.to_table}.${rel.to_column}`,
          );
        });
      }

      if (totalTables > tableEntries.length) {
        lines.push(
          `\nNote: ${totalTables - tableEntries.length} table(s) omitted (max_tables=${maxTables}).`,
        );
      }

      return {
        status: "success",
        data: {
          database,
          total_tables: totalTables,
          tables: tableEntries,
          relationships: includeRelationships ? relationships : [],
          context_text: lines.join("\n"),
          limits: {
            max_tables: maxTables,
            max_columns: maxColumns,
            include_comments: includeComments,
            keyword_filter: keywordFilter,
          },
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
