// Command registry: maps command names to their handler functions.
import { init } from "./init.js";
import { add } from "./add.js";
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
import { order } from "./order.js";
import { kick } from "./kick.js";
import { bounce } from "./bounce.js";
import { rules } from "./rules.js";
import { claudeProfile } from "./claude-profile.js";
import { login } from "./login.js";
import { auth } from "./auth.js";

type Command = (args: string[]) => Promise<void>;

export const commands: Record<string, Command> = {
  init,
  add,
  remove,
  list,
  config,
  focus,
  unfocus,
  order,
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
  rules,
  "claude-profile": claudeProfile,
  login,
  auth,
};
