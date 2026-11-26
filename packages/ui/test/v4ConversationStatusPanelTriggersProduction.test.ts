import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const source = readFileSync(resolve("packages/ui/src/v4/ConversationStatusPanel.tsx"), "utf8");

it("uses the capsule button as the Radix popover trigger", () => {
  expect(source).toMatch(/<PopoverTrigger asChild>\s*<Button/);
});

it("routes the Composer activity request to the activity capsule", () => {
  expect(source).toMatch(/activityOpenRequest/);
  expect(source).toMatch(/openCapsule\?\.\("activity"\)/);
});
