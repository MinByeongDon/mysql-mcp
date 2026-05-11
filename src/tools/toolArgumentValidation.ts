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

  if (args.rows_per_table !== undefined) {
    if (typeof args.rows_per_table === "number") {
      if (!Number.isFinite(args.rows_per_table) || args.rows_per_table < 0) {
        errors.push("rows_per_table must be a non-negative number");
      }
    } else if (typeof args.rows_per_table === "object" && args.rows_per_table !== null && !Array.isArray(args.rows_per_table)) {
      for (const [table, count] of Object.entries(args.rows_per_table)) {
        const tableValidation = validateTableName(table);
        if (!tableValidation.valid) errors.push(`Invalid rows_per_table key '${table}': ${tableValidation.error}`);
        if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
          errors.push(`rows_per_table.${table} must be a non-negative number`);
        }
      }
    } else {
      errors.push("rows_per_table must be a number or object map");
    }
  }

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
