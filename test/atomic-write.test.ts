import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTmpHome } from "./helpers.js";

const env = useTmpHome();

async function importHelper() {
  return await import("../src/dashboard/atomic-write.js");
}

describe("atomicWriteFile", () => {
  it("writes content to the destination", async () => {
    const { atomicWriteFile } = await importHelper();
    const dest = path.join(env.sessionsDir, "test.txt");
    atomicWriteFile(dest, "hello");
    expect(fs.readFileSync(dest, "utf-8")).toBe("hello");
  });

  it("creates parent directories that do not yet exist", async () => {
    const { atomicWriteFile } = await importHelper();
    const dest = path.join(env.sessionsDir, "deep", "nested", "file.txt");
    atomicWriteFile(dest, "x");
    expect(fs.readFileSync(dest, "utf-8")).toBe("x");
  });

  it("respects the mode option", async () => {
    const { atomicWriteFile } = await importHelper();
    const dest = path.join(env.sessionsDir, "mode.txt");
    atomicWriteFile(dest, "secret", { mode: 0o600 });
    const stat = fs.statSync(dest);
    // Check perms — strip out file-type bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("writes a read-only-mode (0o444) file despite the durability fsync being unable to reopen it", async () => {
    // installRuntimeConfig writes worker settings.json at mode 0o444, so the
    // post-write durability fsync reopens the tmp file with "r+" and hits
    // EACCES on a non-owner-writable file. That failure must be swallowed and
    // the rename must still complete — otherwise every worker settings.json
    // rewrite would throw on SessionStart/resume/bounce. Assert the observable
    // end state (file written, mode preserved, no tmp leftover) so the test
    // holds whether the fsync reopen throws (non-root) or succeeds (root).
    const { atomicWriteFile } = await importHelper();
    const dest = path.join(env.sessionsDir, "readonly.json");
    atomicWriteFile(dest, "{}", { mode: 0o444 });
    expect(fs.readFileSync(dest, "utf-8")).toBe("{}");
    expect(fs.statSync(dest).mode & 0o777).toBe(0o444);
    const siblings = fs.readdirSync(env.sessionsDir);
    expect(siblings.filter(f => f.startsWith("readonly.json.") && f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("overwrites an existing file atomically", async () => {
    const { atomicWriteFile } = await importHelper();
    const dest = path.join(env.sessionsDir, "overwrite.txt");
    fs.writeFileSync(dest, "old contents");
    atomicWriteFile(dest, "new contents");
    expect(fs.readFileSync(dest, "utf-8")).toBe("new contents");
  });

  it("leaves no temp file on success", async () => {
    const { atomicWriteFile } = await importHelper();
    const dest = path.join(env.sessionsDir, "tmp-cleanup.txt");
    atomicWriteFile(dest, "x");
    const siblings = fs.readdirSync(env.sessionsDir);
    expect(siblings.filter(f => f.startsWith("tmp-cleanup.txt") && f.endsWith(".tmp"))).toHaveLength(0);
  });

  it("uses a UUID in the temp filename so two writers in the same ms cannot collide", async () => {
    const { atomicWriteFile } = await importHelper();
    // Drive two writes back-to-back and snapshot the directory between them
    // for any leftover .tmp siblings. With pid+Date.now() naming, two writes
    // within the same millisecond produced identical tmp names; here we
    // assert no collision by checking each write succeeds with no leftover.
    const dest = path.join(env.sessionsDir, "collision.txt");
    atomicWriteFile(dest, "first");
    atomicWriteFile(dest, "second");
    expect(fs.readFileSync(dest, "utf-8")).toBe("second");
    const siblings = fs.readdirSync(env.sessionsDir);
    expect(siblings.filter(f => f.startsWith("collision.txt") && f.endsWith(".tmp"))).toHaveLength(0);
    // Spot-check the tmp filename shape: <dest>.<uuid>.tmp where uuid uses
    // hex+hyphens. Test by intercepting one write through fs.writeFileSync
    // directly rather than reproducing the rename race.
    const dest2 = path.join(env.sessionsDir, "shape.txt");
    let observedTmpPath = "";
    const realWrite = fs.writeFileSync;
    (fs.writeFileSync as unknown as (p: string, c: string) => void) =
      ((p: string, c: string) => { observedTmpPath = p; return realWrite(p, c); });
    try {
      atomicWriteFile(dest2, "x");
    } finally {
      (fs.writeFileSync as unknown) = realWrite;
    }
    expect(observedTmpPath).toMatch(/\.[0-9a-f-]{36}\.tmp$/);
  });

  it("fsyncs by default for durability", async () => {
    const { atomicWriteFile } = await importHelper();
    const spy = vi.spyOn(fs, "fsyncSync");
    try {
      const dest = path.join(env.sessionsDir, "durable.txt");
      atomicWriteFile(dest, "state");
      expect(fs.readFileSync(dest, "utf-8")).toBe("state");
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("skips the fsync when durable is false but still writes atomically", async () => {
    const { atomicWriteFile } = await importHelper();
    const spy = vi.spyOn(fs, "fsyncSync");
    try {
      const dest = path.join(env.sessionsDir, "render.cache");
      atomicWriteFile(dest, "repaint", { durable: false });
      expect(fs.readFileSync(dest, "utf-8")).toBe("repaint");
      expect(spy).not.toHaveBeenCalled();
      const siblings = fs.readdirSync(env.sessionsDir);
      expect(siblings.filter(f => f.startsWith("render.cache.") && f.endsWith(".tmp"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("removes the temp file when the rename fails", async () => {
    const { atomicWriteFile } = await importHelper();
    // Force renameSync to fail by making the destination an unwritable directory of the same name.
    const dest = path.join(env.sessionsDir, "blocked");
    fs.mkdirSync(dest, { recursive: true });
    // Putting a file inside the directory so renameSync rejects the rename onto the dir.
    fs.writeFileSync(path.join(dest, "child"), "x");
    expect(() => {
      // Renaming a file onto a non-empty directory throws ENOTEMPTY/EISDIR depending on platform.
      // The helper must catch and clean the tmp file before re-throwing.
      const helper = (atomicWriteFile as unknown as (p: string, c: string) => void);
      helper(dest, "should fail");
    }).toThrow();
    const siblings = fs.readdirSync(env.sessionsDir);
    expect(siblings.filter(f => f.startsWith("blocked.") && f.endsWith(".tmp"))).toHaveLength(0);
  });
});
