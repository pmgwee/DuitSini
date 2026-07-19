import { Telescope } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { getSerenityData } from "@/lib/serenity";
import { SerenityView } from "@/features/serenity/serenity-view";

export const dynamic = "force-dynamic";

/**
 * /serenity — a premium view of the reconstructed portfolio, themes and daily
 * commentary of the AI-photonics stock-picker @aleabitoreddit ("Serenity"),
 * derived from serenitytrades.com. All data is fetched, parsed, cached and
 * remapped server-side (lib/serenity) and handed to the client view as plain
 * serializable props. Not affiliated with the account; not investment advice.
 */
export default async function SerenityPage() {
  const data = await getSerenityData();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        title="Serenity Tracker"
        description="Reconstructed portfolio, themes & daily read on @aleabitoreddit — the AI-photonics stock-picker. Derived from serenitytrades.com."
        actions={
          <a
            href={data.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 rounded-full border border-border/60 bg-surface/40 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
          >
            <Telescope className="size-3.5" />
            Source
          </a>
        }
      />
      <SerenityView initialData={data} />
    </div>
  );
}
