export type ToolName =
  | "repo_map"
  | "grep_search"
  | "read_file"
  | "patch_file"
  | "write_file"
  | "run_cmd"
  | "auto_verify";

export interface ParsedToolCall {
  tool: ToolName;
  path?: string;
  query?: string;
  start?: number;
  end?: number;
  ranges?: string;
  force?: boolean;
  regex?: boolean;
  glob?: string;
  context?: number;
  symbols?: boolean;
  search?: string;
  replace?: string;
  content?: string;
  cmd?: string;
}

export interface ToolExecutionResult {
  tool: ToolName;
  ok: boolean;
  output: string;
  errorHash?: string;
  targetPath?: string;
  deduped?: boolean;
}

export interface CheckpointRecord {
  id: string;
  commitSha: string;
  parentSha: string | null;
  timestamp: string;
  treeSha: string | null;
  restorableFiles: string[];
  createdFiles: string[];
  createdDirs: string[];
  touchedFiles: string[];
}

export interface ExecuteRequest {
  tools: ParsedToolCall[];
  turn?: number;
}

export interface ExecuteResponse {
  ok: boolean;
  checkpointId: string | null;
  results: ToolExecutionResult[];
  formattedBlock: string;
  loopWarning: string | null;
  durationMs: number;
  payloadBytes: number;
  truncated: boolean;
  autoVerified: boolean;
}
