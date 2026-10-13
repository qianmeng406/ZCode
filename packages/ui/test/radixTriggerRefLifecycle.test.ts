// @vitest-environment jsdom

import { createElement, type Ref } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Slot } from "radix-ui";

afterEach(cleanup);

function trigger(ref: Ref<HTMLButtonElement>, childRef?: Ref<HTMLButtonElement>, label = "Menu") {
  return createElement(Slot.Root, { ref }, createElement("button", { ref: childRef }, label));
}

describe("Radix Slot ref lifecycle", () => {
  it("does not detach unchanged refs on a parent render", () => {
    const forwarded = vi.fn();
    const child = vi.fn();
    const view = render(trigger(forwarded, child));
    const button = view.getByRole("button");
    expect(forwarded.mock.calls).toEqual([[button]]);
    expect(child.mock.calls).toEqual([[button]]);
    view.rerender(trigger(forwarded, child, "Updated menu"));
    expect(forwarded.mock.calls).toEqual([[button]]);
    expect(child.mock.calls).toEqual([[button]]);
    view.unmount();
    expect(forwarded.mock.calls).toEqual([[button], [null]]);
    expect(child.mock.calls).toEqual([[button], [null]]);
  });

  it("preserves React 19 cleanup when refs are replaced and on unmount", () => {
    const cleanupFirst = vi.fn();
    const cleanupNext = vi.fn();
    const first = vi.fn(() => cleanupFirst);
    const next = vi.fn(() => cleanupNext);
    const child = { current: null as HTMLButtonElement | null };
    const view = render(trigger(first, child));
    const button = view.getByRole("button") as HTMLButtonElement;
    view.rerender(trigger(first, child, "Updated menu"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(cleanupFirst).not.toHaveBeenCalled();
    view.rerender(trigger(next, child));
    expect(cleanupFirst).toHaveBeenCalledTimes(1);
    expect(first.mock.calls).toEqual([[button]]);
    expect(next).toHaveBeenCalledWith(button);
    expect(child.current).toBe(button);
    view.unmount();
    expect(cleanupFirst).toHaveBeenCalledTimes(1);
    expect(cleanupNext).toHaveBeenCalledTimes(1);
    expect(child.current).toBeNull();
  });

  it("keeps hook order when the child becomes empty or a Fragment", () => {
    const ref = vi.fn();
    const view = render(trigger(ref));
    expect(() => view.rerender(createElement(Slot.Root, { ref }, null))).not.toThrow();
    expect(ref).toHaveBeenLastCalledWith(null);
    expect(() => view.rerender(trigger(ref))).not.toThrow();
  });
});
