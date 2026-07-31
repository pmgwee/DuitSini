import { cn } from "@/lib/utils";

interface MascotDefinition {
  src: string;
  wrapperClass: string;
  repairEyes?: boolean;
}

const MASCOTS: Record<string, MascotDefinition> = {
  claude: {
    src: "/mascots/claude-mascot.gif",
    wrapperClass: "bg-[#fff4ef]",
    repairEyes: true,
  },
  claude_pro: {
    src: "/mascots/claude-mascot.gif",
    wrapperClass: "bg-[#fff4ef]",
    repairEyes: true,
  },
  glm: {
    src: "/mascots/zai-mascot.gif",
    wrapperClass: "bg-pink-50/80 dark:bg-pink-950/25",
  },
  codex: {
    src: "/mascots/codex-mascot.gif",
    wrapperClass: "bg-blue-50/80 dark:bg-blue-950/30",
  },
};

/** Decorative animated companion for a provider's weekly usage limit. */
export function AgentUsageMascot({ source }: { source: string }) {
  const mascot = MASCOTS[source];
  if (!mascot) return null;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "usage-mascot relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-full",
        "shadow-sm ring-1 ring-border/30 sm:size-16",
        mascot.wrapperClass,
      )}
    >
      {mascot.repairEyes ? (
        <>
          <span className="absolute left-[24%] top-[49%] z-20 h-[18%] w-[22%] bg-[#de775c] mix-blend-darken" />
          <span className="absolute left-[54%] top-[49%] z-20 h-[18%] w-[22%] bg-[#de775c] mix-blend-darken" />
          <span className="absolute left-[32%] top-[56%] z-30 size-[4%] bg-black" />
          <span className="absolute left-[62%] top-[56%] z-30 size-[4%] bg-black" />
        </>
      ) : null}
      {/* Plain img intentionally preserves animated GIF frames. */}
      <img
        src={mascot.src}
        alt=""
        className="pointer-events-none relative z-10 size-full object-contain [image-rendering:pixelated]"
      />
    </span>
  );
}
