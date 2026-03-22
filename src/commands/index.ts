import { init } from "./init.js";
import { add } from "./add.js";
import { remove } from "./remove.js";
import { list } from "./list.js";
import { tasks } from "./tasks.js";
import { start } from "./start.js";
import { stop } from "./stop.js";
import { status } from "./status.js";
import { attach } from "./attach.js";
import { next } from "./next.js";
import { pause } from "./pause.js";
import { log } from "./log.js";
import { context } from "./context.js";
import { events } from "./events.js";

type Command = (args: string[]) => Promise<void>;

export const commands: Record<string, Command> = {
  init,
  add,
  remove,
  list,
  tasks,
  start,
  stop,
  status,
  attach,
  next,
  pause,
  log,
  context,
  events,
};
