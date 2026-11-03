import { toMin } from "./time.js";
import { GOOGLE_FONTS } from "./google-fonts.js";

export { GOOGLE_FONTS };

export const DEFAULT_APPEARANCE = {
  color: "#6246EA",
  mode: "light",
  font: "Arial",
};

const FONT_SET = new Set(GOOGLE_FONTS);

export function appearanceOf(user) {
  const look = user?.appearance || {};
  const color = /^#[0-9a-fA-F]{6}$/.test(look.color || "") ? look.color.toLowerCase() : DEFAULT_APPEARANCE.color.toLowerCase();
  const mode = look.mode === "dark" || look.mode === "auto" ? look.mode : "light";
  const font = look.font === "Arial" || FONT_SET.has(look.font) ? look.font : "Arial";
  return { color, mode, font };
}

export function isDarkNow(user, nowMin) {
  const { mode } = appearanceOf(user);
  if (mode === "dark") return true;
  if (mode === "light") return false;
  const bed = toMin(user?.routine?.bed || "22:00");
  const wake = toMin(user?.routine?.wake || "07:00");
  if (bed > wake) return nowMin >= bed || nowMin < wake;
  if (bed < wake) return nowMin >= bed && nowMin < wake;
  return nowMin >= 21 * 60 || nowMin < 7 * 60;
}

export function applyAppearance(user, nowMin, override = {}) {
  const look = { ...appearanceOf(user), ...override };
  const dark = isDarkNow({ ...user, appearance: { ...appearanceOf(user), mode: look.mode } }, nowMin);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  const colors = shades(look.color, dark);
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--primary-deep", colors.deep);
  root.style.setProperty("--soft", colors.soft);
  const stack = `"${look.font}", "Avenir Next", "Segoe UI", sans-serif`;
  root.style.setProperty("--font", stack);
  root.style.fontFamily = stack;
  loadGoogleFont(look.font);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#161226" : "#c5daf6");
  return { ...look, dark };
}

export function fillFontList(container, query, current) {
  const needle = String(query || "").trim().toLowerCase();
  const names = needle ? GOOGLE_FONTS.filter((name) => name.toLowerCase().includes(needle)) : GOOGLE_FONTS;
  const selected = names.includes(current) ? current : container.dataset.selected && names.includes(container.dataset.selected) ? container.dataset.selected : "";
  container.dataset.selected = selected;
  const fragment = document.createDocumentFragment();
  for (const name of names) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `font-choice${name === selected ? " on" : ""}`;
    button.dataset.font = name;
    button.textContent = name;
    button.style.fontFamily = `"${name}", sans-serif`;
    fragment.append(button);
  }
  container.replaceChildren(fragment);
  watchFontSamples(container);
  if (names.length <= 24) names.forEach(loadPreviewFont);
}

function watchFontSamples(container) {
  container._fontWatch?.disconnect();
  const watch = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const name = entry.target.dataset.font;
      if (name) loadPreviewFont(name);
      watch.unobserve(entry.target);
    }
  }, { root: container, rootMargin: "160px" });
  container._fontWatch = watch;
  for (const button of container.querySelectorAll("[data-font]")) watch.observe(button);
}

function loadPreviewFont(name) {
  if (!name || !FONT_SET.has(name)) return;
  const id = `ordup-sample-${sampleId(name)}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  const family = encodeURIComponent(name).replace(/%20/g, "+");
  const text = encodeURIComponent(name);
  link.href = `https://fonts.googleapis.com/css2?family=${family}&text=${text}&display=swap`;
  document.head.appendChild(link);
}

function sampleId(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 33 + name.charCodeAt(index)) >>> 0;
  return hash.toString(36);
}

function loadGoogleFont(name) {
  const id = "ordup-user-font";
  if (!name || !FONT_SET.has(name)) {
    document.getElementById(id)?.remove();
    return;
  }
  let link = document.getElementById(id);
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  const family = encodeURIComponent(name).replace(/%20/g, "+");
  const href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  if (link.getAttribute("href") !== href) link.setAttribute("href", href);
}

function shades(hex, dark) {
  const rgb = hexToRgb(hex);
  return {
    primary: hex,
    deep: toHex(mix(rgb, [0, 0, 0], 0.24)),
    soft: toHex(mix(rgb, dark ? [22, 18, 38] : [255, 255, 255], dark ? 0.72 : 0.84)),
  };
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((start) => Number.parseInt(value.slice(start, start + 2), 16));
}

function mix(from, to, amount) {
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount));
}

function toHex(rgb) {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
