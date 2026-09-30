// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  clearAllDrafts,
  clearDraft,
  emptyDraft,
  loadDraft,
  saveDraft,
} from "./draft";

describe("onboarding draft storage", () => {
  it("clearAllDrafts removes per-account slots and the legacy shared slot only", () => {
    window.sessionStorage.setItem("onboarding:draft", '{"owner":"old"}'); // before per-account slots
    saveDraft(emptyDraft, 1, "user-a");
    saveDraft(emptyDraft, 2, "user-b");
    window.sessionStorage.setItem("onboarding:drafted", "unrelated");
    window.sessionStorage.setItem("mock:scenario", "unrelated");

    clearAllDrafts();

    expect(window.sessionStorage.getItem("onboarding:draft")).toBeNull();
    expect(loadDraft("user-a")).toBeNull();
    expect(loadDraft("user-b")).toBeNull();
    expect(window.sessionStorage.getItem("onboarding:drafted")).toBe(
      "unrelated",
    );
    expect(window.sessionStorage.getItem("mock:scenario")).toBe("unrelated");
  });

  it("clearDraft removes one account's slot", () => {
    saveDraft(emptyDraft, 1, "user-a");
    saveDraft(emptyDraft, 1, "user-b");
    clearDraft("user-a");
    expect(loadDraft("user-a")).toBeNull();
    expect(loadDraft("user-b")).not.toBeNull();
  });
});
