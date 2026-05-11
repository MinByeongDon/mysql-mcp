import DatabaseConnection from "../db/connection";
import { dbConfig } from "../config/config";
import SecurityLayer from "../security/securityLayer";

type RowsPerTable = number | Record<string, number>;

interface SeedRule {
  generator?: string;
  values?: any[];
  value?: any;
  min?: number;
  max?: number;
  prefix?: string;
  pattern?: string;
  domain?: string;
  nullable?: boolean;
}

interface ColumnMeta {
  tableName: string;
  columnName: string;
  dataType: string;
  columnType: string;
  isNullable: boolean;
  columnDefault: any;
  extra: string;
  columnKey: string;
  ordinalPosition: number;
  characterMaximumLength?: number;
}

interface ForeignKeyMeta {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  constraintName: string;
}

interface UniqueIndexMeta {
  tableName: string;
  indexName: string;
  columns: string[];
}

interface TableSchema {
  tableName: string;
  columns: ColumnMeta[];
  primaryKeys: string[];
  autoIncrementColumn?: string;
}

interface DatabaseSchema {
  database: string;
  tables: Record<string, TableSchema>;
  foreignKeys: ForeignKeyMeta[];
  uniqueIndexes: UniqueIndexMeta[];
  rowCounts: Record<string, number>;
}

interface TableRequirement {
  table: string;
  rows_to_create: number;
  reason: string;
  existing_rows: number;
}

interface SeedPlan {
  plan_id: string;
  database: string;
  dependency_order: string[];
  tables_required: TableRequirement[];
  constraints_detected: {
    foreign_keys: string[];
    unique: string[];
    required_columns: string[];
  };
  seed_rules: Record<string, SeedRule>;
  warnings: string[];
  requires_confirmation: boolean;
  confirm_token: string;
  random_seed: number;
  options: {
    strategy: string;
    respect_existing_data: boolean;
    include_dependencies: boolean;
    include_children: boolean;
    child_rows_per_parent: number;
    max_rows_per_table: number;
  };
}

interface StoredSeedPlan {
  plan: SeedPlan;
  schema: DatabaseSchema;
  lastPreview?: Record<string, Record<string, any>[]>;
  lastExecution?: {
    inserted: Record<string, number>;
    insertedPrimaryKeys: Record<string, any[]>;
    transaction: "committed" | "rolled_back" | "none" | "dry_run";
    executedAt: string;
  };
}

interface PlanSeedDataParams {
  database?: string;
  target_tables: string[];
  rows_per_table?: RowsPerTable;
  include_dependencies?: boolean;
  include_children?: boolean;
  child_rows_per_parent?: number;
  respect_existing_data?: boolean;
  strategy?: "append";
  random_seed?: number;
  max_rows_per_table?: number;
  max_related_tables?: number;
  seed_rules?: Record<string, SeedRule>;
  require_confirmation?: boolean;
}

interface GenerateSeedPreviewParams {
  plan_id: string;
  locale?: string;
  realistic?: boolean;
  max_preview_rows_per_table?: number;
  email_domain?: string;
}

interface ExecuteSeedPlanParams {
  plan_id: string;
  dry_run?: boolean;
  use_transaction?: boolean;
  batch_size?: number;
  on_error?: "rollback" | "stop";
  confirm_token?: string;
  allow_production?: boolean;
  email_domain?: string;
}

interface ValidateSeedIntegrityParams {
  plan_id: string;
  tables?: string[];
  check_foreign_keys?: boolean;
  check_orphans?: boolean;
  check_required_columns?: boolean;
  check_unique_collisions?: boolean;
  check_row_counts?: boolean;
}

interface RowGenerationContext {
  preview: boolean;
  emailDomain: string;
  idMap: Record<string, Record<string, any[]>>;
}

export class RelationalSeederTools {
  private static planCounter = 0;
  private db: DatabaseConnection;
  private security: SecurityLayer;
  private plans: Map<string, StoredSeedPlan>;

  constructor(security: SecurityLayer) {
    this.db = DatabaseConnection.getInstance();
    this.security = security;
    this.plans = new Map();
  }

