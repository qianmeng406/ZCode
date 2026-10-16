import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parseBoundaryArgs } from "../bench-wsl-boundary.mjs";

test("boundary requires explicit absolute workspace and output", () => {
  assert.throws(() => parseBoundaryArgs([]), /Require/);
  assert.throws(
    () => parseBoundaryArgs(["--workspace", "relative", "--output", resolve("result.json")]),
    /Require/,
  );
  assert.throws(() => parseBoundaryArgs(["--unknown", "value"]), /Expected/);
  assert.throws(() => parseBoundaryArgs(["--workspace"]), /Expected/);
});

test("boundary rejects invalid sample counts and empty distro", () => {
  const base = ["--workspace", "/home/agent/lab", "--output", resolve("result.json")];
  for (const value of ["0", "1.2", "NaN", "1001"]) {
    assert.throws(() => parseBoundaryArgs([...base, "--samples", value]), /Samples/);
  }
  assert.throws(() => parseBoundaryArgs([...base, "--distro", " "]), /Require/);
  assert.equal(parseBoundaryArgs([...base, "--samples", "30"]).samples, 30);
});
