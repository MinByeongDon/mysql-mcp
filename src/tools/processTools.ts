import DatabaseConnection from "../db/connection";
import { SecurityLayer } from "../security/securityLayer";

export class ProcessTools {
  private db: DatabaseConnection;
  private security: SecurityLayer;

  constructor(security: SecurityLayer) {
    this.db = DatabaseConnection.getInstance();
    this.security = security;
  }

  /**
   * Show all running processes/connections
   */
  async showProcessList(params?: { full?: boolean }): Promise<{
    status: string;
    data?: any[];
    error?: string;
  }> {
    try {
      const query = params?.full ? "SHOW FULL PROCESSLIST" : "SHOW PROCESSLIST";
      const results = await this.db.query<any[]>(query);

      // Format results for better readability
      const formattedResults = results.map((row) => ({
        id: row.Id,
        user: row.User,
        host: row.Host,
        database: row.db,
        command: row.Command,
        time: row.Time,
        state: row.State,
        info: row.Info,
        progress: row.Progress,
      }));

      return {
        status: "success",
        data: formattedResults,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Kill a specific process/connection
   */
  async killProcess(params: {
    process_id: number;
    type?: "CONNECTION" | "QUERY";
  }): Promise<{
    status: string;
    message?: string;
    error?: string;
  }> {
    try {
      const { process_id, type = "CONNECTION" } = params;

      // Validate process_id is a positive integer
      if (!Number.isInteger(process_id) || process_id <= 0) {
        return {
          status: "error",
          error: "Process ID must be a positive integer",
        };
      }

      const query =
        type === "QUERY" ? `KILL QUERY ${process_id}` : `KILL ${process_id}`;

      await this.db.query(query);

      return {
        status: "success",
        message:
          type === "QUERY"
            ? `Query for process ${process_id} killed successfully`
            : `Process ${process_id} killed successfully`,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Show server status variables
   */
  async showStatus(params?: { like?: string; global?: boolean }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      let query = params?.global ? "SHOW GLOBAL STATUS" : "SHOW STATUS";

      if (params?.like) {
        // Validate the LIKE pattern (basic check)
        if (params.like.includes(";") || params.like.includes("--")) {
          return { status: "error", error: "Invalid pattern" };
        }
        query += ` LIKE '${params.like}'`;
      }

      const results = await this.db.query<any[]>(query);

      // Convert to object for easier access
      const statusObj: Record<string, string> = {};
      for (const row of results) {
        statusObj[row.Variable_name] = row.Value;
      }

      return {
        status: "success",
        data: params?.like
          ? statusObj
          : {
              variables: statusObj,
              count: results.length,
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
   * Show server variables
   */
  async showVariables(params?: { like?: string; global?: boolean }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      let query = params?.global ? "SHOW GLOBAL VARIABLES" : "SHOW VARIABLES";

      if (params?.like) {
        // Validate the LIKE pattern (basic check)
        if (params.like.includes(";") || params.like.includes("--")) {
          return { status: "error", error: "Invalid pattern" };
        }
        query += ` LIKE '${params.like}'`;
      }

      const results = await this.db.query<any[]>(query);

      // Convert to object for easier access
      const varsObj: Record<string, string> = {};
      for (const row of results) {
        varsObj[row.Variable_name] = row.Value;
      }

      return {
        status: "success",
        data: params?.like
          ? varsObj
          : {
              variables: varsObj,
              count: results.length,
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
   * Explain a query (show execution plan)
   */
  async explainQuery(params: {
    query: string;
    format?: "TRADITIONAL" | "JSON" | "TREE";
    analyze?: boolean;
  }): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const { query, format = "TRADITIONAL", analyze = false } = params;

      // Only allow SELECT, UPDATE, DELETE, INSERT queries to be explained
      const normalizedQuery = query.trim().toUpperCase();
      if (
        !normalizedQuery.startsWith("SELECT") &&
        !normalizedQuery.startsWith("UPDATE") &&
        !normalizedQuery.startsWith("DELETE") &&
        !normalizedQuery.startsWith("INSERT")
      ) {
        return {
          status: "error",
          error:
            "EXPLAIN only supports SELECT, UPDATE, DELETE, and INSERT statements",
        };
      }

      let explainQuery = analyze ? "EXPLAIN ANALYZE " : "EXPLAIN ";

      if (format !== "TRADITIONAL") {
        explainQuery += `FORMAT=${format} `;
      }

      explainQuery += query;

      const results = await this.db.query<any[]>(explainQuery);

      return {
        status: "success",
        data: format === "JSON" ? JSON.parse(results[0]["EXPLAIN"]) : results,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }
}

