// Panel finish: system (follows the OS light/dark setting), sun = silver, moon = black.
// Loaded as a classic script in <head> so the finish applies before first paint; the button is
// wired by delegation because the body does not exist yet.
const root = document.documentElement;
const dark = matchMedia("(prefers-color-scheme: dark)");
const modes = ["system", "light", "dark"];
const labels = { system: "Panel finish: system", light: "Panel finish: silver", dark: "Panel finish: black" };

let mode = "system";
try { mode = modes.includes(localStorage.getItem("panel")) ? localStorage.getItem("panel") : "system"; } catch {}

function apply() {
  const black = mode === "dark" || (mode === "system" && dark.matches);
  root.dataset.panel = black ? "black" : "silver";
  root.dataset.panelMode = mode;
  const btn = document.getElementById("btn-panel");
  btn?.setAttribute("aria-label", labels[mode]);
  btn?.setAttribute("title", labels[mode]);
}

apply();
dark.addEventListener("change", apply);
document.addEventListener("DOMContentLoaded", apply);
document.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-panel")) return;
  mode = modes[(modes.indexOf(mode) + 1) % modes.length];
  try { localStorage.setItem("panel", mode); } catch {}
  apply();
});
