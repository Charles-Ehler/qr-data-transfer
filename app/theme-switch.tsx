"use client";

import { useEffect, useState } from "react";

export const THEMES = ["paper", "midnight", "terminal"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "paper";
export const THEME_KEY = "airgap-theme";

const LABELS: Record<Theme, string> = {
  paper: "Paper",
  midnight: "Midnight",
  terminal: "Terminal",
};

function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** Resolve the active theme: ?theme= wins, then the last choice, then default. */
export function resolveTheme(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Private browsing can refuse storage; the default is fine.
  }
  return DEFAULT_THEME;
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    setTheme(resolveTheme());
  }, []);

  const choose = (next: Theme) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Not being able to remember the choice is not worth failing over.
    }
  };

  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {THEMES.map((name) => (
        <button
          key={name}
          type="button"
          className={name === theme ? "active" : ""}
          aria-pressed={name === theme}
          onClick={() => choose(name)}
        >
          {LABELS[name]}
        </button>
      ))}
    </div>
  );
}
