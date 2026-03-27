// Lists all registered projects.
import { loadConfig } from "../config.js";
import { output } from "../output.js";

interface ProjectInfo {
  name: string;
  path: string;
  index: number;
}

export async function list(): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.projects);

  if (names.length === 0) {
    console.log("No projects registered. Use 'garden register <name> <path>' to add one.");
    return;
  }

  const projects: ProjectInfo[] = names.map((name, i) => ({
    name,
    path: config.projects[name].path,
    index: i + 1,
  }));

  output(projects, (data) => {
    const items = data as ProjectInfo[];
    return items
      .map((p) => `  ${p.index}. ${p.name.padEnd(16)} ${p.path}`)
      .join("\n");
  });
}
