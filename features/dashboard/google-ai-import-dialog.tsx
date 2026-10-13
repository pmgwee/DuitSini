"use client";

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { parseManualUsageImport } from "@/lib/claude-usage/google-ai-pro";
import { Check, ClipboardPaste, Sparkles } from "lucide-react";

const SAMPLE_USAGE = `Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-19T17:19:49Z
Gemini Models\tFive Hour Limit Remaining\t98%\t2026-10-12T22:19:49Z
Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-19T17:26:33Z
Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-12T22:26:33Z`;

export function GoogleAiImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}) {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleImport = async () => {
    if (!text.trim()) {
      setError("Please paste your usage output or JSON.");
      return;
    }

    const parsed = parseManualUsageImport(text);
    if (!parsed) {
      setError("Could not find valid quota data. Ensure the text contains Gemini and Claude/GPT model limit rows.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/claude-usage/manual-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `Import failed (${res.status})`);
      }

      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        setText("");
        onClose();
        onImported?.();
      }, 1000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setError(null);
        setSuccess(false);
        onClose();
      }}
      title="Import Google AI Pro Quota"
      description='Paste the output of agy -p "/usage" from your terminal to track your Antigravity coding allowance.'
      className="max-w-md"
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          This imports your Google AI Pro <strong>Antigravity coding allowance</strong> (Gemini 5h/weekly and Claude+GPT partner 5h/weekly pools).
        </p>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="quota-text" className="text-xs font-medium text-foreground">
              Usage Telemetry
            </label>
            <button
              type="button"
              onClick={() => {
                setText(SAMPLE_USAGE);
                setError(null);
              }}
              className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
            >
              <ClipboardPaste className="size-3" />
              Paste sample
            </button>
          </div>
          <textarea
            id="quota-text"
            rows={5}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            placeholder={`Gemini Models\tWeekly Limit Remaining\t100%\t2026-10-19T17:19:49Z\nGemini Models\tFive Hour Limit Remaining\t98%\t2026-10-12T22:19:49Z...`}
            className="w-full rounded-md border border-border/80 bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {error ? (
          <div className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger font-medium">
            {error}
          </div>
        ) : null}

        {success ? (
          <div className="rounded-md bg-success/10 px-3 py-2 text-xs text-success font-medium inline-flex items-center gap-1.5">
            <Check className="size-3.5" />
            Quota imported successfully!
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleImport}
            disabled={loading || success}
          >
            {loading ? "Importing…" : (
              <span className="inline-flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                Import Quota
              </span>
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
