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

export default function SettingsPanel() {
  const [orbs, setOrbs] = useState(true);
  const [bombs, setBombs] = useState(true);

  useEffect(() => {
    setOrbs(read(SETTINGS_KEYS.orbs));
    setBombs(read(SETTINGS_KEYS.bombs));
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
    <section id="settings" className="chart-card">
      <h3>Settings</h3>
      <div className="muted tiny">Preferences · saved in this browser</div>
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
        <div className="row">
          <span>Shortcut</span>
          <span>O orbs · B bombs in flight</span>
        </div>
        <div className="row">
          <span>Replay</span>
          <span>add ?replay=1 on a rocket URL</span>
        </div>
        <p className="note">
          Keys: disciple.orbs / disciple.bombs (camera shake removed)
        </p>
      </div>
    </section>
  );
}
