import { it, expect } from "vitest";
import { shortestOffer, calendarMonth, timeLabels } from "./story-planning";
import { storyPageCount } from "./story-image";

it("shows only the first available start in each window, and paginates dense days", () => {
  expect(
    timeLabels(["10:30", "09:00", "09:15", "09:30", "09:00", "11:00"], 15),
  ).toEqual(["09:00", "10:30", "11:00"]);
  expect(timeLabels(["10:15", "10:30", "18:00", "18:15"], 15)).toEqual([
    "10:15",
    "18:00",
  ]);
  expect(timeLabels([], 15)).toEqual([]);
  const dates = calendarMonth("2028-02");
  expect(dates).toMatchObject({
    from: "2028-02-01",
    through: "2028-02-29",
    offset: 1,
    length: 29,
  });
  expect(
    storyPageCount({
      dates,
      name: "Salon",
      updated: new Date(),
      timezone: "Europe/Paris",
      days: [Array(9).fill("09:00")],
    }),
  ).toBe(3);
});
it("uses a genuinely bookable service including its shortest mandatory answers", () => {
  const base = {
    id: "a",
    name: "Pose",
    priceCents: 3000,
    description: null,
    durationMinutes: 15,
    options: [],
  };
  const choices = [
    { id: "long", label: "Long", durationDeltaMinutes: 50, priceDeltaCents: 0 },
    {
      id: "short",
      label: "Court",
      durationDeltaMinutes: 15,
      priceDeltaCents: 0,
    },
  ];
  const catalog = {
    currency: "EUR",
    groups: [
      {
        category: null,
        services: [
          {
            ...base,
            options: [
              { id: "q", question: "Longueur", required: true, choices },
            ],
          },
          { ...base, id: "b", durationMinutes: 40 },
        ],
      },
    ],
  };
  expect(shortestOffer(catalog)).toEqual({
    serviceId: "a",
    duration: 30,
    choiceIds: ["short"],
  });
  catalog.groups[0]!.services[0]!.options[0]!.choices = [];
  expect(shortestOffer(catalog)?.serviceId).toBe("b");
});
