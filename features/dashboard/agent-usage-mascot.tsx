import { cn } from "@/lib/utils";

interface MascotDefinition {
  src: string;
  wrapperClass: string;
}

const MASCOTS: Record<string, MascotDefinition> = {
  claude: {
    src: "/mascots/claude-mascot.gif",
    wrapperClass: "bg-orange-50/80 dark:bg-orange-950/25",
  },
  claude_pro: {
    src: "/mascots/claude-mascot.gif",
    wrapperClass: "bg-orange-50/80 dark:bg-orange-950/25",
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
        "usage-mascot grid size-11 shrink-0 place-items-center overflow-hidden rounded-2xl",
        "shadow-sm ring-1 ring-border/30 sm:size-14",
        mascot.wrapperClass,
      )}
    >
      {/* Plain img intentionally preserves animated GIF frames. */}
      <img
        src={mascot.src}
        alt=""
        className="pointer-events-none size-full object-contain"
      />
    </span>
  );
}
