import fs from "node:fs";
import { CONFIG_PATH, GARDEN_DIR, SESSIONS_DIR, saveConfig, loadConfig } from "../config.js";
import { checkTmux } from "../session.js";

export async function init(): Promise<void> {
  checkTmux();

  if (fs.existsSync(CONFIG_PATH)) {
    const config = loadConfig();
    const count = Object.keys(config.projects).length;
    console.log(`Garden already initialized (${count} projects registered).`);
    return;
  }

  fs.mkdirSync(GARDEN_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  saveConfig({ projects: {} });
  console.log(`Initialized garden at ${GARDEN_DIR}`);
}
