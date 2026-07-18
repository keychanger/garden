import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  readRegistry: vi.fn(() => ({ workers: {} })),
}));
vi.mock("../src/dashboard/botanist-publish.js", () => ({
  BOTANIST_PUBLISH_ROOT: "docs/",
  publishBotanistArtifact: vi.fn(() => ({ ok: true, message: "published ok" })),
}));

import { botanist } from "../src/commands/botanist.js";
import { findWorkerByName } from "../src/dashboard/registry.js";
import { publishBotanistArtifact } from "../src/dashboard/botanist-publish.js";

function seedBotanist() {
  vi.mocked(findWorkerByName).mockReturnValue({
    name: "bold-ash",
    workflow: "botanist",
    worktreePath: "/tmp/wt/proj/bold-ash",
  } as ReturnType<typeof findWorkerByName>);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GARDEN_WORKER = "bold-ash";
  process.env.GARDEN_PROJECT = "proj";
});

describe("garden botanist publish", () => {
  it("delegates to publishBotanistArtifact with the resolved worktree and --to path", async () => {
    seedBotanist();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await botanist(["publish", "--to", "docs/future/design.md"]);
    expect(publishBotanistArtifact).toHaveBeenCalledWith(
      "/tmp/wt/proj/bold-ash",
      "docs/future/design.md",
      { dryRun: false },
    );
    log.mockRestore();
  });

  it("threads --dry-run through", async () => {
    seedBotanist();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await botanist(["publish", "--to", "docs/future/design.md", "--dry-run"]);
    expect(publishBotanistArtifact).toHaveBeenCalledWith(
      "/tmp/wt/proj/bold-ash",
      "docs/future/design.md",
      { dryRun: true },
    );
  });

  it("requires --to", async () => {
    seedBotanist();
    await expect(botanist(["publish"])).rejects.toThrow(/--to is required/);
    expect(publishBotanistArtifact).not.toHaveBeenCalled();
  });

  it("self-resolves the worker from $GARDEN_WORKER when no arg is given", async () => {
    seedBotanist();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await botanist(["publish", "--to", "docs/x.md"]);
    expect(findWorkerByName).toHaveBeenCalledWith("proj", "bold-ash");
  });

  it("errors when GARDEN_WORKER is unset and no worker arg is given", async () => {
    delete process.env.GARDEN_WORKER;
    await expect(botanist(["publish", "--to", "docs/x.md"])).rejects.toThrow(/GARDEN_WORKER not set/);
  });

  it("rejects a non-botanist worker", async () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      workflow: "default",
      worktreePath: "/tmp/wt/proj/bold-ash",
    } as ReturnType<typeof findWorkerByName>);
    await expect(botanist(["publish", "--to", "docs/x.md"])).rejects.toThrow(/is not a botanist/);
    expect(publishBotanistArtifact).not.toHaveBeenCalled();
  });

  it("surfaces a publish failure as a thrown error", async () => {
    seedBotanist();
    vi.mocked(publishBotanistArtifact).mockReturnValue({ ok: false, message: "no artifact to publish" });
    await expect(botanist(["publish", "--to", "docs/x.md"])).rejects.toThrow(/no artifact to publish/);
  });

  it("rejects an unknown subcommand", async () => {
    await expect(botanist(["frobnicate"])).rejects.toThrow(/Usage/);
  });
});
