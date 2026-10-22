import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BrandSite } from "@/features/experience-lab/site";
import { universes } from "@/features/experience-lab/universes";

const find = (id: string) =>
  Object.values(universes).find((universe) => universe.id === id) ?? null;

export async function generateMetadata({
  params,
}: PageProps<"/labo/[univers]">): Promise<Metadata> {
  const universe = find((await params).univers);
  return { title: universe ? universe.name : "Labo" };
}

// A professional's direct link: her mini-site is the whole experience.
export default async function LabBrandPage({
  params,
}: PageProps<"/labo/[univers]">) {
  const universe = find((await params).univers);
  if (!universe) notFound();
  return <BrandSite id={universe.id} />;
}
