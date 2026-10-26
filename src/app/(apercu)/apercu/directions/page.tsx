import type { Route } from "next";
import Link from "next/link";

export const metadata = { title: "Directions artistiques" };

// Index of the art-direction prototypes. Plain on purpose: a table of
// contents, not a design.
const directions: { href: Route; agenda: Route; name: string; line: string }[] =
  [
    {
      href: "/apercu/directions/carnet",
      agenda: "/apercu/directions/carnet/agenda",
      name: "Le Carnet",
      line: "Éditorial et personnel : son agenda comme un carnet imprimé, une page par jour.",
    },
    {
      href: "/apercu/directions/studio",
      agenda: "/apercu/directions/studio/agenda",
      name: "Le Studio",
      line: "Graphique et audacieux : sa journée comme une affiche, une couleur signature.",
    },
    {
      href: "/apercu/directions/ecrin",
      agenda: "/apercu/directions/ecrin/agenda",
      name: "L’Écrin",
      line: "Tactile et raffiné : sa journée comme un objet précieux, un cadran.",
    },
  ];

export default function DirectionsIndex() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "48px 20px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>
        Directions artistiques — aperçu
      </h1>
      <p style={{ color: "#555", marginTop: 8 }}>
        Données fictives. Chaque direction : accueil du jour et agenda, sur
        téléphone et ordinateur. Le bouton « Aperçu » change la palette et le
        mode.
      </p>
      <ul
        style={{
          marginTop: 28,
          display: "grid",
          gap: 16,
          listStyle: "none",
          padding: 0,
        }}
      >
        {directions.map((d) => (
          <li
            key={d.href}
            style={{ borderTop: "1px solid #ddd", paddingTop: 16 }}
          >
            <Link
              href={d.href}
              style={{
                fontSize: 20,
                fontWeight: 600,
                textDecoration: "underline",
              }}
            >
              {d.name}
            </Link>
            <p style={{ color: "#444", marginTop: 4 }}>{d.line}</p>
            <Link
              href={d.agenda}
              style={{ color: "#444", textDecoration: "underline" }}
            >
              Agenda
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
