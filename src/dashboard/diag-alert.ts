// Surface a status-pane corruption capture to the operator. Called from the
// auto-detector in buildStatusCommand (src/dashboard/header.ts) via
// `garden dashboard _diag-alert <snapshot-path>`. Uses a stable dedupKey so
// repeated firings inside the 1h window collapse to one alert.
import { addAlert } from "./alerts.js";

export async function runDiagAlert(snapshotPath: string | undefined): Promise<void> {
  if (!snapshotPath) return;
  addAlert({
    level: "warn",
    source: "diag-status",
    project: "garden",
    message: `Status-pane corruption captured: ${snapshotPath}. Run 'garden diag handoff' to dispatch a fixer.`,
    dedupKey: "diag-status:duplicate-rows",
  });
}
