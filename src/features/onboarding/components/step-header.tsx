import type { ReactNode, Ref } from "react";

export function StepHeader({
  eyebrow,
  title,
  children,
  headingRef,
  aside,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-[12.5px] font-semibold tracking-[0.16em] text-accent uppercase">
          {eyebrow}
        </p>
        {aside}
      </div>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-[38px] leading-[1.04] tracking-[-0.015em] text-balance text-ink outline-none sm:text-[46px]"
      >
        {title}
      </h1>
      {children ? (
        <p className="max-w-[46ch] text-[16px] leading-relaxed text-ink-soft">
          {children}
        </p>
      ) : null}
    </header>
  );
}
