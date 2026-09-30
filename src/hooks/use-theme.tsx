import { useCallback, useEffect, useState } from "react";

type Theme = "dark" | "light";

/**
 * Hook to manage theme (dark/light) with localStorage persistence.
 * Default is "dark" (BPS blue identity).
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("bps-theme") as Theme | null;
    const initial = stored ?? "dark";
    setThemeState(initial);
    applyTheme(initial);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem("bps-theme", t);
    applyTheme(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}

function applyTheme(t: Theme) {
  const html = document.documentElement;
  if (t === "dark") {
    html.classList.add("dark");
    html.classList.remove("light");
  } else {
    html.classList.add("light");
    html.classList.remove("dark");
  }
}
