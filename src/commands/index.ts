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
import { diary } from "./diary.js";
import { config } from "./config.js";
import { focus, unfocus } from "./focus.js";
import { reorder } from "./reorder.js";
import { plot } from "./plot.js";
import { kick } from "./kick.js";
import { bounce } from "./bounce.js";
import { hold } from "./hold.js";
import { pause } from "./pause.js";
import { resume } from "./resume.js";
import { claudeProfile } from "./claude-profile.js";
import { provider } from "./provider.js";
import { login } from "./login.js";
import { auth } from "./auth.js";
import { usage } from "./usage.js";
import { auto } from "./auto.js";
import { whoami } from "./whoami.js";
import { review } from "./review.js";
import { queue } from "./queue.js";
import { stats } from "./stats.js";
import { doctor } from "./doctor.js";
import { handoff } from "./handoff.js";
import { reply } from "./reply.js";
import { workers } from "./workers.js";
import { trellis } from "./trellis.js";
import { diag } from "./diag.js";
import { checks } from "./checks.js";

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
  diary,
  kick,
  bounce,
  hold,
  pause,
  resume,
  "claude-profile": claudeProfile,
  provider,
  login,
  auth,
  usage,
  auto,
  "auto-continue": auto,
  whoami,
  review,
  queue,
  stats,
  doctor,
  handoff,
  reply,
  workers,
  trellis,
  diag,
  checks,
};
