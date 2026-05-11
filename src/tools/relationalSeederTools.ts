import DatabaseConnection from "../db/connection";
import { dbConfig } from "../config/config";
import SecurityLayer from "../security/securityLayer";

type RowsPerTable = number | Record<string, number>;
type SeedDomain = "auto" | "generic" | "ecommerce" | "pos" | "crm";
type SeedTemplate = "ecommerce" | "pos" | "crm";
type TemplateScale = "small" | "medium" | "large";
type KeyTuple = Record<string, any>;
type KeyTupleMap = Record<string, Record<string, KeyTuple[]>>;

interface SeedRule {
  generator?: string;
  values?: any[];
  value?: any;
  min?: number;
  max?: number;
  start?: string;
  end?: string;
  prefix?: string;
  pattern?: string;
  domain?: string;
  nullable?: boolean;
  source?: string;
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
  childColumns: string[];
  parentTable: string;
  parentColumn: string;
  parentColumns: string[];
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
  tupleMap: KeyTupleMap;
}

interface InferSeedRulesParams {
  database?: string;
  tables?: string[];
  domain?: SeedDomain;
  sample_size?: number;
  max_tables?: number;
}

interface SeedFromTemplateParams {
  database?: string;
  template: SeedTemplate;
  scale?: TemplateScale;
  include?: string[];
  exclude?: string[];
  rows_per_table?: RowsPerTable;
  include_dependencies?: boolean;
  include_children?: boolean;
  respect_existing_data?: boolean;
  random_seed?: number;
  require_confirmation?: boolean;
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
              reasons[fk.parentTable].push(this.formatForeignKey(fk));
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
              reasons[fk.childTable].push(this.formatForeignKey(fk));
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

      const seedRules = this.buildInferredSeedRules(dependencyOrder, schema, params.seed_rules || {});
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
      const tupleMap: KeyTupleMap = {};
      const inserted: Record<string, number> = {};
      const insertedPrimaryKeys: Record<string, any[]> = {};

      if (useTransaction) {
        await this.db.beginTransaction(transactionId);
      }

