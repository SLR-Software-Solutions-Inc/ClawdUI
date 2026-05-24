export type ThemeId =
  | "console"
  | "catppuccin-latte"
  | "catppuccin-frappe"
  | "catppuccin-macchiato"
  | "catppuccin-mocha"
  | "nord";

export type ThemeMeta = {
  id: ThemeId;
  label: string;
  family: "console" | "catppuccin" | "nord";
  contrast: "dark" | "light";
};

export const THEMES: ThemeMeta[] = [
  { id: "console", label: "Console", family: "console", contrast: "dark" },
  { id: "catppuccin-latte", label: "Catppuccin · Latte", family: "catppuccin", contrast: "light" },
  { id: "catppuccin-frappe", label: "Catppuccin · Frappé", family: "catppuccin", contrast: "dark" },
  { id: "catppuccin-macchiato", label: "Catppuccin · Macchiato", family: "catppuccin", contrast: "dark" },
  { id: "catppuccin-mocha", label: "Catppuccin · Mocha", family: "catppuccin", contrast: "dark" },
  { id: "nord", label: "Nord", family: "nord", contrast: "dark" },
];

export const DEFAULT_THEME: ThemeId = "nord";

export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", id);
  const meta = THEMES.find((t) => t.id === id);
  root.style.colorScheme = meta?.contrast === "light" ? "light" : "dark";
}
