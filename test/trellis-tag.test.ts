import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

// Dynamic imports per-test so config.ts's module-init HOME capture sees
// the useTmpHome-set HOME at call time, not the original (vitest's
// useTmpHome calls vi.resetModules in afterEach).
async function importTrellisTag() {
  return await import("../src/dashboard/trellis-tag.js");
}
async function importConfig() {
  return await import("../src/config.js");
}

const env = useTmpHome();

async function writeConfig(projects: Record<string, { path: string; trellisDir?: string; checks?: string }>): Promise<void> {
  const cfg = await importConfig();
  fs.mkdirSync(cfg.GARDEN_DIR, { recursive: true });
  cfg.saveConfig({ projects });
}

function makeTrellis(dir: string, name: string, options: { tag?: string; retired?: string; sentinel?: boolean; intent?: string; firstPara?: string } = {}): string {
  const tag = options.tag ?? "<!-- trellis: v1 -->";
  const sentinel = options.sentinel === false ? "" : "the code is wrong";
  const retired = options.retired ? `\n${options.retired}\n` : "";
  const intent = options.intent ? `\n## Intent\n\n${options.intent}\n` : "";
  const firstPara = options.firstPara ?? "Default first paragraph.";
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, `# ${name}

${firstPara} ${sentinel}.

${tag}${retired}
${intent}
`);
  return file;
}

describe("TRELLIS_TAG_REGEX", () => {
  it("matches v1, v2, etc.", async () => {
    const { TRELLIS_TAG_REGEX } = await importTrellisTag();
    expect(TRELLIS_TAG_REGEX.test("<!-- trellis: v1 -->")).toBe(true);
    expect(TRELLIS_TAG_REGEX.test("<!--trellis:v2-->")).toBe(true);
    expect(TRELLIS_TAG_REGEX.test("<!--   trellis:   v10   -->")).toBe(true);
  });

  it("rejects missing version", async () => {
    const { TRELLIS_TAG_REGEX } = await importTrellisTag();
    expect(TRELLIS_TAG_REGEX.test("<!-- trellis -->")).toBe(false);
    expect(TRELLIS_TAG_REGEX.test("<!-- trellis: -->")).toBe(false);
  });

  it("captures the version number", async () => {
    const { TRELLIS_TAG_REGEX } = await importTrellisTag();
    const m = "<!-- trellis: v3 -->".match(TRELLIS_TAG_REGEX);
    expect(m?.[1]).toBe("3");
  });
});

describe("TRELLIS_RETIREMENT_REGEX", () => {
  it("matches a retirement comment with date", async () => {
    const { TRELLIS_RETIREMENT_REGEX } = await importTrellisTag();
    expect(TRELLIS_RETIREMENT_REGEX.test("<!-- retired: 2026-05-05 — implementation in commits abc..def -->")).toBe(true);
    expect(TRELLIS_RETIREMENT_REGEX.test("<!--retired: 2026-05-05-->")).toBe(true);
  });

  it("rejects missing date", async () => {
    const { TRELLIS_RETIREMENT_REGEX } = await importTrellisTag();
    expect(TRELLIS_RETIREMENT_REGEX.test("<!-- retired: yes -->")).toBe(false);
  });
});

describe("readTrellisFile", () => {
  it("returns null when no trellis tag in header", async () => {
    const { readTrellisFile } = await importTrellisTag();
    const file = path.join(env.home, "no-tag.md");
    fs.writeFileSync(file, "# something\n\nNo tag here. the code is wrong.");
    expect(readTrellisFile(file)).toBeNull();
  });

  it("returns null when file doesn't exist", async () => {
    const { readTrellisFile } = await importTrellisTag();
    expect(readTrellisFile(path.join(env.home, "missing.md"))).toBeNull();
  });

  it("parses an active trellis with sentinel and tag", async () => {
    const { readTrellisFile } = await importTrellisTag();
    const file = makeTrellis(env.home, "auth-rewrite");
    const info = readTrellisFile(file);
    expect(info).not.toBeNull();
    expect(info?.name).toBe("auth-rewrite");
    expect(info?.retired).toBe(false);
    expect(info?.hasSentinel).toBe(true);
    expect(info?.version).toBe(1);
  });

  it("flags missing sentinel", async () => {
    const { readTrellisFile } = await importTrellisTag();
    const file = makeTrellis(env.home, "no-sentinel", { sentinel: false });
    const info = readTrellisFile(file);
    expect(info?.hasSentinel).toBe(false);
  });

  it("flags retired trellises", async () => {
    const { readTrellisFile } = await importTrellisTag();
    const file = makeTrellis(env.home, "old-feature", {
      retired: "<!-- retired: 2026-04-01 -->",
    });
    const info = readTrellisFile(file);
    expect(info?.retired).toBe(true);
  });

  it("resolves summary from Intent heading when present", async () => {
    const { readTrellisFile } = await importTrellisTag();
    const file = makeTrellis(env.home, "with-intent", {
      intent: "Make the auth flow stateless.",
    });
    const info = readTrellisFile(file);
    expect(info?.summary).toBe("Make the auth flow stateless.");
  });

  it("falls back to first prose paragraph when no Intent heading", async () => {
    const { readTrellisFile } = await importTrellisTag();
    const file = makeTrellis(env.home, "no-intent", {
      firstPara: "First sentence here",
    });
    const info = readTrellisFile(file);
    expect(info?.summary).toContain("First sentence here");
  });
});

