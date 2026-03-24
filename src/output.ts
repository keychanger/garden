// TTY-aware output helpers: pretty-prints for terminals, JSON for pipes.
// GARDEN_PRETTY=1 forces pretty output (used by dashboard status pane).
const isTTY = (process.stdout.isTTY ?? false) || process.env.GARDEN_PRETTY === "1";

export function output(data: unknown, pretty?: (data: unknown) => string): void {
  if (isTTY && pretty) {
    console.log(pretty(data));
  } else {
    console.log(JSON.stringify(data));
  }
}

export function outputLines(items: unknown[], pretty?: (item: unknown) => string): void {
  if (isTTY && pretty) {
    for (const item of items) {
      console.log(pretty(item));
    }
  } else {
    for (const item of items) {
      console.log(JSON.stringify(item));
    }
  }
}

export { isTTY };
