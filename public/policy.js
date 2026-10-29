document.getElementById("themeToggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  document.getElementById("themeColor").content = next === "dark" ? "#0c0e12" : "#f7f8fa";
  try { localStorage.setItem("chronicle-theme", next); } catch (_) {}
});
