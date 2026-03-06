import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MySQLMCP } from "../index.js";

const toCamelCase = (value: string): string =>
  value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

export const isToolEnabled = (mysqlMCP: MySQLMCP, tool: Tool): boolean => {
  const camelCaseName = toCamelCase(tool.name);
  return mysqlMCP.isToolEnabled(camelCaseName) || mysqlMCP.isToolEnabled(tool.name);
};

export const getEnabledTools = (mysqlMCP: MySQLMCP, tools: Tool[]): Tool[] =>
  tools.filter((tool) => isToolEnabled(mysqlMCP, tool));
