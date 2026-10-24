import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isProId } from "@/features/experience-lab/catalog/pros";
import { BrandSite } from "@/features/experience-lab/site";
import { universes } from "@/features/experience-lab/universes";

const find = (id: string) =>
  Object.values(universes).find((universe) => universe.id === id) ?? null;

export async function generateMetadata({
  params,
}: PageProps<"/labo/[univers]">): Promise<Metadata> {
  const universe = find((await params).univers);
  return { title: universe ? universe.config.brand.name : "Labo" };
}

// A professional's direct link: her mini-site is the whole experience.
// Lab only: `?pro=cils|henne|epilation` opens a fictional business of
// another trade in this universe (her catalogue, not the universe's).
export default async function LabBrandPage({
  params,
  searchParams,
}: PageProps<"/labo/[univers]">) {
  const universe = find((await params).univers);
  if (!universe) notFound();
  const pro = (await searchParams).pro;
  return (
    <BrandSite
      key={String(pro)}
      id={universe.id}
      pro={isProId(pro) ? pro : undefined}
    />
  );
}
