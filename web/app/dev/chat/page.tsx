"use client";
/** Debug page: /dev/chat?coin=0x…  (&mock=1 for the local mock). Not linked from the UI. */
import { useEffect, useRef, useState } from "react";
import * as real from "@/lib/chat/client";
import { DiscipleChatMock } from "@/lib/chat/mock";
import type { ChatMsg, ChatState } from "@/lib/chat/types";

export default function DevChat() {
  const [coin, setCoin] = useState("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [st, setSt] = useState<ChatState>("connecting");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const api = useRef<typeof real.DiscipleChat>(real.DiscipleChat);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("mock") === "1") api.current = DiscipleChatMock;
    setCoin((q.get("coin") || "0x0000000000000000000000000000000000000001").toLowerCase());
  }, []);
  useEffect(() => {
    if (!coin) return;
    const add = (m: ChatMsg) => setMsgs((p) => (p.some((x) => x.id === m.id) ? p : [...p, m].slice(-200)));
    api.current.history(coin).then((h) => setMsgs(h));
    return api.current.subscribe(coin, add, { onState: setSt });
  }, [coin]);
  const emo = (t: string) => t.split(/(:[a-z_]+:)/g).map((p, i) => {
    const u = api.current.EMOTES[p.slice(1, -1)];
    // eslint-disable-next-line @next/next/no-img-element
    return u && p.startsWith(":") ? <img key={i} src={u} alt={p} className="inline h-5 w-5" /> : <span key={i}>{p}</span>;
  });
  return (
    <div className="mx-auto max-w-xl p-6 font-mono text-sm">
      <h1 className="mb-2 text-lg">chat debug · {coin.slice(0, 10)}… · <b>{st}</b></h1>
      <div className="h-96 overflow-y-auto rounded border border-white/20 p-2">
        {msgs.map((m) => (
          <div key={m.id} className={m.kind === "event" ? "text-amber-300" : ""}>
            <span className="opacity-50">{new Date(m.ts).toLocaleTimeString()} </span>
            {m.kind === "user" && <b>{m.from?.name || m.from?.addr.slice(0, 8)}{m.from?.badge ? ` [${m.from.badge}]` : ""}: </b>}
            {emo(m.text)}{m.meta?.impactBps != null && <span className="opacity-50"> ({m.meta.impactBps}bps)</span>}
          </div>
        ))}
      </div>
      <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); const r = await api.current.send(coin, text); if (r.ok) { setText(""); setErr(""); } else setErr(r.error + (r.retryAfterMs ? ` (${r.retryAfterMs}ms)` : "")); }}>
        <input className="flex-1 rounded bg-white/10 px-2 py-1" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="say gm :halo:" />
        <button className="rounded bg-amber-400 px-3 text-black">send</button>
      </form>
      {err && <p className="mt-1 text-red-400">{err}</p>}
      <p className="mt-2 opacity-60">{Object.keys(api.current.EMOTES).map((c) => `:${c}:`).join(" ")}</p>
    </div>
  );
}
