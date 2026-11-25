import type { Story } from "./story-planning";

const W = 1080;
const H = 1920;
const ink = "#34222c";
const wine = "#793e55";
const muted = "#76636b";
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

  const text = (
    value: string,
    x: number,
    y: number,
    font: string,
    color = ink,
    maxWidth = W - 160,
  ) => {
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.fillText(value, x, y, maxWidth);
  };
  const panel = (
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    fill: string,
  ) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
  };
  const ground = ctx.createLinearGradient(0, 0, W, H);
  ground.addColorStop(0, "#442a39");
  ground.addColorStop(0.4, "#8a5667");
  ground.addColorStop(0.72, "#684052");
  ground.addColorStop(1, "#372531");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  const center = W / 2;
  text(story.name, center, 135, "italic 54px Georgia, serif", "#fff7f2");

  panel(38, 190, W - 76, 1390, 62, "#fffaf6");
  text("Planning", center, 315, "italic 80px Georgia, serif", wine);
  const month = dates.title.charAt(0).toUpperCase() + dates.title.slice(1);
  text(month, center, 407, "600 88px system-ui");
  text(dates.year, center, 460, "32px system-ui", muted);

  const inset = 62;
  const cell = (W - 2 * inset) / 7;
  const columnCenter = (column: number) => inset + (column + 0.5) * cell;
  ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].forEach((label, column) =>
    text(label, columnCenter(column), 540, "500 32px system-ui", muted),
  );
  const rows = Math.ceil((dates.offset + dates.length) / 7);
  const top = 570;
  const rowHeight = (1540 - top) / rows;
  const slotHeight = 28;
  days.forEach((labels, index) => {
    const position = dates.offset + index;
    const x = columnCenter(position % 7);
    const y = top + Math.floor(position / 7) * rowHeight;
    const slice = labels.slice(page * pageSize, (page + 1) * pageSize);
    text(
      String(index + 1).padStart(2, "0"),
      x,
      y + 33,
      "600 38px system-ui",
      slice.length ? ink : "#918189",
    );
    slice.forEach((start, j) => {
      const slotTop = y + 44 + j * (slotHeight + 3);
      panel(x - 55, slotTop, 110, slotHeight, 10, "#f2e5e8");
      text(start, x, slotTop + 23, "500 27px system-ui", wine);
    });
  });
  if (!days.some((day) => day.length)) {
    text(
      "Aucun créneau disponible ce mois-ci.",
      center,
      1550,
      "32px system-ui",
      muted,
    );
  }
  panel(38, 1612, W - 76, 118, 42, "#f3dfdf");
  text(
    "Pour réserver, écris-moi en privé.",
    center,
    1686,
    "italic 49px Georgia, serif",
    "#492b39",
  );
  const stamp = story.updated.toLocaleString("fr-FR", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: story.timezone,
  });
  const pageNumber = pages > 1 ? "  ·  " + (page + 1) + " / " + pages : "";
  text(
    "Mis à jour le " + stamp + pageNumber,
    center,
    1800,
    "30px system-ui",
    "#fff4f3",
  );

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
