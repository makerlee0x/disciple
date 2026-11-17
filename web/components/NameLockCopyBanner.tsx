"use client";
/**
 * Flag on a coin page when this rocket slipped in (direct contract call) after a name+ticker
 * lock was already claimed. The rocket still trades; we don't delete it. Hidden from lists/search.
 */
import { useEffect, useState } from "react";
import { fetchNameLockCopy } from "@/lib/nameLock";

export default function NameLockCopyBanner({ coin }: { coin: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchNameLockCopy(coin).then((r) => { if (alive && r?.copy) setShow(true); }).catch(() => {});
    return () => { alive = false; };
  }, [coin]);
  if (!show) return null;
  return (
    <p role="status" data-testid="name-lock-copy-flag" className="pointer-events-none fixed left-1/2 top-3 z-[40] w-[min(36rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-lg border border-[#5a3a1a] bg-[#1a140c]/90 px-3 py-2 text-center text-xs text-[#FFD7A8] shadow-lg">
      Copycat: a rocket that already reached orbit owns this name and ticker. This one can still be traded.
    </p>
  );
}
