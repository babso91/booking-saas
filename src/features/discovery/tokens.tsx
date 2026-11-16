import { StyleSwatch } from "@/features/appearance/components/appearance-settings";
import type { StyleId } from "@/features/appearance/palettes";
import { cn } from "@/lib/cn";

/** Each universe by its own thumbnail (the one « Apparence » shows). */
export function UniverseToken({
  style,
  active,
  large,
}: {
  style: StyleId;
  active: boolean;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "block rounded-[14px] transition-[box-shadow,transform] duration-200 ease-soft",
        large ? "w-28 shrink-0" : "w-full",
        active
          ? "shadow-[0_0_0_2px_var(--color-ink)]"
          : "opacity-90 group-hover:opacity-100",
      )}
    >
      {large ? (
        <StyleSwatch id={style} />
      ) : (
        // Smaller on a phone: the same thumbnail, drawn at 70 %.
        <span className="block h-14 overflow-hidden rounded-xl sm:h-auto">
          <span className="block w-[143%] origin-top-left scale-[0.7] sm:w-full sm:scale-100">
            <StyleSwatch id={style} />
          </span>
        </span>
      )}
    </span>
  );
}
