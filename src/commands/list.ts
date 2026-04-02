// Lists all registered projects.
import { loadConfig } from "../config.js";
import { output } from "../output.js";

interface ProjectInfo {
  name: string;
  path: string;
  index: number;
  focused: boolean;
}

export async function list(): Promise<void> {
  const config = loadConfig();
  const names = Object.keys(config.projects);

  if (names.length === 0) {
    console.log("No projects added. Use 'garden add [path]' to add one.");
    return;
  }

  const projects: ProjectInfo[] = names.map((name, i) => ({
    name,
    path: config.projects[name].path,
    index: i + 1,
    focused: config.projects[name].focused !== false,
  }));

  output(projects, (data) => {
    const items = data as ProjectInfo[];
    return items
      .map((p) => {
        const suffix = p.focused ? "" : "  \x1b[2m(unfocused)\x1b[0m";
        return `  ${p.index}. ${p.name.padEnd(16)} ${p.path}${suffix}`;
      })
      .join("\n");
  });
}
