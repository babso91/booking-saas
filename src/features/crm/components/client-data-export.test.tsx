// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeError } from "@/features/auth/client/error-copy";
import type { ActionResult } from "@/lib/errors";

import { ClientDataExport } from "./client-data-export";

const actions = vi.hoisted(() => ({ exportClientDataAction: vi.fn() }));
vi.mock("@/features/crm/actions/client-export", () => actions);

const CLIENT = "20000000-0000-4000-8000-000000000001";
const done = <T,>(data: T): ActionResult<T> => ({ ok: true, data });

let saved: { name: string; content: string }[];

beforeEach(() => {
  actions.exportClientDataAction.mockReset();
  saved = [];
  // The file the browser would save: its name and content.
  URL.createObjectURL = vi.fn(() => "blob:export");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ name: this.download, content: this.href });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("ClientDataExport (point 205)", () => {
  it("downloads everything her business holds as one JSON file", async () => {
    actions.exportClientDataAction.mockResolvedValue(
      done({
        format: "higani.client-export.v1",
        client: { firstName: "Inès" },
      }),
    );
    render(<ClientDataExport clientId={CLIENT} displayName="Inès Martin" />);
    expect(screen.getByText(/te demande les informations/)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Exporter ses données" }),
    );
    await screen.findByText("Fichier téléchargé.");
    expect(actions.exportClientDataAction).toHaveBeenCalledTimes(1);
    expect(actions.exportClientDataAction).toHaveBeenCalledWith({
      clientId: CLIENT,
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(
      /^donnees-ines-martin-\d{4}-\d{2}-\d{2}\.json$/,
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:export");
  });

  it("says why when it is refused, and saves nothing", async () => {
    actions.exportClientDataAction.mockResolvedValue({
      ok: false,
      error: { code: "forbidden", message: "backend text" },
    } as ActionResult<never>);
    render(<ClientDataExport clientId={CLIENT} displayName="Inès" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Exporter ses données" }),
    );
    await screen.findByText(describeError({ code: "forbidden" }).message);
    expect(screen.queryByText("Fichier téléchargé.")).toBeNull();
    expect(saved).toEqual([]);
    expect(screen.queryByText("backend text")).toBeNull();
  });
});
