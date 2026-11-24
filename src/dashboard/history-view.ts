// The ⌥h history pane's viewer (`garden dashboard _history-view`). It holds the
// conversation's opening ask fixed at the top of the pane and scrolls the
// exchanges beneath it with the wheel and keys.
//
// It replaced a shell repaint loop that printed the opening ask over the newest
// lines and left the rest in tmux scrollback. That kept the ask on screen only
// until the operator scrolled — and scrolling is exactly when they want it. A
// fixed header needs whoever does the scrolling to leave those rows alone, and
// tmux scrollback can't: a terminal scroll region would, but tmux drops lines
// scrolled out of a partial region instead of saving them. So the viewer owns
// scrolling itself, on the alternate screen, with mouse tracking on so tmux
// forwards the wheel (the WheelUpPane binding in hotkeys.ts sends it to a pane
// with alternate_on and mouse_any_flag).
//
// garden bakes history.rendered (writeHistoryRendered, header.ts) and signals
// the pane with SIGWINCH; the viewer reloads it in place. Not SIGUSR1 like the
// other repaint panes: until a JS listener is installed, Node answers SIGUSR1
// by opening its inspector on 127.0.0.1:9229, and the first bake after the
// pane is created routinely lands while the viewer is still starting. SIGWINCH
// is ignored by default, so an early one is simply dropped (the viewer reads
// the file when it starts anyway). A reload keeps the
// operator's scroll position unless they were at the bottom, in which case it
// follows the newest lines — a refresh fires on most of the focused worker's
// tool calls, so restarting a pager per refresh would yank them back down
// mid-read. A changed opening ask means focus moved to another worker, and
// the view starts over at that conversation's newest lines.
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "../config.js";

export const HISTORY_RENDERED_FILE = path.join(SESSIONS_DIR, "history.rendered");

// history.rendered is the opening-ask block, a line holding only this record
// separator, then the conversation.
export const HISTORY_PIN_SEPARATOR = "\x1e";

export interface HistoryDoc {
  pin: string[];
  body: string[];
}

export interface ViewPos {
  top: number;
  follow: boolean;
}

export type ScrollAction =
  | { by: number; unit: "line" | "page" }
  | "top"
  | "bottom";

export function parseHistoryDoc(text: string): HistoryDoc {
  const lines = text.split("\n");
  const sep = lines.indexOf(HISTORY_PIN_SEPARATOR);
  if (sep < 0) return { pin: [], body: lines };
  return { pin: lines.slice(0, sep), body: lines.slice(sep + 1) };
}

// The header is capped so a very long opening prompt can't crowd out the
// conversation; past the cap it shows its head, a pointer to the full text,
// and its closing rule.
export function headerLines(pin: string[], rows: number): string[] {
  const cap = Math.max(4, Math.floor(rows * 0.6));
  if (pin.length <= cap) return pin;
  const more = pin.length - cap + 1;
  return [
    ...pin.slice(0, cap - 2),
    `\x1b[2m … ${more} more lines · ⌥i h for the full prompt\x1b[0m`,
    pin[pin.length - 1],
  ];
}

function bodyRows(doc: HistoryDoc, rows: number): number {
  return Math.max(1, rows - headerLines(doc.pin, rows).length);
}

export function settle(pos: ViewPos, doc: HistoryDoc, rows: number): ViewPos {
  const maxTop = Math.max(0, doc.body.length - bodyRows(doc, rows));
  if (pos.follow) return { top: maxTop, follow: true };
  const top = Math.min(Math.max(0, pos.top), maxTop);
  return { top, follow: top >= maxTop };
}

export function scroll(pos: ViewPos, action: ScrollAction, doc: HistoryDoc, rows: number): ViewPos {
  if (action === "bottom") return settle({ top: 0, follow: true }, doc, rows);
  if (action === "top") return settle({ top: 0, follow: false }, doc, rows);
  const current = settle(pos, doc, rows);
  const step = action.unit === "page"
    ? Math.max(1, Math.round(bodyRows(doc, rows) * Math.abs(action.by))) * Math.sign(action.by)
    : action.by;
  return settle({ top: current.top + step, follow: false }, doc, rows);
}

// The screen's rows, top to bottom. When the operator has scrolled up, the
// last row says how much is below, since nothing else shows that new lines are
// arriving out of sight.
export function frameLines(doc: HistoryDoc, pos: ViewPos, rows: number): string[] {
  const header = headerLines(doc.pin, rows);
  const room = bodyRows(doc, rows);
  const visible = doc.body.slice(pos.top, pos.top + room);
  const below = doc.body.length - (pos.top + room);
  if (below > 0 && visible.length > 0) {
    visible[visible.length - 1] = `\x1b[2m ↓ ${below + 1} more lines below · G or scroll down for the newest\x1b[0m`;
  }
  return [...header, ...visible].slice(0, rows);
}