describe("findTrellisFiles", () => {
  it("returns empty when project has no trellisDir", async () => {
    const { findTrellisFiles } = await importTrellisTag();
    await writeConfig({ proj: { path: env.home } });
    expect(findTrellisFiles("proj")).toEqual([]);
  });

  it("lists trellises sorted active-first then alpha", async () => {
    const { findTrellisFiles } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } });
    makeTrellis(trellisDir, "zoo");
    makeTrellis(trellisDir, "apple");
    makeTrellis(trellisDir, "banana", { retired: "<!-- retired: 2026-04-01 -->" });
    const list = findTrellisFiles("proj");
    expect(list.map(t => t.name)).toEqual(["apple", "zoo", "banana"]);
    expect(list[2].retired).toBe(true);
  });

  it("ignores files without a trellis tag", async () => {
    const { findTrellisFiles } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } });
    fs.mkdirSync(trellisDir, { recursive: true });
    fs.writeFileSync(path.join(trellisDir, "README.md"), "# README\n\nNo tag.");
    makeTrellis(trellisDir, "real");
    const list = findTrellisFiles("proj");
    expect(list.map(t => t.name)).toEqual(["real"]);
  });
});

describe("findTrellisByName", () => {
  it("returns the trellis info when present", async () => {
    const { findTrellisByName } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } });
    makeTrellis(trellisDir, "auth");
    expect(findTrellisByName("proj", "auth")?.name).toBe("auth");
    expect(findTrellisByName("proj", "auth.md")?.name).toBe("auth");
  });

  it("returns null for unknown name", async () => {
    const { findTrellisByName } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    await writeConfig({ proj: { path: projDir } });
    expect(findTrellisByName("proj", "nonexistent")).toBeNull();
  });
});

describe("validateTrellisPlant", () => {
  it("refuses unknown project", async () => {
    const { validateTrellisPlant } = await importTrellisTag();
    await writeConfig({});
    const r = validateTrellisPlant("nope", "any");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown project");
  });

  it("refuses missing trellis with helpful suggestion", async () => {
    const { validateTrellisPlant } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } });
    makeTrellis(trellisDir, "alpha");
    const r = validateTrellisPlant("proj", "missing");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("not found");
      expect(r.error).toContain("alpha");
    }
  });

  it("refuses retired trellis with revive hint", async () => {
    const { validateTrellisPlant } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } });
    makeTrellis(trellisDir, "old", { retired: "<!-- retired: 2026-04-01 -->" });
    const r = validateTrellisPlant("proj", "old");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("retired");
  });

  it("warns on missing sentinel but proceeds", async () => {
    const { validateTrellisPlant } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } });
    makeTrellis(trellisDir, "loose", { sentinel: false });
    const r = validateTrellisPlant("proj", "loose");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some(w => w.includes("spec sentinel"))).toBe(true);
    }
  });

  it("warns on missing checks config but proceeds", async () => {
    const { validateTrellisPlant } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir } }); // no checks
    makeTrellis(trellisDir, "ok");
    const r = validateTrellisPlant("proj", "ok");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some(w => w.includes("checks"))).toBe(true);
    }
  });

  it("returns ok with no warnings when checks set and sentinel present", async () => {
    const { validateTrellisPlant } = await importTrellisTag();
    const projDir = path.join(env.home, "proj");
    const trellisDir = path.join(projDir, ".garden", "trellises");
    await writeConfig({ proj: { path: projDir, checks: "npm test" } });
    makeTrellis(trellisDir, "happy");
    const r = validateTrellisPlant("proj", "happy");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });
});
