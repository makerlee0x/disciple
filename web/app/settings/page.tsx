"use client";

import { useEffect, useState } from "react";
import { SETTINGS_KEYS } from "@/lib/config";

function read(key: string, def = true) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return def;
    return v !== "off";
  } catch {
    return def;
  }
}

function write(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

export default function SettingsPage() {
  const [orbs, setOrbs] = useState(true);
  const [bombs, setBombs] = useState(true);
  const [shake, setShake] = useState(true);

  useEffect(() => {
    setOrbs(read(SETTINGS_KEYS.orbs));
    setBombs(read(SETTINGS_KEYS.bombs));
    setShake(read(SETTINGS_KEYS.shake));
  }, []);

  const Toggle = ({
    label,
    on,
    set,
    keyName,
    flight,
  }: {
    label: string;
    on: boolean;
    set: (v: boolean) => void;
    keyName: string;
    flight?: "setOrbs" | "setBombs" | "setShake";
  }) => (
    <div className="row">
      <span>{label}</span>
      <button
        type="button"
        className="rounded-lg border border-[rgba(255,231,163,.6)] px-3 py-1 text-[#ffe7a3]"
        onClick={() => {
          const next = !on;
          set(next);
          write(keyName, next);
          const f = (
            window as unknown as {
              __flight?: Record<string, (v: boolean) => void>;
            }
          ).__flight;
          if (flight && f?.[flight]) f[flight](next);
        }}
      >
        {on ? "ON" : "OFF"}
      </button>
    </div>
  );

  return (
    <div className="page-shell">
      <h1>Settings</h1>
      <div className="sub">PREFERENCES · SAVED TO LOCALSTORAGE</div>
      <div className="card">
        <Toggle
          label="Orbs layer"
          on={orbs}
          set={setOrbs}
          keyName={SETTINGS_KEYS.orbs}
          flight="setOrbs"
        />
        <Toggle
          label="Sell bombs"
          on={bombs}
          set={setBombs}
          keyName={SETTINGS_KEYS.bombs}
          flight="setBombs"
        />
        <Toggle
          label="Camera shake"
          on={shake}
          set={setShake}
          keyName={SETTINGS_KEYS.shake}
          flight="setShake"
        />
        <div className="row">
          <span>Shortcut</span>
          <span>O orbs · B bombs in flight</span>
        </div>
        <div className="row">
          <span>Replay</span>
          <span>add ?replay=1 on a coin URL</span>
        </div>
        <p className="note">
          Keys: disciple.orbs / disciple.bombs / disciple.shake
        </p>
      </div>
    </div>
  );
}
