// Command registry: maps command names to their handler functions.
import { init } from "./init.js";
import { register } from "./add.js";
import { unregister } from "./remove.js";
import { list } from "./list.js";
import { status } from "./status.js";
import { dashboard } from "./dashboard.js";
import { keys } from "./keys.js";
import { rebuild } from "./rebuild.js";

type Command = (args: string[]) => Promise<void>;

export const commands: Record<string, Command> = {
  init,
  register,
  unregister,
  list,
  status,
  dashboard,
  keys,
  rebuild,
};
