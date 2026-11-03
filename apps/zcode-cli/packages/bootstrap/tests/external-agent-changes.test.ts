import { describe, expect, it } from "vitest";
import {
  parseNumstat,
  parsePorcelainStatus,
} from "../src/zcode-protocol/external-agent-changes-parse.js";

describe("git 变更解析", () => {
  it("porcelain：取路径、去重、重命名取新名", () => {
    const text = [" M src/a.ts", "?? src/new.ts", "R  old.ts -> src/b.ts", " M src/a.ts"].join("\n");
    expect(parsePorcelainStatus(text)).toEqual(["src/a.ts", "src/new.ts", "src/b.ts"]);
  });

  it("porcelain：畸形行与空输入不抛", () => {
    expect(parsePorcelainStatus("")).toEqual([]);
    expect(parsePorcelainStatus("??\n M \n")).toEqual([]);
  });

  it("numstat：解析增删行数，二进制按 0", () => {
    const map = parseNumstat(["12\t3\tsrc/a.ts", "-\t-\timage.png"].join("\n"));
    expect(map.get("src/a.ts")).toEqual({ added: 12, deleted: 3 });
    expect(map.get("image.png")).toEqual({ added: 0, deleted: 0 });
  });
});
