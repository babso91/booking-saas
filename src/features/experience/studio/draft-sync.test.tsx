// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SiteConfig as SavedConfig } from "@/features/sites/config";

import type { SiteConfig } from "../engine/config";
import { SAVE_DELAY_MS, useDraftSync } from "./draft-sync";
import { demo } from "./photos";
import { firstDraft, savedConfigOf } from "./saved";
import { universes } from "./universes";

// Her draft, saved by itself, against a fake server that keeps revisions
// like the real one: a write on the revision it holds advances it; on an
// older one, stale_site_draft — unless it holds exactly that already.

type Server = { revision: number; config: SavedConfig | null; down: boolean };

function fakeServer(server: Server) {
  const save = vi.fn(async (expected: number, config: SavedConfig) => {
    if (server.down)
      return { ok: false as const, error: { code: "network" as const } };
    if (expected !== server.revision) {
      if (JSON.stringify(config) === JSON.stringify(server.config))
        return { ok: true as const, data: { revision: server.revision } };
      return {
        ok: false as const,
        error: { code: "stale_site_draft" as const },
      };
    }
    server.revision += 1;
    server.config = config;
    return { ok: true as const, data: { revision: server.revision } };
  });
  const read = vi.fn(async () => ({
    ok: true as const,
    data: { revision: server.revision, config: server.config },
  }));
  return { save, read };
}

const base = firstDraft(universes.mila, "Studio Inès");
const named = (config: SiteConfig, name: string): SiteConfig => ({
  ...config,
  brand: { ...config.brand, name },
});

function mount(server: Server, initial = base) {
  const { save, read } = fakeServer(server);
  const replaced: SiteConfig[] = [];
  const hook = renderHook(
    ({ value }) =>
      useDraftSync({
        value,
        revision: server.revision,
        saved: server.config,
        save,
        read,
        replace: (config) => replaced.push(config),
      }),
    { initialProps: { value: initial } },
  );
  const edit = (value: SiteConfig) => hook.rerender({ value });
  const wait = (ms = SAVE_DELAY_MS) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  return { hook, save, read, edit, wait, replaced };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("her draft, saved by itself", () => {
  it("her first draft is saved a moment after she stops, on revision 0", async () => {
    const server: Server = { revision: 0, config: null, down: false };
    const { hook, save, wait } = mount(server);
    expect(hook.result.current.status.kind).toBe("pending");
    await wait();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe(0);
    expect(hook.result.current.status.kind).toBe("saved");
    expect(hook.result.current.revision).toBe(1);
  });

  it("quick successive changes are one save; a change made while saving is the next one", async () => {
    const server: Server = {
      revision: 3,
      config: savedConfigOf(base),
      down: false,
    };
    const { hook, save, edit, wait } = mount(server);
    edit(named(base, "S"));
    await wait(300);
    edit(named(base, "St"));
    await wait(300);
    edit(named(base, "Stu"));
    await wait();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1].brand.name).toBe("Stu");
    edit(named(base, "Studio"));
    await wait();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toBe(4);
    expect(hook.result.current.revision).toBe(5);
  });

  it("changed elsewhere: nothing overwritten, nothing of hers dropped; she keeps hers", async () => {
    const server: Server = {
      revision: 1,
      config: savedConfigOf(base),
      down: false,
    };
    const { hook, save, edit, wait } = mount(server);
    // Another tab saves first.
    server.revision = 2;
    server.config = savedConfigOf(named(base, "Autre onglet"));
    edit(named(base, "Le mien"));
    await wait();
    const status = hook.result.current.status;
    expect(status.kind).toBe("conflict");
    if (status.kind !== "conflict") throw new Error();
    expect(status.theirs.brand.name).toBe("Autre onglet");
    expect(status.revision).toBe(2);
    // Nothing more is sent until she chooses.
    await wait(5 * SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.keepMine());
    await wait(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toBe(2);
    expect(server.config!.brand.name).toBe("Le mien");
    expect(hook.result.current.status.kind).toBe("saved");
  });

  it("…or she takes the saved one: it replaces hers in the studio", async () => {
    const server: Server = {
      revision: 1,
      config: savedConfigOf(base),
      down: false,
    };
    const { hook, edit, wait, replaced } = mount(server);
    server.revision = 2;
    server.config = savedConfigOf(named(base, "Autre onglet"));
    edit(named(base, "Le mien"));
    await wait();
    act(() => hook.result.current.takeTheirs());
    expect(replaced.at(-1)!.brand.name).toBe("Autre onglet");
    // The studio now shows it (replace puts it in her history).
    edit(replaced.at(-1)!);
    expect(hook.result.current.revision).toBe(2);
    expect(hook.result.current.status.kind).toBe("saved");
  });

  it("a lost answer is said; her changes stay and are sent again on retry", async () => {
    const server: Server = {
      revision: 1,
      config: savedConfigOf(base),
      down: true,
    };
    const { hook, save, edit, wait } = mount(server);
    edit(named(base, "Hors ligne"));
    await wait();
    expect(hook.result.current.status).toEqual({
      kind: "error",
      error: { code: "network" },
    });
    // Not retried in a loop behind her back.
    await wait(5 * SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    server.down = false;
    act(() => hook.result.current.retry());
    await wait(0);
    expect(server.config!.brand.name).toBe("Hors ligne");
    expect(hook.result.current.status.kind).toBe("saved");
  });

  it("a demo photo shown in her preview is never sent", async () => {
    const server: Server = {
      revision: 1,
      config: savedConfigOf(base),
      down: false,
    };
    const { save, edit, wait } = mount(server);
    edit({
      ...named(base, "Avec démo"),
      content: { ...base.content, cover: demo("1548902378-2ec44c906391") },
    });
    await wait();
    expect(JSON.stringify(save.mock.calls[0]![1])).not.toMatch(/demo:/);
    expect(save.mock.calls[0]![1].content.cover).toBeNull();
  });

  it("her draft read back in the server's key order is not a change", async () => {
    // PostgreSQL's jsonb gives her configuration back with its keys sorted.
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => b.length - a.length || (a < b ? 1 : -1))
                .map(([key, item]) => [key, sorted(item)]),
            )
          : value;
    const server: Server = {
      revision: 3,
      config: sorted(savedConfigOf(base)) as SavedConfig,
      down: false,
    };
    const { hook, save, wait } = mount(server);
    expect(hook.result.current.dirty).toBe(false);
    await wait(SAVE_DELAY_MS * 3);
    expect(save).not.toHaveBeenCalled();
    expect(hook.result.current.status.kind).toBe("saved");
  });
});
