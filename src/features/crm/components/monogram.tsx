import { cn } from "@/lib/cn";

import { initials } from "../client/format";

/** Initials of the current record: never a made-up photo. */
export function Monogram({
  firstName,
  lastName,
  size = "md",
}: {
  firstName: string;
  lastName: string | null;
  size?: "md" | "lg";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong",
        size === "lg" ? "size-14 text-[18px]" : "size-10 text-[13.5px]",
      )}
    >
      {initials(firstName, lastName)}
    </span>
  );
}
