import { describe, expect, it } from "vitest";
import {
  createPackagedExtraMetadata,
  createPackagedPackageJson,
} from "../scripts/packaging-app-metadata.mjs";

describe("packaged app metadata", () => {
  const buildMetadata = { appVersion: "3.16.2", minCompatibleVersion: "3.16.2" };
  const identity = { flavor: "preview", productName: "ZCode Preview" };

  it("注入源 package.json 里没有的 version", () => {
    const packaged = createPackagedPackageJson(
      { name: "@zcode/desktop", main: "out/main/index.js" },
      { buildMetadata, identity },
    );

    // 桌面端源 package.json 不带 version；缺失时 app.getVersion() 会退化到 exe 的
    // 四段文件版本，electron-updater 直接抛 "not a valid semver version"。
    expect(packaged.version).toBe("3.16.2");
    expect(packaged.zcodeProductFlavor).toBe("preview");
    expect(packaged.name).toBe("@zcode/desktop");
    expect(packaged.main).toBe("out/main/index.js");
  });

  it("extraMetadata 只包含打包期覆盖字段", () => {
    expect(createPackagedExtraMetadata({ buildMetadata, identity })).toEqual({
      version: "3.16.2",
      zcodeProductFlavor: "preview",
      homepage: "https://zcode.z.ai",
      author: { name: "ZCode", email: "dev@zcode.z.ai" },
    });
  });
});
