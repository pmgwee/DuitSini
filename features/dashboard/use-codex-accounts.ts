"use client";

import { useEffect, useState } from "react";
import {
  CODEX_ACCOUNT_SLOTS,
  sortCodexAccounts,
  type CodexAccountMetadata,
} from "@/lib/claude-usage/codex-accounts";

export type CodexDeviceRow = {
  id: string;
  device_name: string;
  protocol_version: number;
  switch_supported: boolean;
  active_account_key: string | null;
  heartbeat_at: string;
  generation: number;
};

function emptyAccount(slot: (typeof CODEX_ACCOUNT_SLOTS)[number]): CodexAccountMetadata {
  return {
    account_key: slot.account_key,
    slot: slot.slot,
    label: slot.label,
    email: null,
    workspace_id: null,
    workspace_name: null,
    plan_type: null,
    connected: false,
    verified: false,
    status: "needs_sign_in",
    device_id: null,
    last_seen_at: null,
  };
}

/** One owner-scoped directory shared by account controls and usage sections. */
export function useCodexAccounts(): {
  accounts: CodexAccountMetadata[];
  devices: CodexDeviceRow[];
  loaded: boolean;
} {
  const [accounts, setAccounts] = useState<CodexAccountMetadata[]>(() =>
    CODEX_ACCOUNT_SLOTS.map(emptyAccount),
  );
  const [devices, setDevices] = useState<CodexDeviceRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch("/api/codex/accounts", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        if (!response.ok) return;
        const body = (await response.json()) as {
          accounts?: CodexAccountMetadata[];
          devices?: CodexDeviceRow[];
        };
        if (alive && Array.isArray(body.accounts)) {
          setAccounts(sortCodexAccounts(body.accounts));
          setLoaded(true);
        }
        if (alive && Array.isArray(body.devices)) setDevices(body.devices);
      } catch {
        // Fixed account shells stay visible if metadata is temporarily offline.
      }
    };

    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  return { accounts, devices, loaded };
}
