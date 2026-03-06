import DatabaseConnection from "../db/connection";
import { SecurityLayer } from "../security/securityLayer";

export class PerformanceTools {
  private db: DatabaseConnection;
  private security: SecurityLayer;

  constructor(security: SecurityLayer) {
    this.db = DatabaseConnection.getInstance();
    this.security = security;
  }

  /**
   * Get comprehensive performance metrics
   */
  async getPerformanceMetrics(): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const metrics: Record<string, any> = {};

      // Get query performance metrics
      const perfQuery = `
        SELECT
          SUM(TIMER_WAIT) / 1000000000000 as total_execution_time_sec,
          SUM(LOCK_TIME) / 1000000000000 as total_lock_time_sec,
          SUM(ROWS_EXAMINED) as total_rows_examined,
          SUM(ROWS_SENT) as total_rows_sent,
          SUM(ROWS_AFFECTED) as total_rows_affected,
          SUM(SELECT_FULL_JOIN) as full_table_scans,
          SUM(NO_INDEX_USED) as queries_without_indexes,
          SUM(NO_GOOD_INDEX_USED) as queries_with_bad_indexes,
          COUNT(*) as total_queries
        FROM performance_schema.events_statements_summary_global_by_event_name
        WHERE EVENT_NAME LIKE 'statement/sql/%'
      `;

      const perfResult = await this.db.query<any[]>(perfQuery);
      metrics.query_performance = perfResult[0] || {};

      // Get connection metrics
      const connQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN (
          'Threads_connected', 'Threads_running', 'Threads_created',
          'Connections', 'Max_used_connections', 'Aborted_connects', 'Aborted_clients'
        )
      `;
      const connResult = await this.db.query<any[]>(connQuery);
      metrics.connections = {};
      for (const row of connResult) {
        metrics.connections[row.Variable_name.toLowerCase()] = row.Value;
      }

      // Get table cache metrics
      const cacheQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN (
          'Open_tables', 'Opened_tables', 'Table_open_cache_hits',
          'Table_open_cache_misses', 'Table_open_cache_overflows'
        )
      `;
      const cacheResult = await this.db.query<any[]>(cacheQuery);
      metrics.table_cache = {};
      for (const row of cacheResult) {
        metrics.table_cache[row.Variable_name.toLowerCase()] = row.Value;
      }

      // Get InnoDB metrics
      const innodbQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name LIKE 'Innodb_%'
        AND Variable_name IN (
          'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests',
          'Innodb_buffer_pool_pages_total', 'Innodb_buffer_pool_pages_free',
          'Innodb_buffer_pool_pages_data', 'Innodb_buffer_pool_pages_dirty',
          'Innodb_row_lock_waits', 'Innodb_row_lock_time', 'Innodb_rows_read',
          'Innodb_rows_inserted', 'Innodb_rows_updated', 'Innodb_rows_deleted'
        )
      `;
      const innodbResult = await this.db.query<any[]>(innodbQuery);
      metrics.innodb = {};
      for (const row of innodbResult) {
        metrics.innodb[row.Variable_name.toLowerCase()] = row.Value;
      }

      // Calculate buffer pool hit ratio
      if (
        metrics.innodb.innodb_buffer_pool_read_requests &&
        metrics.innodb.innodb_buffer_pool_reads
      ) {
        const requests = parseFloat(
          metrics.innodb.innodb_buffer_pool_read_requests,
        );
        const reads = parseFloat(metrics.innodb.innodb_buffer_pool_reads);
        metrics.innodb.buffer_pool_hit_ratio =
          (((requests - reads) / requests) * 100).toFixed(2) + "%";
      }

      // Get slow query metrics
      const slowQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN ('Slow_queries', 'Questions')
      `;
      const slowResult = await this.db.query<any[]>(slowQuery);
      metrics.slow_queries = {};
      for (const row of slowResult) {
        metrics.slow_queries[row.Variable_name.toLowerCase()] = row.Value;
      }

      // Calculate slow query percentage
      if (metrics.slow_queries.questions && metrics.slow_queries.slow_queries) {
        const total = parseFloat(metrics.slow_queries.questions);
        const slow = parseFloat(metrics.slow_queries.slow_queries);
        metrics.slow_queries.slow_query_percentage =
          ((slow / total) * 100).toFixed(4) + "%";
      }

      return {
        status: "success",
        data: metrics,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }



  /**
   * Get top queries by execution count
   */


  /**
   * Get slow queries
   */


