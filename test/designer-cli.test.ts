import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/dashboard/registry.js", () => ({
  findWorkerByName: vi.fn(),
  readRegistry: vi.fn(() => ({ workers: {} })),
}));
vi.mock("../src/dashboard/designer-publish.js", () => ({
  DESIGNER_PUBLISH_ROOT: "docs/",
  publishDesignerArtifact: vi.fn(() => ({ ok: true, message: "published ok" })),
}));
vi.mock("../src/config.js", () => ({
  tryGetProject: vi.fn(),
}));

import { designer } from "../src/commands/designer.js";
import { findWorkerByName } from "../src/dashboard/registry.js";
import { publishDesignerArtifact } from "../src/dashboard/designer-publish.js";
import { tryGetProject } from "../src/config.js";

function seedDesigner() {
  vi.mocked(findWorkerByName).mockReturnValue({
    name: "bold-ash",
    workflow: "designer",
    worktreePath: "/tmp/wt/proj/bold-ash",
  } as ReturnType<typeof findWorkerByName>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tryGetProject).mockReturnValue(null);
  process.env.GARDEN_WORKER = "bold-ash";
  process.env.GARDEN_PROJECT = "proj";
});

describe("garden designer publish", () => {
  it("delegates to publishDesignerArtifact with the resolved worktree and --to path", async () => {
    seedDesigner();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await designer(["publish", "--to", "docs/future/design.md"]);
    expect(publishDesignerArtifact).toHaveBeenCalledWith(
      "/tmp/wt/proj/bold-ash",
      "docs/future/design.md",
      { dryRun: false, project: "proj" },
    );
    log.mockRestore();
  });

  it("threads --dry-run through", async () => {
    seedDesigner();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await designer(["publish", "--to", "docs/future/design.md", "--dry-run"]);
    expect(publishDesignerArtifact).toHaveBeenCalledWith(
      "/tmp/wt/proj/bold-ash",
      "docs/future/design.md",
      { dryRun: true, project: "proj" },
    );
  });

  it("threads the project's configured trellisDir into the publish guidance", async () => {
    seedDesigner();
    vi.mocked(tryGetProject).mockReturnValue({
      name: "proj",
      path: "/tmp/proj",
      trellisDir: "docs/trellises",
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await designer(["publish", "--to", "docs/future/design.md"]);

    expect(publishDesignerArtifact).toHaveBeenCalledWith(
      "/tmp/wt/proj/bold-ash",
      "docs/future/design.md",
      { dryRun: false, project: "proj", trellisDir: "docs/trellises" },
    );
  });

  it("requires --to", async () => {
    seedDesigner();
    await expect(designer(["publish"])).rejects.toThrow(/--to is required/);
    expect(publishDesignerArtifact).not.toHaveBeenCalled();
  });

  it("self-resolves the worker from $GARDEN_WORKER when no arg is given", async () => {
    seedDesigner();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await designer(["publish", "--to", "docs/x.md"]);
    expect(findWorkerByName).toHaveBeenCalledWith("proj", "bold-ash");
  });

  it("errors when GARDEN_WORKER is unset and no worker arg is given", async () => {
    delete process.env.GARDEN_WORKER;
    await expect(designer(["publish", "--to", "docs/x.md"])).rejects.toThrow(/GARDEN_WORKER not set/);
  });

  it("rejects a non-designer worker", async () => {
    vi.mocked(findWorkerByName).mockReturnValue({
      name: "bold-ash",
      workflow: "default",
      worktreePath: "/tmp/wt/proj/bold-ash",
    } as ReturnType<typeof findWorkerByName>);
    await expect(designer(["publish", "--to", "docs/x.md"])).rejects.toThrow(/is not a designer/);
    expect(publishDesignerArtifact).not.toHaveBeenCalled();
  });

  it("surfaces a publish failure as a thrown error", async () => {
    seedDesigner();
    vi.mocked(publishDesignerArtifact).mockReturnValue({ ok: false, message: "no artifact to publish" });
    await expect(designer(["publish", "--to", "docs/x.md"])).rejects.toThrow(/no artifact to publish/);
  });

  it("rejects an unknown subcommand", async () => {
    await expect(designer(["frobnicate"])).rejects.toThrow(/Usage/);
  });
});
