import { describe, it, expect, vi } from "vitest";

vi.mock("../src/dashboard/registry.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/registry.js")>()),
  updateWorkerFields: vi.fn(),
}));
vi.mock("../src/dashboard/alerts.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/alerts.js")>()),
  addAlert: vi.fn(),
}));
vi.mock("../src/dashboard/log.js", async (orig) => ({
  ...(await orig<typeof import("../src/dashboard/log.js")>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { dashboard } from "../src/dashboard/index.js";
import { updateWorkerFields } from "../src/dashboard/registry.js";
import { addAlert } from "../src/dashboard/alerts.js";
import { log } from "../src/dashboard/log.js";

describe("dashboard _bootstrap-rebase", () => {
  // The bootstrap's fallback base is origin's default branch as ls-remote
  // reported it, a name the spawn-time check never saw.
  it("refuses a base name git would misread, leaving the worker's base alone", async () => {
    await dashboard(["_bootstrap-rebase", "alpha", "bold-ash", "--upload-pack=x", "gone"]);
    expect(updateWorkerFields).not.toHaveBeenCalled();
    expect(addAlert).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("bootstrap", "rebase: refused invalid base name", expect.anything());
  });

  it("records a valid fallback base on the worker", async () => {
    await dashboard(["_bootstrap-rebase", "alpha", "bold-ash", "main", "gone"]);
    expect(updateWorkerFields).toHaveBeenCalledWith("alpha", "bold-ash", { baseBranch: "main" });
  });
});
