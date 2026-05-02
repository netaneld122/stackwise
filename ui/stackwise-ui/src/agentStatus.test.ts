import { describe, expect, it } from "vitest";
import {
  agentLaunchErrorMessage,
  agentStatusDisplayMessage,
  isAgentUnavailableStatus,
  type AgentHandoffStatus,
} from "./agentStatus";

describe("agent status helpers", () => {
  it("keeps stale localhost pages actionable", () => {
    expect(agentLaunchErrorMessage(new TypeError("Failed to fetch"))).toContain(
      "Stackwise server is not reachable",
    );
  });

  it("marks Claude unavailable only for Claude access failures", () => {
    const status = failedStatus(
      "Claude is unavailable for this account. Try Codex, Cursor, or OpenCode.",
      "Your organization does not have access to Claude. Please login again.",
    );

    expect(isAgentUnavailableStatus("claude", status)).toBe(true);
    expect(isAgentUnavailableStatus("codex", status)).toBe(false);
  });

  it("shows a compact log tail for failed handoffs", () => {
    const status = failedStatus("Claude exited with code 1.", "first\nsecond\nthird");

    expect(agentStatusDisplayMessage(status)).toContain("Claude exited with code 1.");
    expect(agentStatusDisplayMessage(status)).toContain("Log tail:");
    expect(agentStatusDisplayMessage(status)).toContain("third");
  });

  it("shows live log tail for running handoffs", () => {
    const status = failedStatus("OpenCode is running.", "booting\nconnecting");
    status.state = "running";
    status.exit_code = null;

    expect(agentStatusDisplayMessage(status)).toContain("OpenCode is running.");
    expect(agentStatusDisplayMessage(status)).toContain("Log tail:");
    expect(agentStatusDisplayMessage(status)).toContain("connecting");
  });
});

function failedStatus(message: string, logTail: string): AgentHandoffStatus {
  return {
    id: "123-claude-demo",
    agent: "Claude",
    state: "failed",
    exit_code: 1,
    message,
    log_tail: logTail,
    prompt_path: "brief.prompt.md",
    context_path: "brief.context.json",
    script_path: "launch.cmd",
    log_path: "brief.log",
    updated_at: 1,
  };
}
