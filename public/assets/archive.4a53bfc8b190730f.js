const state = { days: [] };

initTheme();
loadIndex();
document.getElementById("searchInput").addEventListener("input", (event) => {
  render(event.target.value);
});

function initTheme() {
  const button = document.getElementById("themeToggle");
  const setLabel = () => {
    const theme = document.documentElement.getAttribute("data-theme") || "light";
    button.textContent = theme === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Switch to ${button.textContent} theme`);
  };
  setLabel();
  button.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    document.getElementById("themeColor").setAttribute("content", next === "dark" ? "#0c0e12" : "#f7f8fa");
    try { localStorage.setItem("chronicle-theme", next); } catch (_) {}
    setLabel();
  });
}

async function loadIndex() {
  try {
    const response = await fetch("./index.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.days = (data.days ?? [])
      .filter((day) => day && typeof day.date === "string")
      .map((day) => ({
        date: day.date,
        count: Number(day.count) || 0,
        title: typeof day.title === "string" ? day.title : "",
        path: typeof day.path === "string" ? day.path : `${day.date}/`,
        parsed: new Date(`${day.date}T00:00:00Z`),
      }))
      .filter((day) => !Number.isNaN(day.parsed.getTime()));
    state.days.sort((a, b) => b.date.localeCompare(a.date));
    renderMeta();
    render();
  } catch (error) {
    document.getElementById("ledeMeta").textContent = "Archive index unavailable.";
    showEmpty("Archive unavailable", "Could not load the archive index. Try again in a minute.");
  }
}

function renderMeta() {
  const meta = document.getElementById("ledeMeta");
  if (!state.days.length) {
    meta.textContent = "No archived days yet.";
    return;
  }
  const newest = state.days[0].date;
  const oldest = state.days[state.days.length - 1].date;
  const total = state.days.reduce((sum, day) => sum + day.count, 0);
  meta.textContent = `${state.days.length} days · ${oldest} → ${newest} · ${total} items`;
}

function render(filterTerm = "") {
  const main = document.getElementById("archiveMain");
  main.replaceChildren();
  if (!state.days.length) return;

  const term = filterTerm.trim().toLowerCase();
  const filtered = term
    ? state.days.filter((day) => {
        const monthName = day.parsed
          .toLocaleDateString(undefined, { month: "long", timeZone: "UTC" })
          .toLowerCase();
        return (
          day.date.includes(term) ||
          monthName.includes(term) ||
          day.title.toLowerCase().includes(term)
        );
      })
    : state.days;

  if (!filtered.length) {
    showEmpty("No days match", "Try a different month name, YYYY-MM-DD, or keyword from a top story.");
    return;
  }

  const groups = new Map();
  for (const day of filtered) {
    const key = monthKey(day.parsed);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(day);
  }

  for (const [, group] of groups) {
    main.append(renderMonth(group));
  }
}

function renderMonth(group) {
  const section = document.createElement("section");
  section.className = "month-section";

  const head = document.createElement("div");
  head.className = "month-head";
  const name = document.createElement("h2");
  name.className = "month-name";
  name.textContent = monthLabel(group[0].parsed);
  const stats = document.createElement("span");
  stats.className = "month-stats";
  const total = group.reduce((sum, day) => sum + day.count, 0);
  stats.textContent = `${group.length} day${group.length === 1 ? "" : "s"} · ${total} items`;
  head.append(name, stats);

  const grid = document.createElement("div");
  grid.className = "day-grid";
  for (const day of group) {
    const cell = document.createElement("a");
    cell.className = "day-cell";
    cell.dataset.weight = weightFor(day.count);
    cell.href = `./${day.date}/`;
    if (day.title) cell.title = day.title;
    const date = document.createElement("span");
    date.className = "day-date";
    date.textContent = dayLabel(day.parsed);
    const count = document.createElement("span");
    count.className = "day-count";
    count.textContent = `${day.count} item${day.count === 1 ? "" : "s"}`;
    cell.append(date, count);
    grid.append(cell);
  }

  section.append(head, grid);
  return section;
}

function showEmpty(title, body) {
  const main = document.getElementById("archiveMain");
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const para = document.createElement("p");
  para.textContent = body;
  wrap.append(heading, para);
  main.replaceChildren(wrap);
}

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(d) {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}
function dayLabel(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", timeZone: "UTC" });
}
function weightFor(count) {
  if (count >= 60) return "high";
  if (count >= 45) return "medium";
  return "low";
}
