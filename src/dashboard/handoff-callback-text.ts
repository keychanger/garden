// The callback a handoff child's parent is owed once the child reaches a
// terminal prState. A string-only leaf, so poller-state.ts can compose it inside
// the registry write that claims the callback without loading continue.ts, which
// pastes it later.
export function handoffCallbackText(opts: {
  childProject: string;
  childWorker: string;
  childBranch: string | undefined;
  terminalState: "merged" | "done" | "failing";
  replyNote: string | undefined;
}): string {
  const stateLabel
    = opts.terminalState === "merged" ? "merged"
      : opts.terminalState === "done" ? "done (no further work expected)"
      : "failing (needs operator attention)";
  const lines: string[] = [
    `[garden] Handoff callback: ${opts.childProject}/${opts.childWorker} reached terminal state \`${stateLabel}\`.`,
  ];
  if (opts.childBranch) lines.push(`  branch: ${opts.childBranch}`);
  if (opts.replyNote && opts.replyNote.trim()) {
    lines.push("", `Reply from ${opts.childWorker}:`, opts.replyNote.trim());
  }
  return lines.join("\n");
}
