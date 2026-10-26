"use client";
import { useCallback, useEffect, useState } from "react";
import { onPrivy } from "@/lib/aa/session";
import { inviteStatus, type InviteStatus } from "@/lib/invitesClient";

/** The player's invite status; reloads when the Privy session changes. null while loading or if the API is down. */
export function useInvites(): { st: InviteStatus | null; reload: () => Promise<void> } {
  const [st, setSt] = useState<InviteStatus | null>(null);
  const reload = useCallback(async () => {
    try { setSt(await inviteStatus()); }
    catch (e) { console.warn("[disciple] invites status failed:", (e as Error).message); setSt(null); }
  }, []);
  useEffect(() => { void reload(); return onPrivy(() => void reload()); }, [reload]);
  return { st, reload };
}
