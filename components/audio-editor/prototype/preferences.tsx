"use client";
/**
 * Adapted from prototype/components/research/preferences.tsx.
 * The original preferences provider modified document.documentElement and
 * localStorage for the entire old application. This new shared workbench must
 * NOT change the global theme of AudioLab 2.0 or interfere with other pages.
 * Therefore the controls remain visually/behaviorally identical, but their
 * language/theme state is deliberately scoped to this grounding instance.
 */
import { createContext, useContext, useState } from "react";
const Preferences = createContext({
  language: "en",
  setLanguage: (_value: string) => {},
  theme: "light",
  setTheme: (_value: string) => {},
});
export const usePreferences = () => useContext(Preferences);
export function PreferencesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [language, setLanguage] = useState("en");
  const [theme, setTheme] = useState("light");
  return (
    <Preferences.Provider value={{ language, setLanguage, theme, setTheme }}>
      <div
        data-theme={theme === "system" ? "light" : theme}
        className="r-preference-scope"
      >
        {children}
      </div>
    </Preferences.Provider>
  );
}
export function PreferenceControls() {
  const p = usePreferences();
  return (
    <div className="r-preferences">
      <select
        aria-label="Instruction language"
        value={p.language}
        onChange={(e) => p.setLanguage(e.target.value)}
      >
        <option value="en">English</option>
        <option value="th">ไทย</option>
      </select>
      <select
        aria-label="Colour theme"
        value={p.theme}
        onChange={(e) => p.setTheme(e.target.value)}
      >
        <option value="system">◐ System</option>
        <option value="light">☀ Light</option>
        <option value="dark">☾ Dark</option>
      </select>
    </div>
  );
}