      try {
        await this.preloadExistingParentIds(stored, idMap, tupleMap, useTransaction ? transactionId : undefined);

        for (const tableName of plan.dependency_order) {
          const requirement = plan.tables_required.find((item) => item.table === tableName);
          const rowsToCreate = requirement?.rows_to_create || 0;
          inserted[tableName] = 0;
          insertedPrimaryKeys[tableName] = [];

          if (rowsToCreate <= 0) {
            await this.ensureIdMapForTable(stored, tableName, idMap, tupleMap, useTransaction ? transactionId : undefined);
            continue;
          }

          const rows = this.buildRowsForTable(stored, tableName, rowsToCreate, {
            preview: false,
            emailDomain,
            idMap,
            tupleMap,
          });

          for (const row of rows) {
            const result = await this.insertRow(tableName, row, useTransaction ? transactionId : undefined);
            inserted[tableName] += result.affectedRows;
            this.trackInsertedKeys(stored, stored.schema.tables[tableName], row, result.insertId, idMap, tupleMap, insertedPrimaryKeys);
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
              columns: fk.childColumns,
              references: `${fk.parentTable}(${fk.parentColumns.join(",")})`,
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

  async inferSeedRules(params: InferSeedRulesParams): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const database = this.resolveDatabase(params.database);
      const schema = await this.loadSchema(database);
      const tables = this.getSelectableTables(schema, params.tables, params.max_tables);
      const domain = params.domain || "auto";
      const sampleSize = this.clampNumber(params.sample_size, 0, 100, 25);
      const resolvedDomain = domain === "auto" ? this.detectDomainFromTables(tables) : domain;
      const rules = this.buildInferredSeedRules(tables, schema, {}, resolvedDomain);
      const sampleSummary: Record<string, any> = {};
      const warnings: string[] = [];

      if (sampleSize > 0) {
        for (const table of tables) {
          const samples = await this.loadSampleRows(table, sampleSize);
          sampleSummary[table] = {
            rows_analyzed: samples.length,
            columns_analyzed: schema.tables[table].columns.length,
          };
          this.refineRulesFromSamples(table, schema.tables[table], samples, rules, warnings);
        }
      }

      return {
        status: "success",
        data: {
          database,
          domain: resolvedDomain,
          tables,
          sample_size: sampleSize,
          sample_summary: sampleSummary,
          rules,
          warnings,
          privacy_note: "Sample values are used only to infer safe patterns, ranges, and enum-like choices; raw PII samples are not returned.",
        },
      };
    } catch (error: any) {
      return { status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async seedFromTemplate(params: SeedFromTemplateParams): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const database = this.resolveDatabase(params.database);
      const schema = await this.loadSchema(database);
      const scale = params.scale || "small";
      const detected = this.detectTemplateTables(schema, params.template, params.include, params.exclude);

      if (detected.targetTables.length === 0) {
        return {
          status: "error",
          error: `No tables matched template '${params.template}'. Provide include with concrete table names.`,
        };
      }

      const templateRows = this.getScaleRows(params.template, scale, detected.targetTables);
      const rowsPerTable = typeof params.rows_per_table === "object" || typeof params.rows_per_table === "number"
        ? params.rows_per_table
        : templateRows;
      const seedRules = this.buildTemplateRules(params.template, detected.targetTables, schema);

      const planResult = await this.planSeedData({
        database,
        target_tables: detected.targetTables,
        rows_per_table: rowsPerTable,
        include_dependencies: params.include_dependencies ?? true,
        include_children: params.include_children ?? false,
        respect_existing_data: params.respect_existing_data ?? true,
        random_seed: params.random_seed,
        seed_rules: seedRules,
        require_confirmation: params.require_confirmation,
      });

      if (planResult.status === "error") {
        return planResult;
      }

      return {
        status: "success",
        data: {
          template: params.template,
          scale,
          database,
          detected_tables: detected.detectedTables,
          target_tables: detected.targetTables,
          ignored_tables: detected.ignoredTables,
          warnings: detected.warnings,
          plan: planResult.data,
          next_recommended_tool: "generate_seed_preview",
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

    const groupedForeignKeys = this.groupForeignKeys(foreignKeys);

    return {
      database,
      tables,
      foreignKeys: groupedForeignKeys,
      uniqueIndexes: Object.values(uniqueIndexesByKey),
      rowCounts,
    };
  }

  private groupForeignKeys(rows: any[]): ForeignKeyMeta[] {
    const grouped: Record<string, ForeignKeyMeta> = {};

    for (const row of rows) {
      const key = `${row.childTable}.${row.constraintName}`;
      if (!grouped[key]) {
        grouped[key] = {
          childTable: row.childTable,
          childColumn: row.childColumn,
          childColumns: [],
          parentTable: row.parentTable,
          parentColumn: row.parentColumn,
          parentColumns: [],
          constraintName: row.constraintName,
        };
      }

      grouped[key].childColumns.push(row.childColumn);
      grouped[key].parentColumns.push(row.parentColumn);
    }

    return Object.values(grouped);
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

  private buildInferredSeedRules(
    tables: string[],
    schema: DatabaseSchema,
    customRules: Record<string, SeedRule>,
    domain: SeedDomain = "generic",
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
        rules[key] =
          customRules[key] ||
          customRules[column.columnName] ||
          this.getDomainRule(domain, table, column) ||
          this.inferRuleForColumn(table, column, uniqueColumns.has(key));
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
        .map((fk) => this.formatForeignKey(fk)),
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
    const tupleMap: KeyTupleMap = {};

    for (const table of stored.plan.dependency_order) {
      const requirement = stored.plan.tables_required.find((item) => item.table === table);
      const count = Math.min(requirement?.rows_to_create || 0, maxRows);
      preview[table] = this.buildRowsForTable(stored, table, count, {
        preview: true,
        emailDomain,
        idMap,
        tupleMap,
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
      const childForeignKeys = stored.schema.foreignKeys.filter((item) => item.childTable === tableName);

      for (const fk of childForeignKeys) {
        Object.assign(row, this.resolveForeignKeyTuple(stored, fk, rowIndex, context));
      }

      for (const column of table.columns) {
        if (this.shouldSkipColumn(column)) {
          continue;
        }

        if (row[column.columnName] !== undefined || this.isForeignKeyColumn(childForeignKeys, column.columnName)) {
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

  private resolveForeignKeyTuple(
    stored: StoredSeedPlan,
    fk: ForeignKeyMeta,
    rowIndex: number,
    context: RowGenerationContext,
  ): Record<string, any> {
    const parentRequirement = stored.plan.tables_required.find((item) => item.table === fk.parentTable);
    const parentRows = parentRequirement?.rows_to_create || 0;
    const resolved: Record<string, any> = {};

    if (context.preview) {
      for (let i = 0; i < fk.childColumns.length; i++) {
        const parentColumn = fk.parentColumns[i];
        const childColumn = fk.childColumns[i];
        if (parentRows > 0 && stored.plan.dependency_order.includes(fk.parentTable)) {
          resolved[childColumn] = `{{${fk.parentTable}[${rowIndex % parentRows}].${parentColumn}}}`;
        } else {
          resolved[childColumn] = `{{existing ${fk.parentTable}.${parentColumn}}}`;
        }
      }
      return resolved;
    }

    const signature = this.keySignature(fk.parentColumns);
    const tuples = context.tupleMap[fk.parentTable]?.[signature] || [];
    if (tuples.length === 0) {
      throw new Error(`No parent key tuples available for ${this.formatForeignKey(fk)}`);
    }

    const tuple = tuples[rowIndex % tuples.length];
    for (let i = 0; i < fk.childColumns.length; i++) {
      resolved[fk.childColumns[i]] = tuple[fk.parentColumns[i]];
    }

    return resolved;
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
    tupleMap: KeyTupleMap,
    transactionId?: string,
  ): Promise<void> {
    for (const fk of stored.schema.foreignKeys) {
      const childIncluded = stored.plan.dependency_order.includes(fk.childTable);
      if (!childIncluded) continue;
      const parentRequirement = stored.plan.tables_required.find((item) => item.table === fk.parentTable);
      if (parentRequirement && parentRequirement.rows_to_create > 0) continue;
      const tuples = await this.loadExistingKeyTuples(fk.parentTable, fk.parentColumns, 1000, transactionId);
      this.storeTuples(fk.parentTable, fk.parentColumns, tuples, idMap, tupleMap);
    }
  }

  private async ensureIdMapForTable(
    stored: StoredSeedPlan,
    tableName: string,
    idMap: Record<string, Record<string, any[]>>,
    tupleMap: KeyTupleMap,
    transactionId?: string,
  ): Promise<void> {
    const table = stored.schema.tables[tableName];
    const primaryColumns = table.primaryKeys.length > 0
      ? table.primaryKeys
      : table.autoIncrementColumn
        ? [table.autoIncrementColumn]
        : [];

    if (primaryColumns.length > 0) {
      const signature = this.keySignature(primaryColumns);
      if (!tupleMap[tableName]?.[signature]?.length) {
        const tuples = await this.loadExistingKeyTuples(tableName, primaryColumns, 1000, transactionId);
        this.storeTuples(tableName, primaryColumns, tuples, idMap, tupleMap);
      }
    }

    const referencedKeys = stored.schema.foreignKeys
      .filter((fk) => fk.parentTable === tableName)
      .map((fk) => fk.parentColumns);

    for (const columns of referencedKeys) {
      const signature = this.keySignature(columns);
      if (tupleMap[tableName]?.[signature]?.length) continue;
      const tuples = await this.loadExistingKeyTuples(tableName, columns, 1000, transactionId);
      this.storeTuples(tableName, columns, tuples, idMap, tupleMap);
    }
  }

  private async loadExistingKeyTuples(tableName: string, columns: string[], limit: number, transactionId?: string): Promise<KeyTuple[]> {
    const selectColumns = columns.map((column) => this.security.escapeIdentifier(column)).join(", ");
    const notNullChecks = columns.map((column) => `${this.security.escapeIdentifier(column)} IS NOT NULL`).join(" AND ");
    const query = `SELECT ${selectColumns} FROM ${this.security.escapeIdentifier(tableName)} WHERE ${notNullChecks} LIMIT ${limit}`;
    const rows = transactionId
      ? await this.db.executeInTransaction<any[]>(transactionId, query)
      : await this.db.query<any[]>(query);
    return rows.map((row) => {
      const tuple: KeyTuple = {};
      for (const column of columns) {
        tuple[column] = row[column];
      }
      return tuple;
    });
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

  private trackInsertedKeys(
    stored: StoredSeedPlan,
    table: TableSchema,
    row: Record<string, any>,
    insertId: any,
    idMap: Record<string, Record<string, any[]>>,
    tupleMap: KeyTupleMap,
    insertedPrimaryKeys: Record<string, any[]>,
  ): void {
    const resolvedRow = { ...row };
    if (table.autoIncrementColumn && insertId !== undefined && insertId !== 0) {
      resolvedRow[table.autoIncrementColumn] = insertId;
    }

    const primaryColumns = table.primaryKeys.length > 0
      ? table.primaryKeys
      : table.autoIncrementColumn
        ? [table.autoIncrementColumn]
        : [];

    if (primaryColumns.length > 0) {
      const primaryTuple = this.tupleFromRow(resolvedRow, primaryColumns);
      if (primaryTuple) {
        this.storeTuples(table.tableName, primaryColumns, [primaryTuple], idMap, tupleMap);
        insertedPrimaryKeys[table.tableName] = insertedPrimaryKeys[table.tableName] || [];
        insertedPrimaryKeys[table.tableName].push(primaryColumns.length === 1 ? primaryTuple[primaryColumns[0]] : primaryTuple);
      }
    }

    const referencedKeySignatures = new Set<string>();
    for (const fk of stored.schema.foreignKeys.filter((item) => item.parentTable === table.tableName)) {
      const signature = this.keySignature(fk.parentColumns);
      if (referencedKeySignatures.has(signature)) continue;
      referencedKeySignatures.add(signature);
      const tuple = this.tupleFromRow(resolvedRow, fk.parentColumns);
      if (tuple) {
        this.storeTuples(table.tableName, fk.parentColumns, [tuple], idMap, tupleMap);
      }
    }
  }

  private async countForeignKeyOrphans(fk: ForeignKeyMeta): Promise<number> {
    const joinConditions = fk.childColumns
      .map((childColumn, index) => `child_table.${this.security.escapeIdentifier(childColumn)} = parent_table.${this.security.escapeIdentifier(fk.parentColumns[index])}`)
      .join(" AND ");
    const childNotNullChecks = fk.childColumns
      .map((childColumn) => `child_table.${this.security.escapeIdentifier(childColumn)} IS NOT NULL`)
      .join(" AND ");
    const parentNullCheck = `parent_table.${this.security.escapeIdentifier(fk.parentColumns[0])} IS NULL`;
    const query = `
      SELECT COUNT(*) as count
      FROM ${this.security.escapeIdentifier(fk.childTable)} child_table
      LEFT JOIN ${this.security.escapeIdentifier(fk.parentTable)} parent_table
        ON ${joinConditions}
      WHERE ${childNotNullChecks}
        AND ${parentNullCheck}
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
    const keyColumns = table.primaryKeys.length > 0
      ? table.primaryKeys
      : table.autoIncrementColumn
        ? [table.autoIncrementColumn]
        : [];
    const insertedKeys = stored.lastExecution?.insertedPrimaryKeys[tableName] || [];

    if (keyColumns.length > 0 && insertedKeys.length > 0) {
      const { whereClause, params } = this.buildTupleWhereClause(keyColumns, insertedKeys);
      const query = `SELECT COUNT(*) as count FROM ${this.security.escapeIdentifier(tableName)} WHERE ${whereClause}`;
      const rows = await this.db.query<any[]>(query, params);
      return {
        expected_inserted: stored.lastExecution?.inserted[tableName] ?? requirement?.rows_to_create ?? 0,
        actual_inserted: Number(rows[0]?.count || 0),
        key_columns: keyColumns,
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

  private isForeignKeyColumn(foreignKeys: ForeignKeyMeta[], columnName: string): boolean {
    return foreignKeys.some((fk) => fk.childColumns.includes(columnName));
  }

  private keySignature(columns: string[]): string {
    return columns.join("|");
  }

  private formatForeignKey(fk: ForeignKeyMeta): string {
    return `${fk.childTable}(${fk.childColumns.join(",")}) -> ${fk.parentTable}(${fk.parentColumns.join(",")})`;
  }

  private tupleFromRow(row: Record<string, any>, columns: string[]): KeyTuple | null {
    const tuple: KeyTuple = {};
    for (const column of columns) {
      if (row[column] === undefined || row[column] === null) {
        return null;
      }
      tuple[column] = row[column];
    }
    return tuple;
  }

  private storeTuples(
    tableName: string,
    columns: string[],
    tuples: KeyTuple[],
    idMap: Record<string, Record<string, any[]>>,
    tupleMap: KeyTupleMap,
  ): void {
    const signature = this.keySignature(columns);
    tupleMap[tableName] = tupleMap[tableName] || {};
    tupleMap[tableName][signature] = tupleMap[tableName][signature] || [];
    idMap[tableName] = idMap[tableName] || {};

    for (const tuple of tuples) {
      tupleMap[tableName][signature].push(tuple);
      for (const column of columns) {
        idMap[tableName][column] = idMap[tableName][column] || [];
        idMap[tableName][column].push(tuple[column]);
      }
    }
  }

  private buildTupleWhereClause(columns: string[], keys: any[]): { whereClause: string; params: any[] } {
    const clauses: string[] = [];
    const params: any[] = [];

    for (const key of keys) {
      const tuple = typeof key === "object" && key !== null
        ? key
        : columns.length === 1
          ? { [columns[0]]: key }
          : null;

      if (!tuple) continue;

      const tupleClauses: string[] = [];
      let valid = true;
      for (const column of columns) {
        if (tuple[column] === undefined || tuple[column] === null) {
          valid = false;
          break;
        }
        tupleClauses.push(`${this.security.escapeIdentifier(column)} = ?`);
        params.push(tuple[column]);
      }

      if (valid) {
        clauses.push(`(${tupleClauses.join(" AND ")})`);
      }
    }

    return {
      whereClause: clauses.length > 0 ? clauses.join(" OR ") : "1=0",
      params,
    };
  }

  private getSelectableTables(schema: DatabaseSchema, requestedTables?: string[], maxTables?: number): string[] {
    const limit = this.clampNumber(maxTables, 1, 200, 50);
    if (requestedTables && requestedTables.length > 0) {
      const tables = Array.from(new Set(requestedTables));
      for (const table of tables) {
        this.assertIdentifier(table, "table");
        if (!schema.tables[table]) {
          throw new Error(`Table '${table}' does not exist in database '${schema.database}'`);
        }
      }
      return tables.slice(0, limit);
    }

    return Object.keys(schema.tables).sort().slice(0, limit);
  }

  private async loadSampleRows(tableName: string, limit: number): Promise<Record<string, any>[]> {
    const query = `SELECT * FROM ${this.security.escapeIdentifier(tableName)} LIMIT ${limit}`;
    return await this.db.query<Record<string, any>[]>(query);
  }

  private refineRulesFromSamples(
    tableName: string,
    table: TableSchema,
    samples: Record<string, any>[],
    rules: Record<string, SeedRule>,
    warnings: string[],
  ): void {
    if (samples.length === 0) return;

    for (const column of table.columns) {
      const key = `${tableName}.${column.columnName}`;
      const values = samples
        .map((row) => row[column.columnName])
        .filter((value) => value !== null && value !== undefined);

      if (values.length === 0 || this.isSensitiveColumn(column.columnName)) {
        continue;
      }

      const numericValues = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));

      if (numericValues.length === values.length && this.isNumberColumn(column)) {
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);
        rules[key] = {
          ...rules[key],
          generator: this.isIntegerColumn(column) ? "integer" : "number",
          min,
          max: max > min ? max : min + 1,
          source: "sample_range",
        };
        continue;
      }

      const distinctValues = Array.from(new Set(values.map((value) => String(value)))).slice(0, 20);
      if (this.canUseChoiceFromSamples(column.columnName, distinctValues)) {
        rules[key] = {
          ...rules[key],
          generator: "choice",
          values: distinctValues,
          source: "sample_choice",
        };
        continue;
      }

      const pattern = this.inferPatternFromSamples(column, distinctValues);
      if (pattern) {
        rules[key] = {
          ...rules[key],
          generator: "pattern",
          pattern,
          source: "sample_pattern",
        };
      }
    }

    if (samples.length < 3) {
      warnings.push(`Only ${samples.length} sample row(s) available for '${tableName}', so inferred rules may be generic.`);
    }
  }

  private isSensitiveColumn(columnName: string): boolean {
    return /(password|token|secret|key|credential|email|phone|mobile|address|name)$/i.test(columnName);
  }

  private canUseChoiceFromSamples(columnName: string, values: string[]): boolean {
    if (values.length === 0 || values.length > 10) return false;
    if (!/(status|state|type|role|category|stage|source|method|channel|priority)$/i.test(columnName)) return false;
    return values.every((value) => value.length <= 50 && !/@/.test(value));
  }

  private inferPatternFromSamples(column: ColumnMeta, values: string[]): string | null {
    if (values.length === 0 || !/(code|sku|number|ref|reference|invoice|receipt)/i.test(column.columnName)) {
      return null;
    }

    const prefixMatch = values
      .map((value) => value.match(/^([A-Za-z]{2,10})[-_]/)?.[1])
      .find(Boolean);

    if (!prefixMatch) {
      return null;
    }

    return `${prefixMatch.toUpperCase()}-####`;
  }

  private detectDomainFromTables(tables: string[]): SeedDomain {
    const joined = tables.join("_").toLowerCase();
    if (/(order|product|cart|payment|shipment|invoice)/.test(joined)) return "ecommerce";
    if (/(sale|pos|cashier|receipt|shift|register)/.test(joined)) return "pos";
    if (/(lead|deal|opportunit|contact|account|company|activity)/.test(joined)) return "crm";
    return "generic";
  }

  private getDomainRule(domain: SeedDomain, tableName: string, column: ColumnMeta): SeedRule | undefined {
    const table = tableName.toLowerCase();
    const name = column.columnName.toLowerCase();

    if (domain === "ecommerce") {
      if (name.includes("sku")) return { generator: "pattern", pattern: "PRD-####", source: "domain_ecommerce" };
      if (name.includes("status") && table.includes("order")) return { generator: "choice", values: ["pending", "paid", "processing", "shipped", "cancelled"], source: "domain_ecommerce" };
      if (name.includes("status") && table.includes("payment")) return { generator: "choice", values: ["pending", "paid", "failed", "refunded"], source: "domain_ecommerce" };
      if (name.includes("method")) return { generator: "choice", values: ["cash", "bank_transfer", "card", "ewallet"], source: "domain_ecommerce" };
      if (name.includes("price") || name.includes("total") || name.includes("amount")) return { generator: "number", min: 10000, max: 750000, source: "domain_ecommerce" };
      if (name.includes("qty") || name.includes("quantity")) return { generator: "integer", min: 1, max: 5, source: "domain_ecommerce" };
    }

    if (domain === "pos") {
      if (name.includes("receipt") || name.includes("invoice")) return { generator: "pattern", pattern: "POS-####", source: "domain_pos" };
      if (name.includes("status")) return { generator: "choice", values: ["open", "paid", "void", "refunded"], source: "domain_pos" };
      if (name.includes("method")) return { generator: "choice", values: ["cash", "card", "qris", "ewallet"], source: "domain_pos" };
      if (name.includes("shift")) return { generator: "choice", values: ["morning", "afternoon", "night"], source: "domain_pos" };
      if (name.includes("price") || name.includes("total") || name.includes("amount")) return { generator: "number", min: 5000, max: 250000, source: "domain_pos" };
    }

    if (domain === "crm") {
      if (name.includes("stage")) return { generator: "choice", values: ["new", "qualified", "proposal", "won", "lost"], source: "domain_crm" };
      if (name.includes("status")) return { generator: "choice", values: ["new", "contacted", "qualified", "inactive"], source: "domain_crm" };
      if (name.includes("source")) return { generator: "choice", values: ["website", "referral", "event", "ads"], source: "domain_crm" };
      if (name.includes("company")) return { generator: "string", prefix: "Company", source: "domain_crm" };
      if (name.includes("amount") || name.includes("value")) return { generator: "number", min: 1000000, max: 100000000, source: "domain_crm" };
    }

    return undefined;
  }

  private detectTemplateTables(
    schema: DatabaseSchema,
    template: SeedTemplate,
    include?: string[],
    exclude?: string[],
  ): {
    targetTables: string[];
    detectedTables: Record<string, string[]>;
    ignoredTables: string[];
    warnings: string[];
  } {
    const excluded = new Set(exclude || []);
    for (const table of excluded) {
      this.assertIdentifier(table, "table");
    }

    if (include && include.length > 0) {
      const targetTables = Array.from(new Set(include)).filter((table) => !excluded.has(table));
      for (const table of targetTables) {
        this.assertIdentifier(table, "table");
        if (!schema.tables[table]) {
          throw new Error(`Included table '${table}' does not exist in database '${schema.database}'`);
        }
      }
      return {
        targetTables,
        detectedTables: { included: targetTables },
        ignoredTables: Array.from(excluded),
        warnings: [],
      };
    }

    const keywords = this.getTemplateKeywords(template);
    const tables = Object.keys(schema.tables);
    const detectedTables: Record<string, string[]> = {};
    const targetSet = new Set<string>();
    const warnings: string[] = [];

    for (const [role, roleKeywords] of Object.entries(keywords)) {
      const matches = tables.filter((table) => {
        const normalized = table.toLowerCase();
        return !excluded.has(table) && roleKeywords.some((keyword) => normalized.includes(keyword));
      });

      if (matches.length > 0) {
        detectedTables[role] = matches;
        matches.forEach((table) => targetSet.add(table));
      } else {
        warnings.push(`No table matched template role '${role}'.`);
      }
    }

    return {
      targetTables: Array.from(targetSet).sort(),
      detectedTables,
      ignoredTables: Array.from(excluded),
      warnings,
    };
  }

  private getTemplateKeywords(template: SeedTemplate): Record<string, string[]> {
    const templates: Record<SeedTemplate, Record<string, string[]>> = {
      ecommerce: {
        users: ["user", "customer", "member"],
        products: ["product", "item", "catalog"],
        orders: ["order", "cart", "checkout"],
        order_items: ["order_item", "order_detail", "line_item"],
        payments: ["payment", "transaction", "invoice"],
        shipments: ["shipment", "shipping", "delivery"],
      },
      pos: {
        customers: ["customer", "member"],
        products: ["product", "item", "inventory"],
        cashiers: ["cashier", "employee", "staff", "user"],
        sales: ["sale", "transaction", "receipt", "order"],
        sale_items: ["sale_item", "transaction_item", "receipt_item", "order_item"],
        payments: ["payment", "tender"],
        shifts: ["shift", "register"],
      },
      crm: {
        contacts: ["contact", "lead", "customer"],
        companies: ["company", "account", "organization"],
        deals: ["deal", "opportunity", "pipeline"],
        activities: ["activity", "task", "note", "interaction"],
        users: ["user", "owner", "agent"],
      },
    };

    return templates[template];
  }

  private getScaleRows(template: SeedTemplate, scale: TemplateScale, tables: string[]): Record<string, number> {
    const baseByScale: Record<TemplateScale, number> = {
      small: 10,
      medium: 50,
      large: 200,
    };
    const base = baseByScale[scale];
    const rows: Record<string, number> = {};

    for (const table of tables) {
      const normalized = table.toLowerCase();
      if (/(item|detail|line)/.test(normalized)) rows[table] = Math.min(base * 3, 1000);
      else if (/(product|inventory|catalog)/.test(normalized)) rows[table] = Math.min(base * 2, 1000);
      else if (/(payment|shipment|activity|task|note)/.test(normalized)) rows[table] = base;
      else if (template === "crm" && /(deal|opportunit)/.test(normalized)) rows[table] = base;
      else rows[table] = base;
    }

    return rows;
  }

  private buildTemplateRules(template: SeedTemplate, tables: string[], schema: DatabaseSchema): Record<string, SeedRule> {
    return this.buildInferredSeedRules(tables, schema, {}, template);
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
