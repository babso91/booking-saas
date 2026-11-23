import type { Story } from "./story-planning";

const W = 1080,
  H = 1920;
const ink = "#2c2429",
  wine = "#743c51",
  muted = "#665c61";
const pageSize = 4;

export function storyPageCount(story: Story) {
  return Math.max(
    1,
    ...story.days.map((day) => Math.ceil(day.length / pageSize)),
  );
}

export async function storyImage(story: Story, page: number) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Ce navigateur ne peut pas créer l’image.");
  const { dates, days } = story;
  const pages = storyPageCount(story);
  function text(
    value: string,
    x: number,
    y: number,
    font: string,
    color = ink,
    max?: number,
  ) {
    ctx!.fillStyle = color;
    ctx!.font = font;
    ctx!.fillText(value, x, y, max);
  }
  function rule(y: number) {
    ctx!.fillStyle = "#d9cbd0";
    ctx!.fillRect(54, y, W - 108, 2);
  }
  ctx.fillStyle = "#fbf6f2";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = wine;
  ctx.fillRect(0, 0, W, 18);
  text(story.name, 56, 155, "600 41px system-ui", wine, W - 112);
  text("Mes disponibilités", 52, 253, "italic 62px Georgia, serif", muted);
  text(
    dates.title.charAt(0).toUpperCase() + dates.title.slice(1),
    48,
    366,
    "96px Georgia, serif",
    ink,
    750,
  );
  ctx.textAlign = "right";
  text(dates.year, W - 58, 363, "42px system-ui", wine);
  ctx.textAlign = "left";
  rule(410);
  const grid = 436,
    cell = (W - 108) / 7,
    rows = Math.ceil((dates.offset + dates.length) / 7);
  const height = (1440 - (grid + 60)) / rows;
  const week = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];
  week.forEach((label, i) =>
    text(label, 59 + i * cell, grid + 27, "600 23px system-ui", muted),
  );
  for (let row = 0; row < rows; row++) rule(grid + 55 + row * height);
  days.forEach((labels, index) => {
    const position = dates.offset + index;
    const x = 59 + (position % 7) * cell;
    const y = grid + 55 + Math.floor(position / 7) * height;
    const slice = labels.slice(page * pageSize, (page + 1) * pageSize);
    text(
      String(index + 1),
      x,
      y + 40,
      "600 33px system-ui",
      labels.length ? ink : "#847a7e",
    );
    slice.forEach((label, j) =>
      text(
        label,
        x,
        y + 74 + j * (slice.length === 4 ? 24 : 31),
        slice.length === 4 ? "600 24px system-ui" : "600 29px system-ui",
        wine,
        cell - 8,
      ),
    );
  });
  rule(1440);
  if (!days.some((day) => day.length)) {
    text(
      "Aucun créneau disponible ce mois-ci.",
      55,
      1504,
      "33px system-ui",
      muted,
      W - 110,
    );
  } else {
    text("Heures de début disponibles", 55, 1504, "600 34px system-ui");
    text(
      "Selon la durée de la prestation.",
      55,
      1556,
      "28px system-ui",
      muted,
      W - 110,
    );
  }
  text(
    "Pour réserver, écris-moi en privé.",
    53,
    1694,
    "italic 54px Georgia, serif",
    wine,
    W - 110,
  );
  if (days.some((day) => day.some((label) => label.includes("–")))) {
    text(
      "Dans une plage, un départ toutes les " + story.step + " min.",
      55,
      1602,
      "28px system-ui",
      muted,
      W - 110,
    );
  }
  const stamp = story.updated.toLocaleString("fr-FR", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: story.timezone,
  });
  text(
    "Mis à jour le " + stamp,
    56,
    1784,
    "26px system-ui",
    muted,
    pages > 1 ? 760 : W - 112,
  );
  if (pages > 1) {
    ctx.textAlign = "right";
    text(
      String(page + 1) + " / " + pages,
      W - 56,
      1784,
      "600 27px system-ui",
      wine,
    );
  }
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("L’image n’a pas pu être créée.")),
      "image/png",
    ),
  );
}
