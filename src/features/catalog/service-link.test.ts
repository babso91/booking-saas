import { describe, expect, it } from "vitest";

import { linkedService, serviceLinkKey, serviceLinkPath } from "./service-link";

const lash = {
  id: "3c9f2a1e-8b7d-4c3a-9f1e-2d4b6a8c0e1f",
  name: "Rehaussement de cils",
};
const brow = {
  id: "7aa01b22-1111-4c3a-9f1e-2d4b6a8c0e1f",
  name: "Sourcils · Teinture",
};
const services = [lash, brow];

describe("service links (Higani 29)", () => {
  it("reads like the service and carries the start of its id", () => {
    expect(serviceLinkKey(lash)).toBe("rehaussement-de-cils-3c9f2a1e");
    expect(serviceLinkPath("studio-mila", brow)).toBe(
      "/b/studio-mila?prestation=sourcils-teinture-7aa01b22",
    );
  });

  it("finds the service again, even renamed since", () => {
    expect(linkedService(services, "rehaussement-de-cils-3c9f2a1e")).toBe(lash);
    expect(linkedService(services, "ancien-nom-3c9f2a1e")).toBe(lash);
    expect(linkedService(services, "REHAUSSEMENT-DE-CILS-3C9F2A1E")).toBe(lash);
  });

  it("finds a service by its name alone when only one has it", () => {
    expect(linkedService(services, "sourcils-teinture")).toBe(brow);
    const twins = [
      lash,
      { ...lash, id: "99999999-0000-4000-8000-000000000000" },
    ];
    expect(linkedService(twins, "rehaussement-de-cils")).toBeUndefined();
  });

  it("names nothing when the service is gone or the key is empty", () => {
    expect(linkedService(services, "manucure-0badc0de")).toBeUndefined();
    expect(linkedService(services, "")).toBeUndefined();
    expect(linkedService(services, undefined)).toBeUndefined();
  });
});
