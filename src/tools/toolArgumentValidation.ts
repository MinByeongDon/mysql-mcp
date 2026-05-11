import {
  validateCreateRecord,
  validateReadRecords,
  validateUpdateRecord,
  validateDeleteRecord,
  validateQuery,
  validateBulkInsert,
  validateTableName,
  validateValue,
} from "../validation/inputValidation.js";

const validatePlanSeedDataArgs = (args: any): { valid: boolean; errors?: string[] } => {
  const errors: string[] = [];

  if (!Array.isArray(args.target_tables) || args.target_tables.length === 0) {
    errors.push("target_tables must be a non-empty array");
  } else {
    for (const table of args.target_tables) {
      const validation = validateTableName(table);
      if (!validation.valid) {
        errors.push(`Invalid target table '${table}': ${validation.error}`);
      }
    }
  }

  if (args.database !== undefined) {
    const validation = validateValue(args.database);
    if (!validation.valid) errors.push(validation.error || "Invalid database name");
  }

  validateRowsPerTable(args.rows_per_table, errors);

  return errors.length ? { valid: false, errors } : { valid: true };
};

const validateRowsPerTable = (rowsPerTable: any, errors: string[]): void => {
  if (rowsPerTable === undefined) return;

  if (typeof rowsPerTable === "number") {
    if (!Number.isFinite(rowsPerTable) || rowsPerTable < 0) {
      errors.push("rows_per_table must be a non-negative number");
    }
    return;
  }

  if (typeof rowsPerTable === "object" && rowsPerTable !== null && !Array.isArray(rowsPerTable)) {
    for (const [table, count] of Object.entries(rowsPerTable)) {
      const tableValidation = validateTableName(table);
      if (!tableValidation.valid) errors.push(`Invalid rows_per_table key '${table}': ${tableValidation.error}`);
      if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
        errors.push(`rows_per_table.${table} must be a non-negative number`);
      }
    }
    return;
  }

  errors.push("rows_per_table must be a number or object map");
};

const validateTableList = (value: any, key: string, errors: string[]): void => {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${key} must be an array`);
    return;
  }
  for (const table of value) {
    const validation = validateTableName(table);
    if (!validation.valid) errors.push(`Invalid ${key} table '${table}': ${validation.error}`);
  }
};

const validateInferSeedRulesArgs = (args: any): { valid: boolean; errors?: string[] } => {
  const errors: string[] = [];

  if (args.database !== undefined) {
    const validation = validateValue(args.database);
    if (!validation.valid) errors.push(validation.error || "Invalid database name");
  }

  validateTableList(args.tables, "tables", errors);

  if (args.domain !== undefined && !["auto", "generic", "ecommerce", "pos", "crm"].includes(args.domain)) {
    errors.push("domain must be one of auto, generic, ecommerce, pos, crm");
  }

  if (args.sample_size !== undefined && (!Number.isFinite(Number(args.sample_size)) || Number(args.sample_size) < 0)) {
    errors.push("sample_size must be a non-negative number");
  }

  if (args.max_tables !== undefined && (!Number.isFinite(Number(args.max_tables)) || Number(args.max_tables) < 1)) {
    errors.push("max_tables must be a positive number");
  }

  return errors.length ? { valid: false, errors } : { valid: true };
};

const validateSeedFromTemplateArgs = (args: any): { valid: boolean; errors?: string[] } => {
  const errors: string[] = [];

  if (!args.template || !["ecommerce", "pos", "crm"].includes(args.template)) {
    errors.push("template must be one of ecommerce, pos, crm");
  }

  if (args.database !== undefined) {
    const validation = validateValue(args.database);
    if (!validation.valid) errors.push(validation.error || "Invalid database name");
  }

  if (args.scale !== undefined && !["small", "medium", "large"].includes(args.scale)) {
    errors.push("scale must be one of small, medium, large");
  }

  validateTableList(args.include, "include", errors);
  validateTableList(args.exclude, "exclude", errors);
  validateRowsPerTable(args.rows_per_table, errors);

  return errors.length ? { valid: false, errors } : { valid: true };
};

const validatePlanIdArgs = (args: any): { valid: boolean; errors?: string[] } => {
  if (!args.plan_id || typeof args.plan_id !== "string") {
    return { valid: false, errors: ["plan_id is required"] };
  }

  if (!/^seed_plan_[A-Za-z0-9_]+$/.test(args.plan_id)) {
    return { valid: false, errors: ["plan_id has invalid format"] };
  }

  return { valid: true };
};

export function validateToolArguments(
  name: string,
  args: any,
): { valid: boolean; errors?: string[] } {
  if (!args) return { valid: true };

  try {
    switch (name) {
      case "create_record":
        return validateCreateRecord(args);
      case "read_records":
        return validateReadRecords(args);
      case "update_record":
        return validateUpdateRecord(args);
      case "delete_record":
        return validateDeleteRecord(args);
      case "run_select_query":
      case "execute_write_query":
      case "execute_ddl":
        return validateQuery({ query: args?.query || "" });
      case "export_query_to_csv":
        return validateQuery({
          query: args?.query || "",
          params: args?.params,
        });
      case "bulk_insert":
        return validateBulkInsert(args);
      case "plan_seed_data":
        return validatePlanSeedDataArgs(args);
      case "generate_seed_preview":
      case "execute_seed_plan":
      case "validate_seed_integrity":
        return validatePlanIdArgs(args);
      case "infer_seed_rules":
        return validateInferSeedRulesArgs(args);
      case "seed_from_template":
        return validateSeedFromTemplateArgs(args);
      case "list_tables":
      case "get_schema_erd":
      case "get_schema_rag_context":
      case "get_database_summary":
        if (args.database !== undefined) {
          const validation = validateValue(args.database);
          if (!validation.valid) {
            return {
              valid: false,
              errors: [validation.error || "Invalid database name"],
            };
          }
        }
        return { valid: true };
      case "get_column_statistics":
      case "read_table_schema":
        if (args.table_name) {
          const validation = validateTableName(args.table_name);
          if (!validation.valid) {
            return {
              valid: false,
              errors: [validation.error || "Invalid table name"],
            };
          }
        }
        return { valid: true };
      default:
        return { valid: true };
    }
  } catch (error) {
    return {
      valid: false,
      errors: [
        `Validation error: ${error instanceof Error ? error.message : "Unknown validation error"}`,
      ],
    };
  }
}