  /**
   * Get table I/O statistics
   */
  async getTableIOStats(params?: {
    limit?: number;
    table_schema?: string;
  }): Promise<{
    status: string;
    data?: any[];
    error?: string;
  }> {
    try {
      const limit = params?.limit || 20;
      const schema = params?.table_schema;

      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        return {
          status: "error",
          error: "Limit must be a positive integer between 1 and 100",
        };
      }

      let query = `
        SELECT
          OBJECT_SCHEMA as table_schema,
          OBJECT_NAME as table_name,
          COUNT_READ as read_operations,
          COUNT_WRITE as write_operations,
          COUNT_FETCH as fetch_operations,
          COUNT_INSERT as insert_operations,
          COUNT_UPDATE as update_operations,
          COUNT_DELETE as delete_operations,
          ROUND(SUM_TIMER_READ / 1000000000000, 6) as total_read_time_sec,
          ROUND(SUM_TIMER_WRITE / 1000000000000, 6) as total_write_time_sec,
          ROUND(SUM_TIMER_FETCH / 1000000000000, 6) as total_fetch_time_sec
        FROM performance_schema.table_io_waits_summary_by_table
        WHERE OBJECT_SCHEMA NOT IN ('mysql', 'performance_schema', 'information_schema', 'sys')
      `;

      if (schema) {
        query += ` AND OBJECT_SCHEMA = '${schema.replace(/'/g, "''")}'`;
      }

      query += ` ORDER BY (COUNT_READ + COUNT_WRITE) DESC LIMIT ${limit}`;

      const results = await this.db.query<any[]>(query);

      return {
        status: "success",
        data: results,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Get index usage statistics
   */
  async getIndexUsageStats(params?: {
    limit?: number;
    table_schema?: string;
  }): Promise<{
    status: string;
    data?: any[];
    error?: string;
  }> {
    try {
      const limit = params?.limit || 20;
      const schema = params?.table_schema;

      if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        return {
          status: "error",
          error: "Limit must be a positive integer between 1 and 100",
        };
      }

      let query = `
        SELECT
          OBJECT_SCHEMA as table_schema,
          OBJECT_NAME as table_name,
          INDEX_NAME as index_name,
          COUNT_STAR as usage_count,
          COUNT_READ as read_count,
          COUNT_WRITE as write_count,
          COUNT_FETCH as fetch_count,
          COUNT_INSERT as insert_count,
          COUNT_UPDATE as update_count,
          COUNT_DELETE as delete_count
        FROM performance_schema.table_io_waits_summary_by_index_usage
        WHERE OBJECT_SCHEMA NOT IN ('mysql', 'performance_schema', 'information_schema', 'sys')
        AND INDEX_NAME IS NOT NULL
      `;

      if (schema) {
        query += ` AND OBJECT_SCHEMA = '${schema.replace(/'/g, "''")}'`;
      }

      query += ` ORDER BY COUNT_STAR DESC LIMIT ${limit}`;

      const results = await this.db.query<any[]>(query);

      return {
        status: "success",
        data: results,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Get unused indexes
   */
  async getUnusedIndexes(params?: { table_schema?: string }): Promise<{
    status: string;
    data?: any[];
    error?: string;
  }> {
    try {
      const schema = params?.table_schema;

      let query = `
        SELECT
          t.TABLE_SCHEMA as table_schema,
          t.TABLE_NAME as table_name,
          s.INDEX_NAME as index_name,
          s.COLUMN_NAME as column_name,
          s.SEQ_IN_INDEX as sequence_in_index,
          s.NON_UNIQUE as is_non_unique
        FROM information_schema.STATISTICS s
        LEFT JOIN performance_schema.table_io_waits_summary_by_index_usage p
          ON s.TABLE_SCHEMA = p.OBJECT_SCHEMA
          AND s.TABLE_NAME = p.OBJECT_NAME
          AND s.INDEX_NAME = p.INDEX_NAME
        JOIN information_schema.TABLES t
          ON s.TABLE_SCHEMA = t.TABLE_SCHEMA
          AND s.TABLE_NAME = t.TABLE_NAME
        WHERE s.TABLE_SCHEMA NOT IN ('mysql', 'performance_schema', 'information_schema', 'sys')
          AND s.INDEX_NAME != 'PRIMARY'
          AND (p.INDEX_NAME IS NULL OR p.COUNT_STAR = 0)
          AND t.TABLE_TYPE = 'BASE TABLE'
      `;

      if (schema) {
        query += ` AND s.TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
      }

      query += ` ORDER BY s.TABLE_SCHEMA, s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX`;

      const results = await this.db.query<any[]>(query);

      return {
        status: "success",
        data: results,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Get connection pool statistics
   */
  async getConnectionPoolStats(): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const statusQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN (
          'Threads_connected', 'Threads_running', 'Threads_created', 'Threads_cached',
          'Connections', 'Max_used_connections', 'Max_used_connections_time',
          'Aborted_connects', 'Aborted_clients', 'Connection_errors_max_connections'
        )
      `;

      const variablesQuery = `
        SHOW GLOBAL VARIABLES WHERE Variable_name IN (
          'max_connections', 'thread_cache_size', 'connect_timeout',
          'wait_timeout', 'interactive_timeout'
        )
      `;

      const statusResult = await this.db.query<any[]>(statusQuery);
      const variablesResult = await this.db.query<any[]>(variablesQuery);

      const stats: Record<string, any> = {
        current_status: {},
        configuration: {},
        health_indicators: {},
      };

      for (const row of statusResult) {
        stats.current_status[row.Variable_name.toLowerCase()] = row.Value;
      }

      for (const row of variablesResult) {
        stats.configuration[row.Variable_name.toLowerCase()] = row.Value;
      }

      // Calculate health indicators
      const threadsConnected = parseInt(
        stats.current_status.threads_connected || "0",
      );
      const maxConnections = parseInt(
        stats.configuration.max_connections || "0",
      );
      const maxUsedConnections = parseInt(
        stats.current_status.max_used_connections || "0",
      );

      if (maxConnections > 0) {
        stats.health_indicators.connection_usage_percentage =
          ((threadsConnected / maxConnections) * 100).toFixed(2) + "%";
        stats.health_indicators.max_usage_percentage =
          ((maxUsedConnections / maxConnections) * 100).toFixed(2) + "%";
        stats.health_indicators.available_connections =
          maxConnections - threadsConnected;
      }

      // Connection efficiency
      const totalConnections = parseInt(
        stats.current_status.connections || "0",
      );
      const abortedConnects = parseInt(
        stats.current_status.aborted_connects || "0",
      );
      if (totalConnections > 0) {
        stats.health_indicators.aborted_connection_percentage =
          ((abortedConnects / totalConnections) * 100).toFixed(4) + "%";
      }

      // Thread cache efficiency
      const threadsCreated = parseInt(
        stats.current_status.threads_created || "0",
      );
      if (totalConnections > 0) {
        stats.health_indicators.thread_cache_hit_rate =
          (
            ((totalConnections - threadsCreated) / totalConnections) *
            100
          ).toFixed(2) + "%";
      }

      return {
        status: "success",
        data: stats,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Get database health check
   */
  async getDatabaseHealthCheck(): Promise<{
    status: string;
    data?: any;
    error?: string;
  }> {
    try {
      const health: Record<string, any> = {
        overall_status: "healthy",
        checks: [],
        warnings: [],
        errors: [],
      };

      // Check 1: Connection usage
      const connQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Max_used_connections')
      `;
      const maxConnQuery = `SHOW GLOBAL VARIABLES WHERE Variable_name = 'max_connections'`;

      const connResult = await this.db.query<any[]>(connQuery);
      const maxConnResult = await this.db.query<any[]>(maxConnQuery);

      let threadsConnected = 0;
      let maxUsedConnections = 0;
      let maxConnections = 0;

      for (const row of connResult) {
        if (row.Variable_name === "Threads_connected")
          threadsConnected = parseInt(row.Value);
        if (row.Variable_name === "Max_used_connections")
          maxUsedConnections = parseInt(row.Value);
      }
      for (const row of maxConnResult) {
        maxConnections = parseInt(row.Value);
      }

      const connUsage = (threadsConnected / maxConnections) * 100;
      const maxConnUsage = (maxUsedConnections / maxConnections) * 100;

      health.checks.push({
        name: "Connection Usage",
        status:
          connUsage < 80 ? "healthy" : connUsage < 90 ? "warning" : "critical",
        current: threadsConnected,
        max: maxConnections,
        usage_percentage: connUsage.toFixed(2) + "%",
      });

      if (connUsage >= 90) {
        health.errors.push("Connection usage is critically high (>90%)");
        health.overall_status = "critical";
      } else if (connUsage >= 80) {
        health.warnings.push("Connection usage is high (>80%)");
        if (health.overall_status === "healthy")
          health.overall_status = "warning";
      }

      // Check 2: Buffer pool hit ratio
      const bufferQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads')
      `;
      const bufferResult = await this.db.query<any[]>(bufferQuery);

      let readRequests = 0;
      let reads = 0;

      for (const row of bufferResult) {
        if (row.Variable_name === "Innodb_buffer_pool_read_requests")
          readRequests = parseInt(row.Value);
        if (row.Variable_name === "Innodb_buffer_pool_reads")
          reads = parseInt(row.Value);
      }

      const hitRatio =
        readRequests > 0 ? ((readRequests - reads) / readRequests) * 100 : 100;

      health.checks.push({
        name: "Buffer Pool Hit Ratio",
        status:
          hitRatio > 95 ? "healthy" : hitRatio > 85 ? "warning" : "critical",
        hit_ratio: hitRatio.toFixed(2) + "%",
      });

      if (hitRatio <= 85) {
        health.errors.push("Buffer pool hit ratio is too low (<85%)");
        health.overall_status = "critical";
      } else if (hitRatio <= 95) {
        health.warnings.push("Buffer pool hit ratio could be improved (<95%)");
        if (health.overall_status === "healthy")
          health.overall_status = "warning";
      }

      // Check 3: Aborted connections
      const abortQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN ('Connections', 'Aborted_connects')
      `;
      const abortResult = await this.db.query<any[]>(abortQuery);

      let totalConnections = 0;
      let abortedConnects = 0;

      for (const row of abortResult) {
        if (row.Variable_name === "Connections")
          totalConnections = parseInt(row.Value);
        if (row.Variable_name === "Aborted_connects")
          abortedConnects = parseInt(row.Value);
      }

      const abortRate =
        totalConnections > 0 ? (abortedConnects / totalConnections) * 100 : 0;

      health.checks.push({
        name: "Aborted Connections",
        status:
          abortRate < 1 ? "healthy" : abortRate < 5 ? "warning" : "critical",
        aborted: abortedConnects,
        total: totalConnections,
        abort_rate: abortRate.toFixed(4) + "%",
      });

      if (abortRate >= 5) {
        health.errors.push("High rate of aborted connections (>5%)");
        if (health.overall_status !== "critical")
          health.overall_status = "warning";
      } else if (abortRate >= 1) {
        health.warnings.push("Elevated rate of aborted connections (>1%)");
        if (health.overall_status === "healthy")
          health.overall_status = "warning";
      }

      // Check 4: Slow queries
      const slowQuery = `
        SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions', 'Slow_queries')
      `;
      const slowResult = await this.db.query<any[]>(slowQuery);

      let questions = 0;
      let slowQueries = 0;

      for (const row of slowResult) {
        if (row.Variable_name === "Questions") questions = parseInt(row.Value);
        if (row.Variable_name === "Slow_queries")
          slowQueries = parseInt(row.Value);
      }

      const slowQueryRate = questions > 0 ? (slowQueries / questions) * 100 : 0;

      health.checks.push({
        name: "Slow Queries",
        status:
          slowQueryRate < 1
            ? "healthy"
            : slowQueryRate < 5
              ? "warning"
              : "critical",
        slow_queries: slowQueries,
        total_queries: questions,
        slow_query_rate: slowQueryRate.toFixed(4) + "%",
      });

      if (slowQueryRate >= 5) {
        health.warnings.push("High rate of slow queries (>5%)");
        if (health.overall_status === "healthy")
          health.overall_status = "warning";
      } else if (slowQueryRate >= 1) {
        health.warnings.push("Elevated rate of slow queries (>1%)");
        if (health.overall_status === "healthy")
          health.overall_status = "warning";
      }

      return {
        status: "success",
        data: health,
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }

  /**
   * Reset performance schema statistics
   */
  async resetPerformanceStats(): Promise<{
    status: string;
    message?: string;
    error?: string;
  }> {
    try {
      // Truncate performance schema summary tables
      const tables = [
        "events_statements_summary_by_digest",
        "events_statements_summary_global_by_event_name",
        "table_io_waits_summary_by_table",
        "table_io_waits_summary_by_index_usage",
      ];

      for (const table of tables) {
        await this.db.query(`TRUNCATE TABLE performance_schema.${table}`);
      }

      return {
        status: "success",
        message: "Performance statistics reset successfully",
      };
    } catch (error: any) {
      return {
        status: "error",
        error: error.message,
      };
    }
  }
}