  async planSeedData(params: PlanSeedDataParams): Promise<{
    status: string;
    data?: SeedPlan;
    error?: string;
  }> {
    try {
      if (!params.target_tables || !Array.isArray(params.target_tables) || params.target_tables.length === 0) {
        return { status: "error", error: "target_tables must contain at least one table" };
      }

      const database = this.resolveDatabase(params.database);
      const schema = await this.loadSchema(database);
      const warnings: string[] = [];
      const maxRelatedTables = this.clampNumber(params.max_related_tables, 1, 100, 25);
      const targetTables = Array.from(new Set(params.target_tables));

      for (const table of targetTables) {
        this.assertIdentifier(table, "table");
        if (!schema.tables[table]) {
          return { status: "error", error: `Table '${table}' does not exist in database '${database}'` };
        }
      }

      const includeDependencies = params.include_dependencies ?? true;
      const includeChildren = params.include_children ?? false;
      const childRowsPerParent = this.clampNumber(params.child_rows_per_parent, 1, 20, 2);
      const maxRowsPerTable = this.clampNumber(params.max_rows_per_table, 1, 10000, 1000);
      const respectExistingData = params.respect_existing_data ?? true;

      const reasons: Record<string, string[]> = {};
      const includedTables = new Set<string>();
      targetTables.forEach((table) => {
        includedTables.add(table);
        reasons[table] = ["target table"];
      });

      let changed = true;
      while (changed) {
        changed = false;
        const currentTables = Array.from(includedTables);

        if (includeDependencies) {
          for (const fk of schema.foreignKeys) {
            if (currentTables.includes(fk.childTable) && !includedTables.has(fk.parentTable)) {
              if (includedTables.size >= maxRelatedTables) {
                warnings.push(`Skipped parent table '${fk.parentTable}' because max_related_tables=${maxRelatedTables} was reached.`);
                continue;
              }
              includedTables.add(fk.parentTable);
              reasons[fk.parentTable] = reasons[fk.parentTable] || [];
              reasons[fk.parentTable].push(`${fk.childTable}.${fk.childColumn} references ${fk.parentTable}.${fk.parentColumn}`);
              changed = true;
            }
          }
        }

        if (includeChildren) {
          for (const fk of schema.foreignKeys) {
            if (currentTables.includes(fk.parentTable) && !includedTables.has(fk.childTable)) {
              if (includedTables.size >= maxRelatedTables) {
                warnings.push(`Skipped child table '${fk.childTable}' because max_related_tables=${maxRelatedTables} was reached.`);
                continue;
              }
              includedTables.add(fk.childTable);
              reasons[fk.childTable] = reasons[fk.childTable] || [];
              reasons[fk.childTable].push(`${fk.childTable}.${fk.childColumn} references ${fk.parentTable}.${fk.parentColumn}`);
              changed = true;
            }
          }
        }
      }

      const dependencyOrder = this.topologicalSort(Array.from(includedTables), schema.foreignKeys, warnings);
      const rowCounts = this.calculateRowsToCreate(
        dependencyOrder,
        targetTables,
        schema,
        reasons,
        params.rows_per_table,
        childRowsPerParent,
        maxRowsPerTable,
        respectExistingData,
      );

      const seedRules = this.inferSeedRules(dependencyOrder, schema, params.seed_rules || {});
      const constraints = this.detectConstraints(dependencyOrder, schema);

      for (const requiredColumn of constraints.required_columns) {
        const rule = seedRules[requiredColumn];
        if (!rule || rule.generator === "string") {
          warnings.push(`Column '${requiredColumn}' is required and uses a generic generator. Review preview before execution.`);
        }
      }

      if (this.isProductionLikeDatabase(database)) {
        warnings.push(`Database '${database}' looks production-like. execute_seed_plan will block writes unless allow_production is true.`);
      }

      const planId = this.createPlanId();
      const plan: SeedPlan = {
        plan_id: planId,
        database,
        dependency_order: dependencyOrder,
        tables_required: rowCounts,
        constraints_detected: constraints,
        seed_rules: seedRules,
        warnings,
        requires_confirmation: params.require_confirmation ?? true,
        confirm_token: this.createConfirmToken(database),
        random_seed: params.random_seed ?? 42,
        options: {
          strategy: params.strategy || "append",
          respect_existing_data: respectExistingData,
          include_dependencies: includeDependencies,
          include_children: includeChildren,
          child_rows_per_parent: childRowsPerParent,
          max_rows_per_table: maxRowsPerTable,
        },
      };

      this.plans.set(planId, { plan, schema });

      return { status: "success", data: plan };
    } catch (error: any) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async generateSeedPreview(params: GenerateSeedPreviewParams): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const stored = this.getStoredPlan(params.plan_id);
      const maxRows = this.clampNumber(params.max_preview_rows_per_table, 1, 25, 3);
      const emailDomain = params.email_domain || "example.test";
      const preview = this.buildPreview(stored, maxRows, emailDomain);
      stored.lastPreview = preview;

      return {
        status: "success",
        data: {
          plan_id: stored.plan.plan_id,
          locale: params.locale || "en_US",
          realistic: params.realistic ?? true,
          preview,
          quality_notes: [
            `Preview is deterministic from random_seed=${stored.plan.random_seed}.`,
            `Email values use '${emailDomain}' unless overridden.`,
            "Foreign keys are symbolic in preview and resolved during execution.",
          ],
          requires_confirmation: stored.plan.requires_confirmation,
          confirm_token: stored.plan.confirm_token,
        },
      };
    } catch (error: any) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async executeSeedPlan(params: ExecuteSeedPlanParams): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    const startedAt = Date.now();
    const dryRun = params.dry_run ?? true;
    const useTransaction = params.use_transaction ?? true;
    const onError = params.on_error || "rollback";

