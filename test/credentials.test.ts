import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileCredential } from "../src/dashboard/credentials.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cred-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCredFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

const validPayload = JSON.stringify({
  claudeAiOauth: {
    accessToken: "tok_abc123def456ghi789jkl012mno345pqr678",
    refreshToken: "rt_xyz",
    expiresAt: Date.now() + 3_600_000,
    subscriptionType: "max_5x",
  },
});

describe("readFileCredential", () => {
  it("returns null for non-existent file", () => {
    expect(readFileCredential(path.join(tmpDir, "nope.json"))).toBeNull();
  });

  it("parses a valid credentials file", () => {
    const p = writeCredFile("cred.json", validPayload);
    const slot = readFileCredential(p);
    expect(slot).not.toBeNull();
    expect(slot!.source).toBe("file");
    expect(slot!.oauth.accessToken).toMatch(/^tok_/);
    expect(slot!.oauth.subscriptionType).toBe("max_5x");
  });

  it("returns null for malformed JSON", () => {
    const p = writeCredFile("bad.json", "not json at all");
    expect(readFileCredential(p)).toBeNull();
  });

  it("returns null when claudeAiOauth is missing", () => {
    const p = writeCredFile("no-oauth.json", JSON.stringify({ other: true }));
    expect(readFileCredential(p)).toBeNull();
  });

  it("returns null when accessToken is empty", () => {
    const p = writeCredFile("empty-tok.json", JSON.stringify({
      claudeAiOauth: { accessToken: "" },
    }));
    expect(readFileCredential(p)).toBeNull();
  });

  it("returns null when accessToken is not a string", () => {
    const p = writeCredFile("bad-tok.json", JSON.stringify({
      claudeAiOauth: { accessToken: 12345 },
    }));
    expect(readFileCredential(p)).toBeNull();
  });
});
