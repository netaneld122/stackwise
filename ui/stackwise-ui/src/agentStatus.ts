export type AgentId = "claude" | "codex" | "cursor" | "opencode";

export type AgentHandoffResponse = {
  agent: string;
  handoff_id: string;
  prompt_path: string;
  context_path: string;
  script_path: string;
  status_path: string;
  log_path: string;
  command: string;
  message: string;
};

export type AgentHandoffStatus = {
  id: string;
  agent: string;
  state: "running" | "succeeded" | "failed";
  exit_code: number | null;
  message: string;
  log_tail: string | null;
  prompt_path: string;
  context_path: string;
  script_path: string;
  log_path: string;
  updated_at: number;
};

export function agentLaunchErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/failed to fetch|load failed|networkerror/i.test(message)) {
    return "Stackwise server is not reachable. Reopen the report with `stackwise open <report.json> --serve` and use that live localhost URL.";
  }
  return message;
}

export function agentStatusDisplayMessage(status: AgentHandoffStatus): string {
  const tail = readableLogTail(status.log_tail);
  if (status.state === "running") {
    return tail ? `${status.message}\n\nLog tail:\n${tail}` : status.message;
  }

  return tail ? `${status.message}\n\nLog tail:\n${tail}` : status.message;
}

export function isAgentUnavailableStatus(agent: AgentId, status: AgentHandoffStatus): boolean {
  if (agent !== "claude" || status.state !== "failed") return false;
  const text = `${status.message}\n${status.log_tail ?? ""}`;
  return /Claude is unavailable|does not have access to Claude|Please login again|contact your administrator/i.test(
    text,
  );
}

function readableLogTail(value: string | null): string {
  if (!value) return "";
  const lines = value
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return lines.slice(-8).join("\n");
}