    try {
      const stored = this.getStoredPlan(params.plan_id);
      const plan = stored.plan;
      const emailDomain = params.email_domain || "example.test";

      if (dryRun) {
        const preview = this.buildPreview(stored, 5, emailDomain);
        stored.lastExecution = {
          inserted: {},
          insertedPrimaryKeys: {},
          transaction: "dry_run",
          executedAt: new Date().toISOString(),
        };
        return {
          status: "success",
          data: {
            success: true,
            dry_run: true,
            plan_id: plan.plan_id,
            transaction: "not_started",
            would_insert: this.requirementsToInsertMap(plan.tables_required),
            preview,
            requires_confirmation: plan.requires_confirmation,
            confirm_token: plan.confirm_token,
          },
        };
      }

      if (plan.requires_confirmation && params.confirm_token !== plan.confirm_token) {
        return {
          status: "error",
          error: `execute_seed_plan requires confirm_token='${plan.confirm_token}' for non-dry-run execution.`,
        };
      }

      if (this.isProductionLikeDatabase(plan.database) && !params.allow_production) {
        return {
          status: "error",
          error: `Database '${plan.database}' looks production-like. Set allow_production=true and provide the confirm token to continue.`,
        };
      }

      const transactionId = `seed_${plan.plan_id}`;
      const idMap: Record<string, Record<string, any[]>> = {};
      const inserted: Record<string, number> = {};
      const insertedPrimaryKeys: Record<string, any[]> = {};

      if (useTransaction) {
        await this.db.beginTransaction(transactionId);
      }

      try {
        await this.preloadExistingParentIds(stored, idMap, useTransaction ? transactionId : undefined);

        for (const tableName of plan.dependency_order) {
          const requirement = plan.tables_required.find((item) => item.table === tableName);
          const rowsToCreate = requirement?.rows_to_create || 0;
          inserted[tableName] = 0;
          insertedPrimaryKeys[tableName] = [];

          if (rowsToCreate <= 0) {
            await this.ensureIdMapForTable(stored, tableName, idMap, useTransaction ? transactionId : undefined);
            continue;
          }

          const rows = this.buildRowsForTable(stored, tableName, rowsToCreate, {
            preview: false,
            emailDomain,
            idMap,
          });

          for (const row of rows) {
            const result = await this.insertRow(tableName, row, useTransaction ? transactionId : undefined);
            inserted[tableName] += result.affectedRows;
            this.trackInsertedPrimaryKey(stored.schema.tables[tableName], row, result.insertId, idMap, insertedPrimaryKeys);
          }
        }

        if (useTransaction) {
          await this.db.commitTransaction(transactionId);
        }

        stored.lastExecution = {
          inserted,
          insertedPrimaryKeys,
          transaction: useTransaction ? "committed" : "none",
          executedAt: new Date().toISOString(),
        };

        return {
          status: "success",
          data: {
            success: true,
            dry_run: false,
            transaction: useTransaction ? "committed" : "not_used",
            inserted,
            inserted_primary_keys: insertedPrimaryKeys,
            resolved_foreign_keys: this.countResolvedForeignKeys(stored),
            duration_ms: Date.now() - startedAt,
            batch_size: params.batch_size || 1,
            on_error: onError,
            next_recommended_tool: "validate_seed_integrity",
          },
        };
      } catch (error) {
        if (useTransaction && onError === "rollback") {
          await this.db.rollbackTransaction(transactionId);
          stored.lastExecution = {
            inserted,
            insertedPrimaryKeys,
            transaction: "rolled_back",
            executedAt: new Date().toISOString(),
          };
        }
        throw error;
      }
    } catch (error: any) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async validateSeedIntegrity(params: ValidateSeedIntegrityParams): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const stored = this.getStoredPlan(params.plan_id);
      const plan = stored.plan;
      const tables = params.tables && params.tables.length > 0 ? params.tables : plan.dependency_order;

      for (const table of tables) {
        this.assertIdentifier(table, "table");
        if (!stored.schema.tables[table]) {
          return { status: "error", error: `Unknown table '${table}' in seed validation request.` };
        }
      }

      const checkForeignKeys = params.check_foreign_keys ?? params.check_orphans ?? true;
      const checkRequired = params.check_required_columns ?? true;
      const checkUnique = params.check_unique_collisions ?? true;
      const checkRowCounts = params.check_row_counts ?? true;
      const summary = {
        tables_checked: tables.length,
        foreign_key_checks: 0,
        orphan_foreign_keys: 0,
        unique_violations: 0,
        required_column_violations: 0,
      };
      const rowCounts: Record<string, any> = {};
      const violations: any[] = [];

      if (checkForeignKeys) {
        for (const fk of stored.schema.foreignKeys.filter((item) => tables.includes(item.childTable))) {
          summary.foreign_key_checks++;
          const count = await this.countForeignKeyOrphans(fk);
          summary.orphan_foreign_keys += count;
          if (count > 0) {
            violations.push({
              type: "foreign_key_orphan",
              table: fk.childTable,
              column: fk.childColumn,
              references: `${fk.parentTable}.${fk.parentColumn}`,
              count,
            });
          }
        }
      }

      if (checkRequired) {
        for (const table of tables) {
          for (const column of this.getRequiredColumns(stored.schema.tables[table])) {
            const count = await this.countNullValues(table, column.columnName);
            summary.required_column_violations += count;
            if (count > 0) {
              violations.push({
                type: "required_column_null",
                table,
                column: column.columnName,
                count,
              });
            }
          }
        }
      }

      if (checkUnique) {
        for (const index of stored.schema.uniqueIndexes.filter((item) => tables.includes(item.tableName))) {
          const collisions = await this.findUniqueCollisions(index);
          summary.unique_violations += collisions.length;
          for (const collision of collisions) {
            violations.push({
              type: "unique_collision",
              table: index.tableName,
              index: index.indexName,
              columns: index.columns,
              sample: collision,
            });
          }
        }
      }

      if (checkRowCounts) {
        for (const table of tables) {
          rowCounts[table] = await this.getValidationRowCount(stored, table);
        }
      }

