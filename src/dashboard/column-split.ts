import { getLeftColumnPercent } from "../config.js";
import { readDashState, writeDashState, withStateLock } from "./state.js";
import { log } from "./log.js";

export interface ColumnSplitResult {
  applied: boolean;
  leftPercent: number;
}

export async function reconcileColumnSplit(force = false): Promise<ColumnSplitResult> {
  const leftPercent = getLeftColumnPercent();
  const state = readDashState();
  if ((!force && state.appliedLeftPercent === leftPercent) || !state.activePaneId) {
    return { applied: false, leftPercent };
  }

  const { USAGE_PANE_HEIGHT, presizeHiddenWindows } = await import("./create.js");
  const { rebakePanesOnResize } = await import("./header.js");
  return withStateLock(() => {
    const fresh = readDashState();
    const currentLeftPercent = getLeftColumnPercent();
    if ((!force && fresh.appliedLeftPercent === currentLeftPercent) || !fresh.activePaneId) {
      return { applied: false, leftPercent: currentLeftPercent };
    }
    if (!rebakePanesOnResize(fresh, USAGE_PANE_HEIGHT, 100 - currentLeftPercent)) {
      return { applied: false, leftPercent: currentLeftPercent };
    }
    presizeHiddenWindows(fresh);
    fresh.appliedLeftPercent = currentLeftPercent;
    writeDashState(fresh);
    log.info("layout", "column split applied", { data: { leftPercent: currentLeftPercent } });
    return { applied: true, leftPercent: currentLeftPercent };
  });
}
