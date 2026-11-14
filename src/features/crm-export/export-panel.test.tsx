// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CrmExportActions } from "./contract";
import { ExportPanel } from "./export-panel";
import { memoryCrmExport } from "./memory-actions";

// The export panel against an in-memory server of the PROPOSED contract
// (docs/CRM_EXPORT_PROPOSAL.md). No file is produced here.

afterEach(cleanup);

const press = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole("button", { name }));

describe("exporting", () => {
  it("requested, prepared, downloaded through a link asked at click time", async () => {
    const server = memoryCrmExport();
    const onOpen = vi.fn();
    const { rerender } = render(
      <ExportPanel actions={server.actions} onOpen={onOpen} />,
    );
    await screen.findByText("Aucun export pour le moment.");
    press("Préparer l’export");
    await screen.findByText(/En préparation/);
    server.finish(42);
    rerender(
      <ExportPanel actions={server.actions} onOpen={onOpen} refreshKey={1} />,
    );
    await screen.findByText(
      /Prêt · 42 lignes · disponible jusqu’au 15 novembre/,
    );
    press("Télécharger");
    await vi.waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith("about:blank#exp-1"),
    );
  });

  it("one export at a time; only the owner may ask", async () => {
    const server = memoryCrmExport();
    render(<ExportPanel actions={server.actions} />);
    await screen.findByText("Aucun export pour le moment.");
    press("Préparer l’export");
    await screen.findByText(/En préparation/);
    press("Préparer l’export");
    await screen.findByText(/déjà en préparation/);
    cleanup();
    render(
      <ExportPanel
        actions={memoryCrmExport({ role: "practitioner" }).actions}
      />,
    );
    await screen.findByText("Aucun export pour le moment.");
    press("Préparer l’export");
    await screen.findByText(/Seule la propriétaire peut exporter/);
  });

  it("a role changed before downloading: refused, nothing opened", async () => {
    const server = memoryCrmExport();
    const onOpen = vi.fn();
    const { rerender } = render(
      <ExportPanel actions={server.actions} onOpen={onOpen} />,
    );
    await screen.findByText("Aucun export pour le moment.");
    press("Préparer l’export");
    await screen.findByText(/En préparation/);
    server.finish();
    rerender(
      <ExportPanel actions={server.actions} onOpen={onOpen} refreshKey={1} />,
    );
    await screen.findByRole("button", { name: "Télécharger" });
    server.setRole("practitioner");
    press("Télécharger");
    await screen.findByText(/Tes droits ont changé/);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("expired or withdrawn: said, no download offered", async () => {
    let clock = Date.parse("2026-11-14T10:00:00.000Z");
    const server = memoryCrmExport({ now: () => clock });
    const { rerender } = render(<ExportPanel actions={server.actions} />);
    await screen.findByText("Aucun export pour le moment.");
    press("Préparer l’export");
    await screen.findByText(/En préparation/);
    server.finish();
    rerender(<ExportPanel actions={server.actions} refreshKey={1} />);
    await screen.findByRole("button", { name: "Télécharger" });
    press("Retirer");
    await screen.findByText(/Retiré/);
    expect(screen.queryByRole("button", { name: "Télécharger" })).toBeNull();
    press("Préparer l’export");
    await screen.findByText(/En préparation/);
    server.finish();
    clock += 25 * 3_600_000;
    rerender(<ExportPanel actions={server.actions} refreshKey={2} />);
    await screen.findByText(/Expiré : demande un nouvel export/);
  });

  it("a lost answer is resent with the same request id: one export", async () => {
    const server = memoryCrmExport();
    let lose = true;
    const request = vi.fn<CrmExportActions["request"]>(async (input) => {
      const result = await server.actions.request(input);
      if (lose) {
        lose = false;
        return { ok: false, error: { code: "network" } };
      }
      return result;
    });
    render(<ExportPanel actions={{ ...server.actions, request }} />);
    await screen.findByText("Aucun export pour le moment.");
    press("Préparer l’export");
    await screen.findByText(/Pas de réponse/);
    press("Préparer l’export");
    await screen.findByText(/En préparation/);
    expect(request.mock.calls[0]?.[0].requestId).toBe(
      request.mock.calls[1]?.[0].requestId,
    );
    expect(screen.getAllByText(/En préparation/)).toHaveLength(1);
  });
});
