import { describe, it, expect } from "vitest";
import {
  assertBranchName, assertRevision, isCommitSha, isSafeRevision, isValidBranchName,
} from "../src/dashboard/git-refs.js";

describe("isValidBranchName", () => {
  it("accepts the branch names git accepts", () => {
    for (const name of ["main", "develop", "hardening", "feature/x", "release/2026-04", "v1.2", "a-b_c"]) {
      expect(isValidBranchName(name), name).toBe(true);
    }
  });

  it("rejects names git would read as an option", () => {
    // A forged registry base reaches `git fetch origin <base>`.
    expect(isValidBranchName("--upload-pack=touch /tmp/x")).toBe(false);
    expect(isValidBranchName("-x")).toBe(false);
  });

  it("rejects what git check-ref-format rejects", () => {
    for (const name of [
      "", "@", "HEAD", "a b", "a\tb", "a~1", "a^", "a:b", "a?", "a*", "a[", "a\\b", "a\x7f",
      "a..b", "a@{1}", "a//b", "/a", "a/", "a.", "a.lock", "a/.b", "a/b.lock",
    ]) {
      expect(isValidBranchName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("isCommitSha", () => {
  it("accepts full and abbreviated object names", () => {
    expect(isCommitSha("e3e121c")).toBe(true);
    expect(isCommitSha("e3e121c021664bee72c5f571160b4ac3d62005b9")).toBe(true);
  });

  it("rejects anything else, including an option-shaped forgery", () => {
    for (const value of ["", "e3e121", "E3E121C", "HEAD", "origin/main", "--output=/tmp/x", "e3e121c..HEAD"]) {
      expect(isCommitSha(value), value).toBe(false);
    }
  });
});

describe("isSafeRevision", () => {
  it("accepts an object name, HEAD, or a full ref", () => {
    for (const rev of ["e3e121c", "HEAD", "refs/remotes/origin/main", "refs/heads/release/2026-04"]) {
      expect(isSafeRevision(rev), rev).toBe(true);
    }
  });

  it("rejects abbreviated refs, which a same-named tag can shadow, and options", () => {
    for (const rev of ["origin/main", "main", "HEAD~1", "--output=/tmp/x", "refs/heads/a..b"]) {
      expect(isSafeRevision(rev), rev).toBe(false);
    }
  });
});

describe("assertions", () => {
  it("return the value they accept and name the value they refuse", () => {
    expect(assertBranchName("main")).toBe("main");
    expect(assertRevision("HEAD")).toBe("HEAD");
    expect(() => assertBranchName("--x")).toThrow(/"--x"/);
    expect(() => assertRevision("--output=/tmp/x")).toThrow(/"--output=\/tmp\/x"/);
  });
});
