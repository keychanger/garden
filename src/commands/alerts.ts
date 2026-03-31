// Command: garden alerts — view and manage dashboard alerts.
import { readAlerts, clearAlerts } from "../dashboard/alerts.js";
import { isTTY } from "../output.js";

export async function alerts(args: string[]): Promise<void> {
  if (args[0] === "clear") {
    clearAlerts();
    console.log("Alerts cleared.");
    return;
  }

  const store = readAlerts();
  if (store.alerts.length === 0) {
    console.log("No alerts.");
    return;
  }

  if (!isTTY) {
    for (const alert of store.alerts) {
      console.log(JSON.stringify(alert));
    }
    return;
  }

  for (const alert of store.alerts) {
    const icon = alert.level === "error" ? "!" : "?";
    const ts = alert.ts.replace("T", " ").slice(0, 19);
    const worker = alert.worker ? ` (${alert.worker})` : "";
    console.log(`  ${icon} [${ts}] ${alert.project}${worker}: ${alert.message}`);
  }
}
