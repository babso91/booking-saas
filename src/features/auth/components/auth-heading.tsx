import type { ReactNode } from "react";

export function AuthHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex animate-rise flex-col gap-3">
      <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
        {eyebrow}
      </p>
      <h1 className="font-display text-[42px] leading-[1.02] tracking-[-0.015em] text-balance text-ink sm:text-[48px]">
        {title}
      </h1>
      {children ? (
        <p className="text-[16px] leading-relaxed text-ink-soft">{children}</p>
      ) : null}
    </div>
  );
}
