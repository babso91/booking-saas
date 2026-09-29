// Placeholder while the onboarding wizard mounts on the client.
export function OnboardingSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[480px] animate-fade flex-col gap-8 [animation-delay:200ms]"
      aria-busy="true"
    >
      <span className="sr-only" role="status">
        Chargement de ton espace…
      </span>
      <div className="grid grid-cols-4 gap-1.5">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className="h-[3px] rounded-full bg-sand-deep" />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        <span className="h-3 w-28 animate-pulse rounded-full bg-sand-deep" />
        <span className="h-10 w-4/5 animate-pulse rounded-2xl bg-sand" />
        <span className="h-4 w-3/5 animate-pulse rounded-full bg-sand" />
      </div>
      <div className="flex flex-col gap-4">
        <span className="h-14 animate-pulse rounded-2xl bg-sand" />
        <span className="h-14 animate-pulse rounded-2xl bg-sand" />
      </div>
    </div>
  );
}
