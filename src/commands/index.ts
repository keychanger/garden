// Command registry: maps command names to their handler functions.
import { init } from "./init.js";
import { add } from "./add.js";
import { create } from "./create.js";
import { remove } from "./remove.js";
import { list } from "./list.js";
import { status } from "./status.js";
import { dashboard } from "./dashboard.js";
import { keys } from "./keys.js";
import { rebuild } from "./rebuild.js";
import { reset } from "./reset.js";
import { health } from "./health.js";
import { test } from "./test.js";
import { alerts } from "./alerts.js";
import { logs } from "./logs.js";
import { config } from "./config.js";
import { focus, unfocus } from "./focus.js";
import { reorder } from "./reorder.js";
import { plot } from "./plot.js";
import { kick } from "./kick.js";
import { bounce } from "./bounce.js";
import { pause } from "./pause.js";
import { resume } from "./resume.js";
import { claudeProfile } from "./claude-profile.js";
import { login } from "./login.js";
import { auth } from "./auth.js";
import { usage } from "./usage.js";
import { auto } from "./auto.js";
import { whoami } from "./whoami.js";
import { handoff } from "./handoff.js";
import { workers } from "./workers.js";
import { trellis } from "./trellis.js";

type Command = (args: string[]) => Promise<void>;

export const commands: Record<string, Command> = {
  init,
  add,
  create,
  remove,
  list,
  config,
  focus,
  unfocus,
  reorder,
  plot,
  status,
  dashboard,
  keys,
  rebuild,
  reset,
  health,
  test,
  alerts,
  logs,
  kick,
  bounce,
  pause,
  resume,
  "claude-profile": claudeProfile,
  login,
  auth,
  usage,
  auto,
  "auto-continue": auto,
  whoami,
  handoff,
  workers,
  trellis,
};
