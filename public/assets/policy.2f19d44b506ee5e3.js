const root = document.documentElement;
const toggle = document.getElementById("themeToggle");

function setTheme(next) {
  root.dataset.theme = next;
  document.getElementById("themeColor").content = next === "dark" ? "#0c0e12" : "#f7f8fa";
  try { localStorage.setItem("chronicle-theme", next); } catch (_) {}
}

// Same radial reveal from the toggle as the homepage (app.js).
toggle.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  if (!root.classList.contains("motion") || typeof document.startViewTransition !== "function") return setTheme(next);
  const rect = toggle.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  root.style.setProperty("--vt-origin-x", `${x}px`);
  root.style.setProperty("--vt-origin-y", `${y}px`);
  root.style.setProperty("--vt-end-radius", `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  root.classList.add("is-theme-switch");
  document.startViewTransition(() => setTheme(next)).finished.finally(() => root.classList.remove("is-theme-switch"));
});

// Play each [data-motion] block once, when it is a quarter visible.
if (root.classList.contains("motion")) {
  const reveal = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-in");
      reveal.unobserve(entry.target);
    }
  }, { threshold: 0.25 });
  document.querySelectorAll("[data-motion]").forEach((block) => reveal.observe(block));
}
