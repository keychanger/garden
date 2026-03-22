const isTTY = process.stdout.isTTY ?? false;

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
