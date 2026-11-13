import { describe, expect, it } from "vitest";

import type { ServiceOption } from "@/features/catalog/model";
import { setServiceOptionsSchema } from "@/features/catalog/schemas";

import {
  checkOptions,
  commandOf,
  draftOf,
  emptyChoice,
  emptyOption,
  minutesOf,
  moved,
  optionsChanged,
  priceOf,
} from "./options-draft";

const SERVICE = "30000000-0000-4000-8000-000000000001";
const id = (n: number) => `40000000-0000-4000-8000-00000000000${n}`;

const saved: ServiceOption[] = [
  {
    id: id(1),
    question: "Longueur",
    required: true,
    choices: [
      {
        id: id(2),
        label: "Naturelle",
        priceDeltaCents: 0,
        durationDeltaMinutes: 0,
      },
      {
        id: id(3),
        label: "Volume",
        priceDeltaCents: 1500,
        durationDeltaMinutes: 30,
      },
    ],
  },
  {
    id: id(4),
    question: "Dépose ?",
    required: false,
    choices: [
      {
        id: id(5),
        label: "Oui",
        priceDeltaCents: 750,
        durationDeltaMinutes: 15,
      },
    ],
  },
];

describe("what she types", () => {
  it("empty adds nothing; prices in euros, durations in whole minutes", () => {
    expect(priceOf("")).toBe(0);
    expect(priceOf("7,50")).toBe(750);
    expect(priceOf("abc")).toBeNull();
    expect(minutesOf(" ")).toBe(0);
    expect(minutesOf("30")).toBe(30);
    expect(minutesOf("1,5")).toBeNull();
    expect(minutesOf("241")).toBeNull();
  });
});

describe("a draft of her saved options", () => {
  it("shows them as typed, and is not a change", () => {
    const draft = draftOf(saved);
    expect(draft[0]!.choices[1]).toMatchObject({ price: "15", minutes: "30" });
    expect(draft[0]!.choices[0]).toMatchObject({ price: "", minutes: "" });
    expect(optionsChanged(saved, draft)).toBe(false);
    expect(checkOptions(draft)).toEqual({});
  });

  it("sent back unchanged: the same list, nothing deleted, valid for the server", () => {
    const command = commandOf(SERVICE, 4, saved, draftOf(saved));
    expect(command.options).toEqual(saved);
    expect(command.deletedOptionIds).toEqual([]);
    expect(command.deletedChoiceIds).toEqual([]);
    expect(setServiceOptionsSchema.safeParse(command).success).toBe(true);
  });
});

describe("what she changes", () => {
  it("a removed answer is named; a removed group is named without its answers", () => {
    const draft = draftOf(saved);
    draft[0]!.choices.pop(); // "Volume"
    draft.pop(); // "Dépose ?"
    const command = commandOf(SERVICE, 4, saved, draft);
    expect(command.deletedChoiceIds).toEqual([id(3)]);
    expect(command.deletedOptionIds).toEqual([id(4)]);
    expect(optionsChanged(saved, draft)).toBe(true);
    expect(setServiceOptionsSchema.safeParse(command).success).toBe(true);
  });

  it("new groups and answers go without an id, in her order, trimmed", () => {
    const draft = [
      { ...emptyOption(), question: "  Couleur  ", required: false },
      ...draftOf(saved),
    ];
    draft[0]!.choices[0] = {
      ...emptyChoice(),
      label: " Rouge ",
      price: "5",
      minutes: "10",
    };
    const command = commandOf(SERVICE, 4, saved, draft);
    expect(command.options[0]).toEqual({
      id: null,
      question: "Couleur",
      required: false,
      choices: [
        {
          id: null,
          label: "Rouge",
          priceDeltaCents: 500,
          durationDeltaMinutes: 10,
        },
      ],
    });
    expect(command.options[1]!.id).toBe(id(1));
    expect(setServiceOptionsSchema.safeParse(command).success).toBe(true);
  });

  it("reordering is a change; a typo then its fix is not", () => {
    expect(optionsChanged(saved, moved(draftOf(saved), 0, 1))).toBe(true);
    const draft = draftOf(saved);
    draft[0]!.question = "Longueur ";
    expect(optionsChanged(saved, draft)).toBe(false);
  });

  it("moving past either end changes nothing", () => {
    const list = [1, 2, 3];
    expect(moved(list, 0, -1)).toBe(list);
    expect(moved(list, 2, 1)).toBe(list);
    expect(moved(list, 0, 1)).toEqual([2, 1, 3]);
  });
});

describe("what is refused before sending", () => {
  it("an empty question, an unnamed or duplicate answer, a bad price or duration", () => {
    const draft = draftOf(saved);
    draft[0]!.question = " ";
    draft[0]!.choices[0]!.label = "";
    draft[0]!.choices[1]!.price = "quinze";
    draft[1]!.choices.push({ ...emptyChoice(), label: "oui", minutes: "999" });
    const errors = checkOptions(draft);
    expect(errors[draft[0]!.key]).toMatch(/question/);
    expect(errors[`${draft[0]!.choices[0]!.key}:label`]).toMatch(/Nomme/);
    expect(errors[`${draft[0]!.choices[1]!.key}:price`]).toMatch(/montant/);
    const added = draft[1]!.choices[1]!;
    expect(errors[`${added.key}:label`]).toMatch(/existe déjà/);
    expect(errors[`${added.key}:minutes`]).toMatch(/minutes/);
  });
});
