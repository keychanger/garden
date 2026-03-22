import { execFile } from "node:child_process";

export function notify(title: string, message: string): void {
  const script = `display notification "${escape(message)}" with title "${escape(title)}"`;
  execFile("osascript", ["-e", script], (err) => {
    // Fire and forget — don't crash if notification fails
    if (err && process.env.GARDEN_DEBUG) {
      console.error("Notification failed:", err.message);
    }
  });
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