const MOUSE_SGR = /^\x1b\[<(\d+);\d+;\d+[Mm]/;
const OTHER_ESCAPE = /^\x1b(\[[0-?]*[ -/]*[@-~]|O.)/;
const KEY_SEQUENCES: [string, ScrollAction][] = [
  ["\x1b[A", { by: -1, unit: "line" }],
  ["\x1bOA", { by: -1, unit: "line" }],
  ["\x1b[B", { by: 1, unit: "line" }],
  ["\x1bOB", { by: 1, unit: "line" }],
  ["\x1b[5~", { by: -1, unit: "page" }],
  ["\x1b[6~", { by: 1, unit: "page" }],
  ["\x1b[H", "top"],
  ["\x1bOH", "top"],
  ["\x1b[1~", "top"],
  ["\x1b[F", "bottom"],
  ["\x1bOF", "bottom"],
  ["\x1b[4~", "bottom"],
];
const KEY_CHARS: Record<string, ScrollAction> = {
  k: { by: -1, unit: "line" },
  j: { by: 1, unit: "line" },
  u: { by: -0.5, unit: "page" },
  d: { by: 0.5, unit: "page" },
  b: { by: -1, unit: "page" },
  " ": { by: 1, unit: "page" },
  f: { by: 1, unit: "page" },
  g: "top",
  G: "bottom",
};
const WHEEL_LINES = 3;

// Input arrives in raw chunks that can hold several keys or mouse reports.
// Anything unrecognized is skipped: the pane has nothing to type into.
export function parseInput(data: string): ScrollAction[] {
  const actions: ScrollAction[] = [];
  let i = 0;
  while (i < data.length) {
    const rest = data.slice(i);
    const mouse = MOUSE_SGR.exec(rest);
    if (mouse) {
      // Bits 2-4 are shift/meta/ctrl; 64 and 65 are wheel up and down.
      const button = parseInt(mouse[1], 10) & ~28;
      if (button === 64) actions.push({ by: -WHEEL_LINES, unit: "line" });
      if (button === 65) actions.push({ by: WHEEL_LINES, unit: "line" });
      i += mouse[0].length;
      continue;
    }
    const seq = KEY_SEQUENCES.find(([s]) => rest.startsWith(s));
    if (seq) {
      actions.push(seq[1]);
      i += seq[0].length;
      continue;
    }
    // A sequence we don't handle (a modified arrow, a focus report) is skipped
    // whole, so its trailing letter isn't read as a key.
    const other = OTHER_ESCAPE.exec(rest);
    if (other) {
      i += other[0].length;
      continue;
    }
    const key = KEY_CHARS[data[i]];
    if (key) actions.push(key);
    i += 1;
  }
  return actions;
}

function readDoc(): HistoryDoc {
  try {
    return parseHistoryDoc(fs.readFileSync(HISTORY_RENDERED_FILE, "utf-8"));
  } catch {
    return { pin: [], body: [] };
  }
}

// Alternate screen, hidden cursor, autowrap off (an over-wide line clips
// instead of wrapping and shifting every row below it), SGR mouse reports.
const ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h";
const LEAVE = "\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l";

export function runHistoryView(): void {
  const out = process.stdout;
  let doc = readDoc();
  let pos: ViewPos = { top: 0, follow: true };
  const rows = () => out.rows || 24;

  const paint = () => {
    try {
      pos = settle(pos, doc, rows());
      const lines = frameLines(doc, pos, rows()).map(l => `${l}\x1b[0m\x1b[K`);
      out.write(`\x1b[H${lines.join("\r\n")}\x1b[J`);
    } catch { /* stdout gone; the next signal retries */ }
  };

  const reload = () => {
    const next = readDoc();
    if (next.pin.join("\n") !== doc.pin.join("\n")) pos = { top: 0, follow: true };
    doc = next;
    paint();
  };

  const leave = () => {
    try { out.write(LEAVE); } catch { /* terminal gone */ }
    process.exit(0);
  };

  out.write(ENTER);
  // A real resize also arrives as SIGWINCH; reloading then is harmless.
  process.on("SIGWINCH", reload);
  process.on("SIGTERM", leave);
  process.on("SIGHUP", leave);
  out.on("resize", paint);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (data: string) => {
    for (const action of parseInput(data)) pos = scroll(pos, action, doc, rows());
    paint();
  });
  paint();
}