      return {
        status: "success",
        data: {
          valid:
            summary.orphan_foreign_keys === 0 &&
            summary.unique_violations === 0 &&
            summary.required_column_violations === 0,
          summary,
          row_counts: rowCounts,
          violations,
        },
      };
    } catch (error: any) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveDatabase(database?: string): string {
    const connectedDatabase = dbConfig.database;
    if (!connectedDatabase) {
      throw new Error("No database configured. Set DB_NAME or include a database in the MySQL URL.");
    }

    if (database && database !== connectedDatabase) {
      throw new Error(`Access denied. You can only access the connected database '${connectedDatabase}'. Requested '${database}'.`);
    }

    return database || connectedDatabase;
  }

  private async loadSchema(database: string): Promise<DatabaseSchema> {
    const columns = await this.db.query<any[]>(
      `
        SELECT
          TABLE_NAME as tableName,
          COLUMN_NAME as columnName,
          DATA_TYPE as dataType,
          COLUMN_TYPE as columnType,
          IS_NULLABLE as isNullable,
          COLUMN_DEFAULT as columnDefault,
          EXTRA as extra,
          COLUMN_KEY as columnKey,
          ORDINAL_POSITION as ordinalPosition,
          CHARACTER_MAXIMUM_LENGTH as characterMaximumLength
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      [database],
    );

    const foreignKeys = await this.db.query<any[]>(
      `
        SELECT
          TABLE_NAME as childTable,
          COLUMN_NAME as childColumn,
          REFERENCED_TABLE_NAME as parentTable,
          REFERENCED_COLUMN_NAME as parentColumn,
          CONSTRAINT_NAME as constraintName
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY TABLE_NAME, ORDINAL_POSITION
      `,
      [database],
    );

    const uniqueRows = await this.db.query<any[]>(
      `
        SELECT
          TABLE_NAME as tableName,
          INDEX_NAME as indexName,
          COLUMN_NAME as columnName,
          SEQ_IN_INDEX as seqInIndex
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ?
          AND NON_UNIQUE = 0
        ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
      `,
      [database],
    );

    const tableRows = await this.db.query<any[]>(
      `
        SELECT TABLE_NAME as tableName, TABLE_ROWS as tableRows
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ?
      `,
      [database],
    );

    const tables: Record<string, TableSchema> = {};
    for (const rawColumn of columns) {
      const column: ColumnMeta = {
        tableName: rawColumn.tableName,
        columnName: rawColumn.columnName,
        dataType: String(rawColumn.dataType || "").toLowerCase(),
        columnType: String(rawColumn.columnType || "").toLowerCase(),
        isNullable: rawColumn.isNullable === "YES",
        columnDefault: rawColumn.columnDefault,
        extra: String(rawColumn.extra || "").toLowerCase(),
        columnKey: String(rawColumn.columnKey || ""),
        ordinalPosition: Number(rawColumn.ordinalPosition || 0),
        characterMaximumLength: rawColumn.characterMaximumLength ? Number(rawColumn.characterMaximumLength) : undefined,
      };

      tables[column.tableName] = tables[column.tableName] || {
        tableName: column.tableName,
        columns: [],
        primaryKeys: [],
      };
      tables[column.tableName].columns.push(column);

      if (column.columnKey === "PRI") {
        tables[column.tableName].primaryKeys.push(column.columnName);
      }

      if (column.extra.includes("auto_increment")) {
        tables[column.tableName].autoIncrementColumn = column.columnName;
      }
    }

    const uniqueIndexesByKey: Record<string, UniqueIndexMeta> = {};
    for (const row of uniqueRows) {
      const key = `${row.tableName}.${row.indexName}`;
      uniqueIndexesByKey[key] = uniqueIndexesByKey[key] || {
        tableName: row.tableName,
        indexName: row.indexName,
        columns: [],
      };
      uniqueIndexesByKey[key].columns.push(row.columnName);
    }

    const rowCounts: Record<string, number> = {};
    for (const row of tableRows) {
      rowCounts[row.tableName] = Number(row.tableRows || 0);
    }

    return {
      database,
      tables,
      foreignKeys: foreignKeys.map((fk) => ({
        childTable: fk.childTable,
        childColumn: fk.childColumn,
        parentTable: fk.parentTable,
        parentColumn: fk.parentColumn,
        constraintName: fk.constraintName,
      })),
      uniqueIndexes: Object.values(uniqueIndexesByKey),
      rowCounts,
    };
  }

  private topologicalSort(tables: string[], foreignKeys: ForeignKeyMeta[], warnings: string[]): string[] {
    const tableSet = new Set(tables);
    const indegree: Record<string, number> = {};
    const edges: Record<string, string[]> = {};

    for (const table of tables) {
      indegree[table] = 0;
      edges[table] = [];
    }

    for (const fk of foreignKeys) {
      if (!tableSet.has(fk.parentTable) || !tableSet.has(fk.childTable) || fk.parentTable === fk.childTable) {
        continue;
      }
      edges[fk.parentTable].push(fk.childTable);
      indegree[fk.childTable]++;
    }

    const queue = tables.filter((table) => indegree[table] === 0).sort();
    const ordered: string[] = [];

    while (queue.length > 0) {
      const table = queue.shift()!;
      ordered.push(table);

      for (const child of edges[table]) {
        indegree[child]--;
        if (indegree[child] === 0) {
          queue.push(child);
          queue.sort();
        }
      }
    }

    if (ordered.length !== tables.length) {
      const remaining = tables.filter((table) => !ordered.includes(table)).sort();
      warnings.push(`Cycle detected in table relationships: ${remaining.join(", ")}. Remaining tables were appended after dependency ordering.`);
      ordered.push(...remaining);
    }

    return ordered;
  }

  private calculateRowsToCreate(
    orderedTables: string[],
    targetTables: string[],
    schema: DatabaseSchema,
    reasons: Record<string, string[]>,
    rowsPerTable: RowsPerTable | undefined,
    childRowsPerParent: number,
    maxRowsPerTable: number,
    respectExistingData: boolean,
  ): TableRequirement[] {
    const explicitRows = typeof rowsPerTable === "object" && rowsPerTable !== null ? rowsPerTable : {};
    const baseRows = typeof rowsPerTable === "number" ? rowsPerTable : 10;
    const targetSet = new Set(targetTables);
    const requirements: TableRequirement[] = [];

    for (const table of orderedTables) {
      const existingRows = schema.rowCounts[table] || 0;
      let rowsToCreate = this.getExplicitOrDefaultRows(table, explicitRows, baseRows);

      if (!targetSet.has(table)) {
        const isChildOfIncluded = schema.foreignKeys.some((fk) => fk.childTable === table && orderedTables.includes(fk.parentTable));
        const isParentDependency = schema.foreignKeys.some((fk) => fk.parentTable === table && orderedTables.includes(fk.childTable));

        if (isChildOfIncluded && !isParentDependency) {
          const parentFk = schema.foreignKeys.find((fk) => fk.childTable === table && orderedTables.includes(fk.parentTable));
          const parentRows = parentFk
            ? requirements.find((item) => item.table === parentFk.parentTable)?.rows_to_create || baseRows
            : baseRows;
          rowsToCreate = parentRows * childRowsPerParent;
        } else if (respectExistingData && isParentDependency && existingRows > 0) {
          rowsToCreate = 0;
        }
      }

      rowsToCreate = this.clampNumber(rowsToCreate, 0, maxRowsPerTable, baseRows);
      requirements.push({
        table,
        rows_to_create: rowsToCreate,
        reason: (reasons[table] || ["related table"]).join("; "),
        existing_rows: existingRows,
      });
    }

    return requirements;
  }

  private inferSeedRules(
    tables: string[],
    schema: DatabaseSchema,
    customRules: Record<string, SeedRule>,
  ): Record<string, SeedRule> {
    const rules: Record<string, SeedRule> = {};
    const uniqueColumns = new Set<string>();

    for (const index of schema.uniqueIndexes) {
      if (index.columns.length === 1) {
        uniqueColumns.add(`${index.tableName}.${index.columns[0]}`);
      }
    }

    for (const table of tables) {
      for (const column of schema.tables[table].columns) {
        const key = `${table}.${column.columnName}`;
        rules[key] = customRules[key] || customRules[column.columnName] || this.inferRuleForColumn(table, column, uniqueColumns.has(key));
      }
    }

    return rules;
  }

  private inferRuleForColumn(table: string, column: ColumnMeta, unique: boolean): SeedRule {
    const name = column.columnName.toLowerCase();
    const enumValues = this.extractEnumValues(column.columnType);

    if (enumValues.length > 0) {
      return { generator: "choice", values: enumValues };
    }

    if (name.includes("email")) return { generator: "email", domain: "example.test" };
    if (name.includes("username")) return { generator: "username", prefix: table };
    if (name === "name" || name.endsWith("_name") || name.includes("fullname")) return { generator: "person_name" };
    if (name.includes("phone") || name.includes("mobile") || name.includes("telp")) return { generator: "phone" };
    if (name.includes("slug")) return { generator: "slug", prefix: table };
    if (name.includes("sku")) return { generator: "pattern", pattern: `${table.toUpperCase().slice(0, 3)}-####` };
    if (name.includes("code") || unique) return { generator: "pattern", pattern: `${column.columnName.toUpperCase().slice(0, 4)}-####` };
    if (name.includes("status")) return { generator: "choice", values: ["active", "inactive", "pending"] };
    if (name.includes("role")) return { generator: "choice", values: ["member", "staff", "manager"] };
    if (name.includes("type") || name.includes("category")) return { generator: "choice", values: ["standard", "premium", "basic"] };
    if (name.includes("price") || name.includes("amount") || name.includes("total") || name.includes("balance")) {
      return { generator: "number", min: 10000, max: 500000 };
    }
    if (name.includes("qty") || name.includes("quantity") || name.includes("count") || name.includes("stock")) {
      return { generator: "integer", min: 1, max: 20 };
    }
    if (name.includes("uuid")) return { generator: "uuid" };
    if (name.includes("password")) return { generator: "string", prefix: "DummyPassword" };

    if (this.isBooleanColumn(column)) return { generator: "boolean" };
    if (this.isIntegerColumn(column)) return { generator: "integer", min: 1, max: 1000 };
    if (this.isNumberColumn(column)) return { generator: "number", min: 1, max: 1000 };
    if (column.dataType === "date") return { generator: "date" };
    if (["datetime", "timestamp"].includes(column.dataType)) return { generator: "datetime" };
    if (column.dataType === "time") return { generator: "time" };
    if (column.dataType === "year") return { generator: "year" };
    if (column.dataType === "json") return { generator: "json" };
    if (column.dataType.includes("text")) return { generator: "text", prefix: column.columnName };

    return { generator: "string", prefix: column.columnName };
  }

  private detectConstraints(tables: string[], schema: DatabaseSchema): SeedPlan["constraints_detected"] {
    const tableSet = new Set(tables);
    return {
      foreign_keys: schema.foreignKeys
        .filter((fk) => tableSet.has(fk.childTable))
        .map((fk) => `${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}`),
      unique: schema.uniqueIndexes
        .filter((index) => tableSet.has(index.tableName))
        .map((index) => `${index.tableName}.${index.indexName}(${index.columns.join(",")})`),
      required_columns: tables.flatMap((table) =>
        this.getRequiredColumns(schema.tables[table]).map((column) => `${table}.${column.columnName}`),
      ),
    };
  }

  private buildPreview(stored: StoredSeedPlan, maxRows: number, emailDomain: string): Record<string, Record<string, any>[]> {
    const preview: Record<string, Record<string, any>[]> = {};
    const idMap: Record<string, Record<string, any[]>> = {};

    for (const table of stored.plan.dependency_order) {
      const requirement = stored.plan.tables_required.find((item) => item.table === table);
      const count = Math.min(requirement?.rows_to_create || 0, maxRows);
      preview[table] = this.buildRowsForTable(stored, table, count, {
        preview: true,
        emailDomain,
        idMap,
      });
    }

    return preview;
  }

  private buildRowsForTable(
    stored: StoredSeedPlan,
    tableName: string,
    count: number,
    context: RowGenerationContext,
  ): Record<string, any>[] {
    const table = stored.schema.tables[tableName];
    const rows: Record<string, any>[] = [];

    for (let rowIndex = 0; rowIndex < count; rowIndex++) {
      const row: Record<string, any> = {};

      for (const column of table.columns) {
        if (this.shouldSkipColumn(column)) {
          continue;
        }

        const fk = stored.schema.foreignKeys.find(
          (item) => item.childTable === tableName && item.childColumn === column.columnName,
        );

        if (fk) {
          row[column.columnName] = this.resolveForeignKeyValue(stored, fk, rowIndex, context);
          continue;
        }

        const rule = stored.plan.seed_rules[`${tableName}.${column.columnName}`] || {};
        const value = this.generateValue(stored.plan, tableName, column, rowIndex, rule, context.emailDomain);
        if (value !== undefined) {
          row[column.columnName] = value;
        }
      }

      rows.push(row);
    }

    return rows;
  }

  private resolveForeignKeyValue(
    stored: StoredSeedPlan,
    fk: ForeignKeyMeta,
    rowIndex: number,
    context: RowGenerationContext,
  ): any {
    const parentRequirement = stored.plan.tables_required.find((item) => item.table === fk.parentTable);
    const parentRows = parentRequirement?.rows_to_create || 0;

    if (context.preview) {
      if (parentRows > 0 && stored.plan.dependency_order.includes(fk.parentTable)) {
        return `{{${fk.parentTable}[${rowIndex % parentRows}].${fk.parentColumn}}}`;
      }
      return `{{existing ${fk.parentTable}.${fk.parentColumn}}}`;
    }

    const values = context.idMap[fk.parentTable]?.[fk.parentColumn] || [];
    if (values.length === 0) {
      throw new Error(`No parent IDs available for ${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}`);
    }

    return values[rowIndex % values.length];
  }

  private generateValue(
    plan: SeedPlan,
    tableName: string,
    column: ColumnMeta,
    rowIndex: number,
    rule: SeedRule,
    emailDomain: string,
  ): any {
    if (rule.value !== undefined) return rule.value;
    if (rule.nullable && column.isNullable) return null;

    const generator = rule.generator || "string";
    const rng = this.makeRng(plan.random_seed + this.hashString(`${tableName}.${column.columnName}`) + rowIndex);
    const suffix = rowIndex + 1 + plan.random_seed;
    const min = rule.min ?? 1;
    const max = rule.max ?? 1000;

    if (rule.values && rule.values.length > 0) {
      return rule.values[Math.floor(rng() * rule.values.length)];
    }

    switch (generator) {
      case "email":
        return this.truncate(`${tableName}.${column.columnName}.${suffix}@${rule.domain || emailDomain}`.toLowerCase(), column);
      case "username":
        return this.truncate(`${rule.prefix || tableName}_user_${suffix}`, column);
      case "person_name":
        return this.truncate(this.pickPersonName(suffix), column);
      case "phone":
        return this.truncate(`+62812${String(10000000 + suffix).slice(-8)}`, column);
      case "slug":
        return this.truncate(`${rule.prefix || tableName}-${suffix}`, column);
      case "pattern":
        return this.truncate((rule.pattern || "SEED-####").replace(/#+/g, (match) => String(suffix).padStart(match.length, "0")), column);
      case "choice":
        return this.truncate(String((rule.values || ["seeded"])[Math.floor(rng() * (rule.values?.length || 1))]), column);
      case "uuid":
        return this.truncate(`00000000-0000-4000-8000-${String(100000000000 + suffix).slice(-12)}`, column);
      case "boolean":
        return rowIndex % 2 === 0;
      case "integer":
        return Math.floor(min + rng() * (max - min + 1));
      case "number":
        return Number((min + rng() * (max - min)).toFixed(2));
      case "date":
        return this.formatDate(new Date(Date.UTC(2026, rowIndex % 12, (rowIndex % 27) + 1)));
      case "datetime":
        return `${this.formatDate(new Date(Date.UTC(2026, rowIndex % 12, (rowIndex % 27) + 1)))} 10:00:00`;
      case "time":
        return `${String((rowIndex % 12) + 8).padStart(2, "0")}:00:00`;
      case "year":
        return 2026;
      case "json":
        return JSON.stringify({ seeded: true, index: rowIndex + 1 });
      case "text":
        return this.truncate(`${rule.prefix || column.columnName} seeded text ${suffix}`, column);
      case "string":
      default:
        return this.truncate(`${rule.prefix || column.columnName}_${suffix}`, column);
    }
  }

  private async preloadExistingParentIds(
    stored: StoredSeedPlan,
    idMap: Record<string, Record<string, any[]>>,
    transactionId?: string,
  ): Promise<void> {
    for (const fk of stored.schema.foreignKeys) {
      const childIncluded = stored.plan.dependency_order.includes(fk.childTable);
      if (!childIncluded) continue;
      const parentRequirement = stored.plan.tables_required.find((item) => item.table === fk.parentTable);
      if (parentRequirement && parentRequirement.rows_to_create > 0) continue;
      const ids = await this.loadExistingIds(fk.parentTable, fk.parentColumn, 1000, transactionId);
      idMap[fk.parentTable] = idMap[fk.parentTable] || {};
      idMap[fk.parentTable][fk.parentColumn] = ids;
    }
  }

  private async ensureIdMapForTable(
    stored: StoredSeedPlan,
    tableName: string,
    idMap: Record<string, Record<string, any[]>>,
    transactionId?: string,
  ): Promise<void> {
    const table = stored.schema.tables[tableName];
    for (const primaryKey of table.primaryKeys) {
      if (idMap[tableName]?.[primaryKey]?.length) continue;
      const ids = await this.loadExistingIds(tableName, primaryKey, 1000, transactionId);
      idMap[tableName] = idMap[tableName] || {};
      idMap[tableName][primaryKey] = ids;
    }
  }

  private async loadExistingIds(tableName: string, columnName: string, limit: number, transactionId?: string): Promise<any[]> {
    const query = `SELECT ${this.security.escapeIdentifier(columnName)} as id FROM ${this.security.escapeIdentifier(tableName)} WHERE ${this.security.escapeIdentifier(columnName)} IS NOT NULL LIMIT ${limit}`;
    const rows = transactionId
      ? await this.db.executeInTransaction<any[]>(transactionId, query)
      : await this.db.query<any[]>(query);
    return rows.map((row) => row.id);
  }

  private async insertRow(
    tableName: string,
    row: Record<string, any>,
    transactionId?: string,
  ): Promise<{ insertId: any; affectedRows: number }> {
    const columns = Object.keys(row);
    let query: string;
    let values: any[] = [];

    if (columns.length === 0) {
      query = `INSERT INTO ${this.security.escapeIdentifier(tableName)} () VALUES ()`;
    } else {
      values = columns.map((column) => row[column]);
      const paramValidation = this.security.validateParameters(values);
      if (!paramValidation.valid) {
        throw new Error(`Invalid seed row value for '${tableName}': ${paramValidation.error}`);
      }
      values = paramValidation.sanitizedParams || [];
      query = `INSERT INTO ${this.security.escapeIdentifier(tableName)} (${columns.map((column) => this.security.escapeIdentifier(column)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    }

    const result = transactionId
      ? await this.db.executeInTransaction<any>(transactionId, query, values)
      : await this.db.query<any>(query, values);

    return {
      insertId: result.insertId,
      affectedRows: result.affectedRows || 0,
    };
  }

  private trackInsertedPrimaryKey(
    table: TableSchema,
    row: Record<string, any>,
    insertId: any,
    idMap: Record<string, Record<string, any[]>>,
    insertedPrimaryKeys: Record<string, any[]>,
  ): void {
    const primaryKey = table.primaryKeys[0] || table.autoIncrementColumn;
    if (!primaryKey) return;

    const value = table.autoIncrementColumn === primaryKey && insertId !== undefined && insertId !== 0
      ? insertId
      : row[primaryKey];

    if (value === undefined || value === null) return;

    idMap[table.tableName] = idMap[table.tableName] || {};
    idMap[table.tableName][primaryKey] = idMap[table.tableName][primaryKey] || [];
    idMap[table.tableName][primaryKey].push(value);
    insertedPrimaryKeys[table.tableName] = insertedPrimaryKeys[table.tableName] || [];
    insertedPrimaryKeys[table.tableName].push(value);
  }

  private async countForeignKeyOrphans(fk: ForeignKeyMeta): Promise<number> {
    const query = `
      SELECT COUNT(*) as count
      FROM ${this.security.escapeIdentifier(fk.childTable)} child_table
      LEFT JOIN ${this.security.escapeIdentifier(fk.parentTable)} parent_table
        ON child_table.${this.security.escapeIdentifier(fk.childColumn)} = parent_table.${this.security.escapeIdentifier(fk.parentColumn)}
      WHERE child_table.${this.security.escapeIdentifier(fk.childColumn)} IS NOT NULL
        AND parent_table.${this.security.escapeIdentifier(fk.parentColumn)} IS NULL
    `;
    const rows = await this.db.query<any[]>(query);
    return Number(rows[0]?.count || 0);
  }

  private async countNullValues(tableName: string, columnName: string): Promise<number> {
    const query = `SELECT COUNT(*) as count FROM ${this.security.escapeIdentifier(tableName)} WHERE ${this.security.escapeIdentifier(columnName)} IS NULL`;
    const rows = await this.db.query<any[]>(query);
    return Number(rows[0]?.count || 0);
  }

  private async findUniqueCollisions(index: UniqueIndexMeta): Promise<any[]> {
    const escapedColumns = index.columns.map((column) => this.security.escapeIdentifier(column));
    const nullChecks = escapedColumns.map((column) => `${column} IS NOT NULL`).join(" AND ");
    const query = `
      SELECT ${escapedColumns.join(", ")}, COUNT(*) as duplicate_count
      FROM ${this.security.escapeIdentifier(index.tableName)}
      ${nullChecks ? `WHERE ${nullChecks}` : ""}
      GROUP BY ${escapedColumns.join(", ")}
      HAVING COUNT(*) > 1
      LIMIT 5
    `;
    return await this.db.query<any[]>(query);
  }

  private async getValidationRowCount(stored: StoredSeedPlan, tableName: string): Promise<any> {
    const requirement = stored.plan.tables_required.find((item) => item.table === tableName);
    const table = stored.schema.tables[tableName];
    const primaryKey = table.primaryKeys[0] || table.autoIncrementColumn;
    const insertedKeys = stored.lastExecution?.insertedPrimaryKeys[tableName] || [];

    if (primaryKey && insertedKeys.length > 0) {
      const placeholders = insertedKeys.map(() => "?").join(", ");
      const query = `SELECT COUNT(*) as count FROM ${this.security.escapeIdentifier(tableName)} WHERE ${this.security.escapeIdentifier(primaryKey)} IN (${placeholders})`;
      const rows = await this.db.query<any[]>(query, insertedKeys);
      return {
        expected_inserted: stored.lastExecution?.inserted[tableName] ?? requirement?.rows_to_create ?? 0,
        actual_inserted: Number(rows[0]?.count || 0),
        primary_key: primaryKey,
      };
    }

    const rows = await this.db.query<any[]>(`SELECT COUNT(*) as count FROM ${this.security.escapeIdentifier(tableName)}`);
    return {
      expected_inserted: requirement?.rows_to_create ?? 0,
      actual_table_rows: Number(rows[0]?.count || 0),
    };
  }

  private getRequiredColumns(table: TableSchema): ColumnMeta[] {
    return table.columns.filter(
      (column) =>
        !column.isNullable &&
        column.columnDefault === null &&
        !column.extra.includes("auto_increment") &&
        !column.extra.includes("generated"),
    );
  }

  private shouldSkipColumn(column: ColumnMeta): boolean {
    return column.extra.includes("auto_increment") || column.extra.includes("generated");
  }

  private isIntegerColumn(column: ColumnMeta): boolean {
    return ["tinyint", "smallint", "mediumint", "int", "integer", "bigint"].includes(column.dataType);
  }

  private isNumberColumn(column: ColumnMeta): boolean {
    return this.isIntegerColumn(column) || ["decimal", "numeric", "float", "double", "real"].includes(column.dataType);
  }

  private isBooleanColumn(column: ColumnMeta): boolean {
    return column.dataType === "tinyint" && /\(1\)/.test(column.columnType);
  }

  private extractEnumValues(columnType: string): string[] {
    if (!columnType.startsWith("enum(")) return [];
    const values: string[] = [];
    const regex = /'((?:''|[^'])*)'/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(columnType)) !== null) {
      values.push(match[1].replace(/''/g, "'"));
    }
    return values;
  }

  private requirementsToInsertMap(requirements: TableRequirement[]): Record<string, number> {
    return requirements.reduce<Record<string, number>>((acc, requirement) => {
      acc[requirement.table] = requirement.rows_to_create;
      return acc;
    }, {});
  }

  private countResolvedForeignKeys(stored: StoredSeedPlan): number {
    return stored.schema.foreignKeys
      .filter((fk) => stored.plan.dependency_order.includes(fk.childTable))
      .reduce((sum, fk) => {
        const requirement = stored.plan.tables_required.find((item) => item.table === fk.childTable);
        return sum + (requirement?.rows_to_create || 0);
      }, 0);
  }

  private getExplicitOrDefaultRows(table: string, explicitRows: Record<string, number>, defaultRows: number): number {
    return explicitRows[table] ?? defaultRows;
  }

  private assertIdentifier(identifier: string, label: string): void {
    const validation = this.security.validateIdentifier(identifier);
    if (!validation.valid) {
      throw new Error(`Invalid ${label} '${identifier}': ${validation.error}`);
    }
  }

  private getStoredPlan(planId: string): StoredSeedPlan {
    const stored = this.plans.get(planId);
    if (!stored) {
      throw new Error(`Seed plan '${planId}' was not found. Run plan_seed_data first in the current MCP session.`);
    }
    return stored;
  }

  private createPlanId(): string {
    RelationalSeederTools.planCounter++;
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return `seed_plan_${timestamp}_${String(RelationalSeederTools.planCounter).padStart(3, "0")}`;
  }

  private createConfirmToken(database: string): string {
    return `CONFIRM_SEED_${database.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  }

  private isProductionLikeDatabase(database: string): boolean {
    return /(^|[_-])(prod|production|live|main|primary)([_-]|$)/i.test(database);
  }

  private clampNumber(value: any, min: number, max: number, defaultValue: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultValue;
    return Math.min(Math.max(Math.floor(numeric), min), max);
  }

  private makeRng(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value += 0x6D2B79F5;
      let result = value;
      result = Math.imul(result ^ (result >>> 15), result | 1);
      result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
      return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
    };
  }

  private hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = Math.imul(31, hash) + value.charCodeAt(i) | 0;
    }
    return Math.abs(hash);
  }

  private truncate(value: string, column: ColumnMeta): string {
    const maxLength = column.characterMaximumLength;
    if (!maxLength || value.length <= maxLength) return value;
    return value.slice(0, maxLength);
  }

  private pickPersonName(seed: number): string {
    const names = [
      "Budi Santoso",
      "Siti Aminah",
      "Andi Pratama",
      "Maya Lestari",
      "Dewi Anggraini",
      "Rizky Saputra",
    ];
    return names[seed % names.length];
  }

  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
