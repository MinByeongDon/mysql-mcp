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
      case "bulk_insert":
        return validateBulkInsert(args);
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
