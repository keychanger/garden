// Command registry: maps command names to their handler functions.
import { init } from "./init.js";
import { register } from "./add.js";
import { unregister } from "./remove.js";
import { list } from "./list.js";
import { tasks } from "./tasks.js";
import { start } from "./start.js";
import { stop } from "./stop.js";
import { status } from "./status.js";

import { next } from "./next.js";
import { pause } from "./pause.js";
import { review } from "./log.js";
import { context } from "./context.js";
import { events } from "./events.js";
import { dashboard } from "./dashboard.js";

type Command = (args: string[]) => Promise<void>;

export const commands: Record<string, Command> = {
  init,
  register,
  unregister,
  list,
  tasks,
  start,
  stop,
  status,

  next,
  pause,
  review,
  context,
  events,
  dashboard,
};
