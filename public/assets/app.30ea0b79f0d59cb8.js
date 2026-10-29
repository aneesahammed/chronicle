
const KIND_LABELS = {
  paper: "papers",
  model_release: "models",
  company_announcement: "announcements",
  tutorial: "tutorials",
  opinion: "opinion",
  discussion: "discussion",
  tool: "tools",
  repo_release: "repo releases",
  repo_trending: "trending repos",
  video: "videos",
  course: "courses",
  news: "news",
  unknown: "other",
};
const FEEDS = {
  main: {
    label: "Signal",
    path: "feed.json",
    countLabel: "items",
    lede: "The latest in AI, clustered and ranked. Repeated hype gets pushed down so the actual signal stays up top.",
  },
  repo: {
    label: "Repos",
    path: "repos.json",
    countLabel: "items",
    lede: "AI projects from GitHub Trending and selected stable releases, with source evidence and original dates.",
  },
  learning: {
    label: "Learning",
    path: "learning.json",
    countLabel: "resources",
    lede: "Recent tutorials and a curated library of foundational courses, with prerequisites and honest compatibility notes.",
  },
};
const NOVELTY_TOP = 0.7;
const MS_PER_HOUR = 36e5;
const MS_PER_DAY = 86400000;
const PROGRESS_TTL_MS = 7 * MS_PER_DAY;
const MAX_PROGRESS_ENTRIES = 14;
const FEED_CACHE_TTL_MS = 5 * 60 * 1000;
const IMAGE_HYDRATE_BATCH = 6;
const IMAGE_HYDRATE_ROOT_MARGIN = "640px 0px";
const MATERIAL_SOURCE_FAILURE_RATIO = 0.10;
const DATE_PATH_MATCH = location.pathname.match(/\/daily\/(\d{4}-\d{2}-\d{2})\/?$/);
const ROOT_PREFIX = DATE_PATH_MATCH
  ? "../../"
  : /\/daily\/?$/.test(location.pathname)
    ? "../"
    : "./";
const MOBILE_READER_QUERY = "(max-width: 720px)";
const READER_HELPERS = window.ChronicleReaderState || null;
const READER_VISIBILITY_THRESHOLDS = Array.from({ length: 21 }, (_, index) => index / 20);

const state = {
  data: null,
  readerMode: "deck",
  learningTrack: "new",
  archiveDate: null,
  kinds: new Set(),
  highNovelty: false,
  discussionOnly: false,
  activeFeed: "main",
  resumePromptDay: null,
  scrollTicking: false,
  loadSeq: 0,
  feedCache: new Map(),
  feedRequests: new Map(),
  feedImageObserver: null,
  feedImageTimer: 0,
  gestureLock: null,
  reader: {
    media: null,
    active: false,
    index: 0,
    items: [],
    itemKey: "",
    sheetOpen: false,
    scrollTicking: false,
    syncingScroll: false,
    scrollReleaseTimer: 0,
    motionFrame: 0,
    observer: null,
    visibility: new Map(),
  },
};

initTheme();
initDetailMode();
initFiltersFromUrl();
wireFeedTabs();
wireStickyNav();
wireFilterControls();
wireRefreshControl();
wireReadingControls();
wirePullToRefresh();
wireMobileReader();
updateLedeText();
document.getElementById("archiveCtaButton").href = rootUrl("daily/");
document.getElementById("homeLink").href = rootUrl("");
pruneReadingProgress();
try { state.readerMode = localStorage.getItem("chronicle-reader-mode") === "list" ? "list" : "deck"; } catch (_) {}
const modeButton = document.getElementById("readerMode");
function updateReaderModeButton() {
  const label = state.readerMode === "deck" ? "Switch to compact list" : "Switch to card reader";
  modeButton.setAttribute("aria-label", label);
  modeButton.title = label;
  modeButton.dataset.view = state.readerMode;
  const shape = state.readerMode === "deck"
    ? '<path d="M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1"/>'
    : '<rect x="5" y="6" width="14" height="15" rx="2"/><path d="M8 3h8M9 10h6M9 14h6"/>';
  modeButton.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${shape}</svg>`;
}
modeButton.addEventListener("click", () => {
  state.readerMode = state.readerMode === "deck" ? "list" : "deck";
  try { localStorage.setItem("chronicle-reader-mode", state.readerMode); } catch (_) {}
  updateReaderModeButton();
  if (state.data) renderFeed();
});
updateReaderModeButton();
const bootstrap = JSON.parse(document.getElementById("feedBootstrap")?.textContent || "null");
queueMicrotask(() => {
if (bootstrap && state.activeFeed === "main") {
  state.data = bootstrap;
  state.feedCache.set(feedUrl(), { data: bootstrap, ts: Date.now() });
  updateStatus(); renderArchiveBanner(); renderFilterShell(); prefetchSectionCounts();
  if (shouldUseMobileReader() || state.kinds.size || state.highNovelty || state.discussionOnly) renderFeed();
  else scheduleFeedImageHydration(document.getElementById("feed"));
} else loadFeed().finally(prefetchSectionCounts);
});

function initTheme() {
  const button = document.getElementById("themeToggle");
  const root = document.documentElement;
  const meta = document.getElementById("themeColor");

  const setAriaLabel = () => {
    const theme = root.getAttribute("data-theme") || "light";
    const next = theme === "dark" ? "light" : "dark";
    button.setAttribute("aria-label", `Switch to ${next} theme`);
  };
  setAriaLabel();

  const commitTheme = (next) => {
    root.setAttribute("data-theme", next);
    if (meta) meta.setAttribute("content", next === "dark" ? "#0c0e12" : "#f7f8fa");
    try { localStorage.setItem("chronicle-theme", next); } catch (_) {}
    setAriaLabel();
  };

  button.addEventListener("click", () => {
    const current = root.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";

    // Capture button center so the radial reveal emanates from the icon
    // itself — feels causal, like the click spread the theme outward.
    const rect = button.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    root.style.setProperty("--vt-origin-x", originX + "px");
    root.style.setProperty("--vt-origin-y", originY + "px");
    const maxDx = Math.max(originX, window.innerWidth - originX);
    const maxDy = Math.max(originY, window.innerHeight - originY);
    root.style.setProperty("--vt-end-radius", Math.hypot(maxDx, maxDy) + "px");

    const reduceMotion =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!reduceMotion && typeof document.startViewTransition === "function") {
      document.startViewTransition(() => commitTheme(next));
    } else {
      commitTheme(next);
    }
  });
}

function initDetailMode() {
  const params = new URLSearchParams(location.search);
  if (params.get("detail") === "1") document.body.classList.add("is-detail");
}

function wireFilterControls() {
  document.getElementById("noveltyChip").addEventListener("click", () => {
    state.highNovelty = !state.highNovelty;
    syncUrl();
    renderFilterShell();
    renderFeed();
  });
  document.getElementById("discussionChip").addEventListener("click", () => {
    state.discussionOnly = !state.discussionOnly;
    syncUrl();
    renderFilterShell();
    renderFeed();
  });
  document.getElementById("resetFilters").addEventListener("click", () => {
    state.kinds.clear();
    state.highNovelty = false;
    state.discussionOnly = false;
    syncUrl();
    renderFilterShell();
    renderFeed();
  });
  document.getElementById("exitArchive").addEventListener("click", () => {
    state.archiveDate = null;
    state.activeFeed = "main";
    state.resumePromptDay = null;
    hideResumePrompt();
    syncUrl();
    syncFeedTabs();
    loadFeed();
  });
}

function wireRefreshControl() {
  document.getElementById("refreshButton").addEventListener("click", async () => {
    await loadFeed({ force: true });
  });
}

function wireFeedTabs() {
  const tabs = [...document.querySelectorAll("[data-feed-tab]")];
  tabs.forEach((button) => {
    button.addEventListener("click", () => switchFeedTab(button.dataset.feedTab));
    button.addEventListener("keydown", (event) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      const current = tabs.indexOf(button);
      const nextIndex =
        event.key === "Home" ? 0 :
        event.key === "End" ? tabs.length - 1 :
        event.key === "ArrowLeft" ? (current - 1 + tabs.length) % tabs.length :
        (current + 1) % tabs.length;
      tabs[nextIndex].focus();
      switchFeedTab(tabs[nextIndex].dataset.feedTab);
    });
  });
  syncFeedTabs();
  window.addEventListener("resize", positionTabIndicator);
  // Re-measure after webfonts load — cell widths can shift slightly,
  // moving the indicator off-center if we only measured pre-font-load.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(positionTabIndicator).catch(() => {});
  }
}

function wireStickyNav() {
  const nav = document.querySelector(".section-nav");
  if (!nav || typeof IntersectionObserver !== "function") return;
  // Watch when the nav clips its top pixel against the viewport — that
  // is the moment sticky has docked the element. threshold:[1] fires
  // whenever intersectionRatio crosses fully-visible vs. partially-
  // clipped, which is exactly the docked / undocked transition.
  const observer = new IntersectionObserver(
    ([entry]) => {
      nav.classList.toggle("is-stuck", entry.intersectionRatio < 1);
    },
    { threshold: [1] },
  );
  observer.observe(nav);
}

async function switchFeedTab(next) {
  if (!FEEDS[next] || state.activeFeed === next) return;
  state.activeFeed = next;
  state.kinds.clear();
  state.highNovelty = false;
  state.discussionOnly = false;
  hideResumePrompt();
  clearReadingProgress();
  syncUrl();
  syncFeedTabs();
  updateLedeText();

  const feed = document.getElementById("feed");
  const reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (!reduceMotion && feed) feed.classList.add("is-switching");

  await loadFeed();
  if (feed) requestAnimationFrame(() => feed.classList.remove("is-switching"));
  if (state.reader.active) {
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  } else {
    scrollToTop();
  }
}

function syncFeedTabs() {
  document.querySelectorAll("[data-feed-tab]").forEach((button) => {
    const selected = button.dataset.feedTab === state.activeFeed;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const feed = document.getElementById("feed");
  const active = document.querySelector('[data-feed-tab][aria-selected="true"]');
  if (feed && active?.id) feed.setAttribute("aria-labelledby", active.id);
  positionTabIndicator();
}

function positionTabIndicator() {
  const indicator = document.querySelector(".section-nav-indicator");
  if (!indicator) return;
  const active = document.querySelector('[data-feed-tab][aria-selected="true"]');
  if (!active || !active.parentElement) return;
  const navRect = active.parentElement.getBoundingClientRect();
  const cellRect = active.getBoundingClientRect();
  const width = 56;
  const x = cellRect.left - navRect.left + (cellRect.width - width) / 2;
  indicator.style.transform = `translateX(${x}px)`;
  indicator.style.width = `${width}px`;
  if (indicator.classList.contains("is-pristine")) {
    // Drop pristine on the next frame so the just-applied transform
    // doesn't animate from translateX(0) on first paint.
    requestAnimationFrame(() => indicator.classList.remove("is-pristine"));
  }
}

function updateLedeText() {
  const node = document.getElementById("ledeText");
  if (!node) return;
  const feed = FEEDS[state.activeFeed] ?? FEEDS.main;
  node.textContent = feed.lede;
}

function updateSectionCount(role, count) {
  const node = document.querySelector(`[data-section-count="${role}"]`);
  if (!node) return;
  if (count == null || !Number.isFinite(count)) {
    node.textContent = "";
    return;
  }
  const label = FEEDS[role]?.countLabel ?? "items";
  node.textContent = `${count} ${label}`;
}

function prefetchSectionCounts() {
  for (const [role, count] of Object.entries(state.data?.section_counts ?? {})) updateSectionCount(role, count);
}

function wireReadingControls() {
  document.getElementById("topJump").addEventListener("click", () => scrollToTop());
  document.getElementById("resumeReading").addEventListener("click", () => {
    const prompt = document.getElementById("resumePrompt");
    if (state.reader.active && prompt.dataset.readerIndex) {
      const index = Number(prompt.dataset.readerIndex);
      hideResumePrompt();
      setReaderIndex(index, { focus: true, jumpcut: true });
      return;
    }
    const y = Number(prompt.dataset.resumeY || 0);
    hideResumePrompt();
    window.scrollTo({ top: y, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  });
  window.addEventListener("scroll", onReadingScroll, { passive: true });
}

function wireMobileReader() {
  if (typeof matchMedia === "function") {
    state.reader.media = matchMedia(MOBILE_READER_QUERY);
    const rerender = () => {
      updateReaderViewportHeight();
      if (state.data) renderFeed();
    };
    if (typeof state.reader.media.addEventListener === "function") {
      state.reader.media.addEventListener("change", rerender);
    } else if (typeof state.reader.media.addListener === "function") {
      state.reader.media.addListener(rerender);
    }
  }

  updateReaderViewportHeight();
  window.addEventListener("resize", updateReaderViewportHeight, { passive: true });
  window.addEventListener("orientationchange", updateReaderViewportHeight, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateReaderViewportHeight, { passive: true });
  }
  window.addEventListener("beforeunload", saveReaderProgress);
}

function onReadingScroll() {
  if (state.scrollTicking) return;
  state.scrollTicking = true;
  requestAnimationFrame(() => {
    state.scrollTicking = false;
    updateTopJump();
    saveReadingProgress();
    if (window.scrollY > 160) hideResumePrompt();
  });
}

function wirePullToRefresh() {
  if (typeof matchMedia !== "function" || !matchMedia("(pointer: coarse)").matches) return;
  const indicator = document.getElementById("ptr");
  const label = document.getElementById("ptrLabel");
  if (!indicator || !label) return;

  const TRIGGER_PX = 72;
  const MAX_PULL_PX = 120;
  const DAMPING = 0.55;
  const COMMIT_PX = 8;
  const ANIM_MS = 240;
  const SPIN_MIN_MS = 320;

  let activeId = null;
  let startX = 0;
  let startY = 0;
  let pulling = false;
  let pullDistance = 0;
  let refreshing = false;
  let startedInReader = false;

  function applyVisual(distance) {
    const eased = Math.min(distance, MAX_PULL_PX);
    const offset = eased - 64;
    indicator.style.transform = `translate3d(0, ${offset}px, 0)`;
    const rot = Math.min(180, (distance / TRIGGER_PX) * 180);
    indicator.style.setProperty("--ptr-rot", `${rot}deg`);
    label.textContent = distance >= TRIGGER_PX ? "release to refresh" : "pull to refresh";
  }

  function resetIndicator(animate) {
    if (animate) indicator.classList.add("is-animating");
    indicator.classList.remove("is-active");
    indicator.style.transform = "translate3d(0, -100%, 0)";
    indicator.style.setProperty("--ptr-rot", "0deg");
    if (animate) {
      window.setTimeout(() => indicator.classList.remove("is-animating"), ANIM_MS);
    } else {
      indicator.classList.remove("is-animating");
    }
  }

  async function trigger() {
    refreshing = true;
    indicator.classList.add("is-active", "is-refreshing", "is-animating");
    indicator.style.transform = "translate3d(0, 0, 0)";
    label.textContent = "refreshing…";
    const startedAt = Date.now();
    try {
      await loadFeed({ force: true });
    } finally {
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, SPIN_MIN_MS - elapsed);
      window.setTimeout(() => {
        indicator.classList.remove("is-refreshing");
        resetIndicator(true);
        refreshing = false;
      }, wait);
    }
  }

  document.addEventListener("touchstart", (event) => {
    if (refreshing) return;
    if (window.scrollY > 0) return;
    if (event.touches.length !== 1) return;
    startedInReader = Boolean(event.target?.closest?.("#mobileReader"));
    if (event.target?.closest?.("#readerIndexSheet")) return;
    if (startedInReader && (!state.reader.active || state.reader.index > 0 || Number(document.getElementById("readerDeck")?.scrollTop || 0) > 1)) return;
    const touch = event.touches[0];
    activeId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    pulling = false;
    pullDistance = 0;
    indicator.classList.remove("is-animating");
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (refreshing || activeId === null) return;
    let touch = null;
    for (const candidate of event.touches) {
      if (candidate.identifier === activeId) { touch = candidate; break; }
    }
    if (!touch) return;
    const dy = touch.clientY - startY;
    const dx = touch.clientX - startX;

    if (!pulling) {
      if (dy <= 0 || window.scrollY > 0) { activeId = null; return; }
      if (Math.abs(dx) > Math.abs(dy)) { activeId = null; return; }
      if (startedInReader && Number(document.getElementById("readerDeck")?.scrollTop || 0) > 1) { activeId = null; return; }
      if (dy < COMMIT_PX) return;
      if (startedInReader && state.gestureLock?.owner === "reader") { activeId = null; return; }
      if (startedInReader) lockGesture("ptr");
      pulling = true;
      indicator.classList.add("is-active");
    }
    if (window.scrollY > 0) {
      resetIndicator(false);
      activeId = null;
      pulling = false;
      return;
    }
    if (event.cancelable) event.preventDefault();
    pullDistance = dy < TRIGGER_PX ? dy : TRIGGER_PX + (dy - TRIGGER_PX) * DAMPING;
    applyVisual(pullDistance);
  }, { passive: false });

  function endTouch() {
    if (refreshing || activeId === null) return;
    if (!pulling) { activeId = null; return; }
    indicator.classList.add("is-animating");
    if (pullDistance >= TRIGGER_PX) {
      trigger();
    } else {
      resetIndicator(true);
    }
    activeId = null;
    startedInReader = false;
    pulling = false;
    pullDistance = 0;
    releaseGesture("ptr");
  }

  document.addEventListener("touchend", endTouch, { passive: true });
  document.addEventListener("touchcancel", endTouch, { passive: true });
}

async function fetchFeedData(url, options = {}) {
  const cached = state.feedCache.get(url);
  const now = Date.now();
  if (!options.force && cached && now - cached.ts < FEED_CACHE_TTL_MS) {
    return cached.data;
  }
  if (!options.force && state.feedRequests.has(url)) {
    return state.feedRequests.get(url);
  }
  const request = fetch(url, { cache: options.force ? "reload" : "no-cache" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.feedCache.set(url, { data, ts: Date.now() });
      return data;
    })
    .finally(() => state.feedRequests.delete(url));
  state.feedRequests.set(url, request);
  return request;
}

async function loadFeed(options = {}) {
  const seq = ++state.loadSeq;
  const url = feedUrl();
  try {
    const data = await fetchFeedData(url, options);
    if (seq !== state.loadSeq) return;
    state.data = data;
    updateSectionCount(state.activeFeed, state.data?.count);
    updateStatus();
    renderTopNews();
    renderArchiveBanner();
    renderFilterShell();
    renderFeed();
  } catch (error) {
    if (seq !== state.loadSeq) return;
    disableMobileReader();
    showNotice(`Chronicle could not load the feed: ${error.message}`);
    document.getElementById("statusText").textContent = "feed unavailable";
    document.getElementById("statusLine").classList.add("is-failed");
    document.getElementById("topNews").hidden = true;
    document.getElementById("topNewsGrid").replaceChildren();
    document.getElementById("feed").replaceChildren(emptyState("Feed unavailable", "The static feed could not be loaded. Try refreshing in a minute."));
    document.getElementById("healthStrip").textContent = "feed unavailable";
  }
}

function renderTopNews() {
  const section = document.getElementById("topNews");
  const grid = document.getElementById("topNewsGrid");
  if (state.activeFeed !== "main") {
    section.hidden = true;
    grid.replaceChildren();
    return;
  }
  const items = Array.isArray(state.data?.top_news) ? state.data.top_news.filter(isUsableTopNews) : [];
  if (!items.length) {
    section.hidden = true;
    grid.replaceChildren();
    return;
  }

  const lead = renderTopStory(items[0]);
  const rest = node("div", "top-list");
  items.slice(1).forEach((item) => rest.appendChild(renderTopRow(item)));
  grid.replaceChildren(lead, rest);
  section.hidden = false;
}

function isUsableTopNews(item) {
  return item
    && typeof item.title === "string"
    && typeof item.url === "string"
    && safeHttpsUrl(item.url)
    && typeof item.dek === "string"
    && typeof item.brief === "string";
}

function renderTopStory(item) {
  const article = node("article", "top-story");
  // Top News image rendering is intentionally disabled while we evaluate
  // whether images fit Chronicle's feed-first layout.
  const image = null;

  const body = node("div", "top-story-body");
  const title = node("h2", "top-story-title");
  title.appendChild(link(item.url, decodeText(item.title)));
  body.append(title);
  body.append(node("p", "top-story-dek", decodeText(item.dek)));
  if (item.brief && isDistinctExpansion(item.brief, item.dek)) {
    body.append(node("p", "top-story-brief", decodeText(item.brief)));
  }
  body.append(renderTopNewsMeta(item));
  article.append(body);
  if (image) article.append(image);
  return article;
}

function renderTopRow(item) {
  const row = node("article", "top-row");
  // Keep image data in the feed/cache, but do not render thumbnails yet.
  const image = null;
  const body = node("div", "top-row-body");
  const title = node("h3", "top-row-title");
  title.appendChild(link(item.url, decodeText(item.title)));
  body.append(title);
  body.append(node("p", "top-row-dek", decodeText(item.dek)));
  body.append(renderTopNewsMeta(item));
  row.append(body);
  if (image) row.append(image);
  return row;
}

function renderTopNewsMeta(item) {
  const meta = node("div", "top-news-meta");
  meta.append(sourceLabel(item));
  meta.append(sep(), document.createTextNode(relTime(parseDate(item.published_at)) || "unknown"));
  if (item.kind && item.kind !== "unknown") meta.append(sep(), document.createTextNode(KIND_LABELS[item.kind] || item.kind));
  const score = Number(item.score);
  meta.append(sep(), document.createTextNode(item.summary_method === "extractive" ? `source excerpt · checked ${relTime(parseDate(item.enriched_at))}` : item.summary_method === "source_metadata" ? "source metadata" : "legacy automated brief"));
  return meta;
}

function topNewsImage(item, className) {
  const src = safeImageUrl(item.image_url);
  if (!src) return null;
  const img = document.createElement("img");
  img.className = className;
  img.src = src;
  img.alt = item.image_alt || imageAltText(item);
  img.width = className === "top-story-image" ? 800 : 220;
  img.height = className === "top-story-image" ? 500 : 220;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  try { img.fetchPriority = "low"; } catch (_) {}
  img.addEventListener("error", () => {
    img.remove();
  }, { once: true });
  return img;
}

function safeImageUrl(value) {
  return safeHttpsUrl(value);
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch (_) {
    return "";
  }
}

function updateStatus() {
  const data = state.data;
  const generated = parseDate(data.last_successful_generated_at ?? data.generated_at);
  const ageHours = generated ? (Date.now() - generated.getTime()) / MS_PER_HOUR : Infinity;
  const stale = ageHours > 30;
  const sourceTotal = Number(data.source_total ?? 0);
  const sourceOk = Number(data.source_ok ?? sourceTotal);
  const sourceFailed = Number(data.source_failed ?? 0);
  const failedSources = Array.isArray(data.failed_sources) ? data.failed_sources : [];
  const mode = String(data.classification_mode ?? "fallback");
  const status = String(data.refresh_status ?? "ok");

  // Top status line
  const statusLine = document.getElementById("statusLine");
  const statusText = document.getElementById("statusText");
  statusLine.classList.remove("is-stale", "is-failed");
  if (status === "failed") statusLine.classList.add("is-failed");
  else if (stale) statusLine.classList.add("is-stale");
  const updatedRel = generated ? relTime(generated, true) : "unknown";
  const count = data.count ?? data.clusters?.length ?? 0;
  const statusParts = [`${count} ${itemCountLabel(count)}`, `updated ${updatedRel}`];
  if (status === "failed") statusParts.push("refresh failed");
  else if (sourceFailed > 0) statusParts.push(sourceSkipSummary(sourceFailed));
  statusText.textContent = statusParts.join(" · ");

  // Footer health strip — DOM-built, no innerHTML
  const health = document.getElementById("healthStrip");
  const evergreenCount = (data.clusters || []).filter(item => item.primary?.learning?.track === "foundations").length;
  const sourceFrag = sourceTotal ? `${sourceOk}/${sourceTotal} reachable · ${(data.source_health || []).filter(source => source.fresh_count > 0).length} contributed fresh items` : "sources unknown";
  const tail = [];
  const assessments = data.classification_counts;
  if (assessments) tail.push(`${assessments.llm || 0} model · ${assessments.deterministic || 0} rules · ${assessments.fallback || 0} fallback assessments`);
  if (mode !== "llm" && state.activeFeed === "main") tail.push(`classify ${mode}`);
  tail.push(state.activeFeed === "learning" ? `new lessons window ${data.window_hours ?? 720}h · ${evergreenCount} evergreen courses` : `window ${data.window_hours ?? 36}h`);
  const healthNodes = [Object.assign(document.createElement("strong"), { textContent: sourceFrag })];
  if (sourceFailed > 0) {
    healthNodes.push(document.createTextNode(" · "), sourceFailureDetails({
      failedSources,
      sourceFailed,
      sourceOk,
      sourceTotal,
    }));
  }
  if (tail.length) healthNodes.push(document.createTextNode(` · ${tail.join(" · ")}`));
  health.replaceChildren(...healthNodes);

  // Notice — only material problems
  const notices = [];
  if (status === "failed") notices.push("Latest refresh failed — showing the last successful feed.");
  else if (hasMaterialSourceFailure({ status, sourceFailed, sourceTotal })) {
    notices.push(`${sourceSkipSummary(sourceFailed)} during refresh. Feed refreshed from ${sourceOk}/${sourceTotal} sources.`);
  }
  if (stale) notices.push("This feed is older than 30 hours.");
  if (["partial", "fallback"].includes(mode) && state.activeFeed === "main") notices.push("Some items use fallback rules because model results were unavailable or invalid.");
  if (notices.length) showNotice(notices.join(" "));
  else clearNotice();
}

function sourceSkipSummary(count) {
  return `${count} source${count === 1 ? "" : "s"} skipped`;
}

function itemCountLabel(count) {
  return count === 1 ? "item" : "items";
}

function sourceFailureDetails({ failedSources, sourceFailed, sourceOk, sourceTotal }) {
  const details = document.createElement("details");
  details.className = "source-details";
  details.append(Object.assign(document.createElement("summary"), {
    textContent: sourceSkipSummary(sourceFailed),
  }));

  const body = node("span", "source-details-body");
  body.append(Object.assign(document.createElement("span"), {
    className: "source-details-context",
    textContent: `Feed refreshed from ${sourceOk}/${sourceTotal || "unknown"} sources.`,
  }));
  const list = node("span", "source-details-list");
  const sources = failedSources.length
    ? failedSources
    : [{ name: sourceSkipSummary(sourceFailed), message: "" }];
  sources.forEach((source) => {
    const item = node("span", "source-details-row");
    const name = source?.name || source?.id || "Unknown source";
    item.append(Object.assign(document.createElement("strong"), { textContent: name }));
    const message = compactErrorMessage(source?.message);
    if (message) item.append(document.createTextNode(`: ${message}`));
    list.append(item);
  });
  body.append(list);
  details.append(body);
  return details;
}

function compactErrorMessage(message) {
  const text = String(message || "");
  const http = text.match(/HTTP\s+(\d{3})/);
  if (http) return `HTTP ${http[1]}${http[1] === "403" ? " / access denied" : ""}`;
  if (/xml|rss|entity|feed not recognized/i.test(text)) return "Invalid feed format";
  if (/timeout|abort/i.test(text)) return "Request timed out";
  return text.includes("<") ? "Source request failed" : text.replace(/\s+/g, " ").slice(0, 120);
}

function hasMaterialSourceFailure({ status, sourceFailed, sourceTotal }) {
  if (status !== "partial" || sourceFailed <= 0 || sourceTotal <= 0) return false;
  return sourceFailed / sourceTotal >= MATERIAL_SOURCE_FAILURE_RATIO;
}

function renderArchiveBanner() {
  const banner = document.getElementById("archiveBanner");
  const label = document.getElementById("archiveDateLabel");
  if (!state.archiveDate) {
    banner.hidden = true;
    return;
  }
  label.textContent = formatRelativeDay(state.archiveDate);
  banner.hidden = false;
}

function formatRelativeDay(isoDate) {
  if (!isoDate) return "today";
  const target = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(target.getTime())) return isoDate;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetUtc = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  const days = Math.round((todayUtc - targetUtc) / MS_PER_DAY);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days >= 2 && days <= 6) return `${days} days ago`;
  return target.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function inLearningTrack(item) {
  return state.activeFeed !== "learning" || (item.primary?.learning?.track === "foundations" ? "foundations" : "new") === state.learningTrack;
}

function renderLearningTracks() {
  const container = document.getElementById("learningTracks");
  if (!container) return;
  container.hidden = state.activeFeed !== "learning";
  if (container.hidden) return;
  container.replaceChildren(...[["new", "New lessons"], ["foundations", "Foundations"]].map(([track, label]) => {
    const count = (state.data?.clusters || []).filter(item => (item.primary?.learning?.track === "foundations" ? "foundations" : "new") === track).length;
    const button = node("button", "learning-track", `${label} · ${count}`);
    button.type = "button";
    button.setAttribute("aria-pressed", String(track === state.learningTrack));
    button.addEventListener("click", () => {
      if (state.learningTrack === track) return;
      saveReaderProgress();
      state.learningTrack = track;
      state.kinds.clear(); state.highNovelty = false; state.discussionOnly = false;
      state.resumePromptDay = null;
      syncUrl(); renderFilterShell(); renderFeed();
      container.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    });
    return button;
  }));
}

function itemDateLabel(item) {
  if (item.primary?.learning?.track === "foundations") return item.primary.learning.publication_label || "Publication date not stated";
  return relTime(parseDate(item.primary?.published_at)) || "unknown";
}

function foundationFacts(item) {
  const learning = item.primary?.learning;
  if (learning?.track !== "foundations") return null;
  const facts = node("dl", "course-facts");
  const reviewed = learning.reviewed_at || "Not reviewed";
  const due = Date.now() - Date.parse(reviewed) > 90 * MS_PER_DAY ? " · review due" : "";
  for (const [label, text] of [
    ["Level", learning.level], ["Prerequisites", learning.prerequisites], ["Cost", learning.cost],
    ["Syllabus reviewed", reviewed + due], ["Code compatibility", learning.compatibility],
  ]) {
    if (text) facts.append(node("dt", "", label), node("dd", "", text));
  }
  return facts;
}

function renderFilterShell() {
  renderLearningTracks();
  const data = state.data;
  if (!data) return;

  const container = document.getElementById("kindFilters");
  // Drop existing chips, keep label
  container.querySelectorAll(".chip").forEach((node) => node.remove());

  const counts = new Map();
  for (const item of (data.clusters ?? []).filter(inLearningTrack)) {
    const k = item.kind || "unknown";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const kinds = [...counts.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  for (const value of kinds) {
    container.appendChild(chip(KIND_LABELS[value] || value, state.kinds.has(value), () => {
      toggleSet(state.kinds, value);
      syncUrl();
      renderFilterShell();
      renderFeed();
    }));
  }

  document.getElementById("noveltyChip").setAttribute("aria-pressed", String(state.highNovelty));
  document.getElementById("discussionChip").setAttribute("aria-pressed", String(state.discussionOnly));
}

function renderFeed() {
  const main = document.getElementById("feed");
  resetFeedImageHydration();
  const items = visibleItems();

  const buckets = groupFeedItems(items);
  const orderedItems = buckets.flatMap((bucket) => bucket.items);
  const hasFilters = state.kinds.size || state.highNovelty || state.discussionOnly;
  const topNews = state.activeFeed === "main" ? (state.data.top_news || []).filter(news =>
    !hasFilters || items.some(item => item.id === news.cluster_id || item.primary?.url === news.url)) : [];
  const readerItems = READER_HELPERS?.prioritizeTopNews(orderedItems, topNews) || orderedItems;

  if (!items.length && (!shouldUseMobileReader() || !readerItems.length)) {
    disableMobileReader();
    const isFoundationShelf = state.activeFeed === "learning" && state.learningTrack === "foundations";
    const isEmptyLessons = state.activeFeed === "learning" && !isFoundationShelf && !hasFilters;
    const title = isFoundationShelf ? "No Foundations in this edition" : isEmptyLessons ? "No new lessons in this edition" : "No matching items";
    const detail = isFoundationShelf ? "Try today's edition or clear the filters." : isEmptyLessons
      ? `${state.data.source_failed > 0 ? "Some lesson sources could not be refreshed." : "No recent lessons met the selection rules."} Browse Foundations for reviewed courses or open an earlier edition.`
      : "Relax the filters or hit reset.";
    main.replaceChildren(emptyState(title, detail));
    hideResumePrompt();
    return;
  }

  const fragments = [];
  let displayIndex = 0;
  for (const bucket of buckets) {
    if (!bucket.items.length) continue;
    const head = node("div", "bucket-head");
    head.append(
      document.createTextNode(bucket.label),
      Object.assign(document.createElement("span"), { className: "count", textContent: `(${bucket.items.length})` }),
    );
    fragments.push(head);
    for (const item of bucket.items) fragments.push(renderItem(item, ++displayIndex));
  }
  fragments.push(renderCompletionRow());
  main.replaceChildren(...fragments);
  const readerReady = enhanceMobileReader(readerItems);
  if (!readerReady) scheduleFeedImageHydration(main);
  if (readerReady) prepareReaderResumePrompt(readerItems.length);
  else prepareResumePrompt(displayIndex);
  if (readerReady) updateReaderViewportHeight();
  updateTopJump();
}

function groupFeedItems(items) {
  if (state.activeFeed === "learning" && state.learningTrack === "foundations") {
    return [{ label: "Foundations · curated courses", items }];
  }
  const now = Date.now();
  const buckets = [
    { label: "Last 3 hours", items: [] },
    { label: "Earlier today", items: [] },
    { label: "Yesterday & older", items: [] },
  ];
  for (const item of items) {
    const date = parseDate(item.primary?.published_at);
    const age = date ? (now - date.getTime()) / MS_PER_HOUR : 999;
    if (age <= 3) buckets[0].items.push(item);
    else if (age <= 24) buckets[1].items.push(item);
    else buckets[2].items.push(item);
  }
  for (const bucket of buckets) {
    bucket.items.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  }
  return buckets;
}

function shouldUseMobileReader() {
  const supportsSnap = !window.CSS || !CSS.supports || CSS.supports("scroll-snap-type: y mandatory");
  return Boolean(
    state.readerMode === "deck" &&
    READER_HELPERS &&
    state.reader.media?.matches &&
    supportsSnap &&
    !document.body.classList.contains("reader-disabled"),
  );
}

function enhanceMobileReader(items) {
  if (!shouldUseMobileReader()) {
    disableMobileReader();
    return false;
  }
  try {
    const reader = ensureMobileReader();
    const previousKey = state.reader.itemKey;
    const previousIndex = state.reader.index;
    const day = currentFeedDay();
    const signature = readerFilterSignature();
    const sameScope =
      state.reader.active &&
      state.reader.feedRole === state.activeFeed &&
      state.reader.day === day &&
      state.reader.signature === signature;
    const nextIndex = sameScope
      ? READER_HELPERS.indexAfterFilterChange(previousKey, items, previousIndex)
      : 0;

    state.reader.active = true;
    state.reader.items = items;
    state.reader.index = nextIndex;
    state.reader.itemKey = readerItemKey(items[nextIndex]);
    state.reader.feedRole = state.activeFeed;
    state.reader.day = day;
    state.reader.signature = signature;
    document.body.classList.add("has-mobile-reader");
    reader.hidden = false;
    updateReaderViewportHeight();
    renderReaderSlots();
    renderReaderIndexSheet();
    updateReaderProgress();
    updateReaderScrollMotion();
    requestAnimationFrame(() => scrollReaderToIndex(nextIndex, { behavior: "auto" }));
    return true;
  } catch (error) {
    console.warn("[chronicle-reader] mobile reader disabled", error);
    disableMobileReader();
    return false;
  }
}

function ensureMobileReader() {
  let reader = document.getElementById("mobileReader");
  if (reader) return reader;

  reader = node("section", "mobile-reader");
  reader.id = "mobileReader";
  reader.hidden = true;
  reader.setAttribute("role", "region");
  reader.setAttribute("aria-label", "Mobile feed reader");

  const status = node("div", "reader-status");
  const counter = node("span", "reader-counter", "0 / 0");
  counter.id = "readerCounter";
  counter.setAttribute("aria-live", "polite");
  const rail = node("div", "reader-rail");
  rail.setAttribute("aria-hidden", "true");
  rail.appendChild(document.createElement("span"));
  const indexButton = document.createElement("button");
  indexButton.type = "button";
  indexButton.className = "reader-index-button";
  indexButton.id = "readerIndexButton";
  indexButton.textContent = "Index";
  indexButton.setAttribute("aria-expanded", "false");
  indexButton.setAttribute("aria-controls", "readerIndexSheet");
  indexButton.dataset.noSwipe = "true";
  const filterSummary = node("div", "reader-filter-summary");
  filterSummary.id = "readerFilterSummary";
  filterSummary.setAttribute("aria-live", "polite");
  status.append(counter, rail, indexButton, filterSummary);

  const deck = node("div", "reader-deck");
  deck.id = "readerDeck";
  deck.tabIndex = 0;
  deck.setAttribute("aria-label", "Scroll for next and previous feed items");
  const slots = node("div", "reader-slots");
  slots.id = "readerSlots";
  deck.appendChild(slots);

  const sheet = node("div", "reader-index-sheet");
  sheet.id = "readerIndexSheet";
  sheet.hidden = true;
  sheet.dataset.noSwipe = "true";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-label", "Feed index");
  sheet.setAttribute("aria-modal", "false");
  const handle = node("div", "reader-index-handle");
  handle.setAttribute("aria-hidden", "true");
  sheet.appendChild(handle);
  sheet.appendChild(readerIndexHead());
  sheet.appendChild(readerRefineSection());
  sheet.appendChild(node("div", "reader-index-list"));

  reader.append(status, deck, sheet);
  document.getElementById("feed").appendChild(reader);

  indexButton.addEventListener("click", () => toggleReaderIndexSheet());
  deck.addEventListener("scroll", onReaderDeckScroll, { passive: true });
  deck.addEventListener("keydown", onReaderKeyDown);
  wireSheetSwipe(sheet);
  document.addEventListener("pointerdown", (e) => {
    if (!state.reader.sheetOpen) return;
    if (!e.target?.closest?.("#readerIndexSheet") && !e.target?.closest?.("#readerIndexButton")) {
      closeReaderIndexSheet();
    }
  }, { passive: true });
  return reader;
}

function readerIndexHead() {
  const head = node("div", "reader-index-head");
  head.appendChild(document.createTextNode("Index"));
  const close = document.createElement("button");
  close.type = "button";
  close.className = "reader-close";
  close.textContent = "Close";
  close.dataset.noSwipe = "true";
  close.addEventListener("click", () => closeReaderIndexSheet());
  head.appendChild(close);
  return head;
}

function readerRefineSection() {
  const details = node("details", "reader-refine");
  details.dataset.noSwipe = "true";
  const summary = document.createElement("summary");
  summary.textContent = "Refine";
  const panel = node("div", "reader-refine-panel");
  details.append(summary, panel);
  return details;
}

function disableMobileReader() {
  document.body.classList.remove("has-mobile-reader", "is-reader-compact");
  state.reader.active = false;
  state.reader.items = [];
  state.reader.itemKey = "";
  state.reader.scrollTicking = false;
  state.reader.syncingScroll = false;
  state.reader.visibility.clear();
  state.reader.observer?.disconnect();
  state.reader.observer = null;
  if (state.reader.motionFrame) cancelAnimationFrame(state.reader.motionFrame);
  state.reader.motionFrame = 0;
  window.clearTimeout(state.reader.scrollReleaseTimer);
  state.reader.scrollReleaseTimer = 0;
  state.reader.sheetOpen = false;
  state.gestureLock = null;
  const reader = document.getElementById("mobileReader");
  if (reader) reader.remove();
}

function renderReaderSlots() {
  const slots = document.getElementById("readerSlots");
  if (!slots) return;
  const items = state.reader.items;
  const index = READER_HELPERS.clampIndex(state.reader.index, items.length);
  const cards = items.map((item, itemIndex) => {
    const card = renderReaderCard(item, itemIndex, itemIndex === index, itemIndex <= index + 1);
    setReaderCardActive(card, itemIndex === index);
    return card;
  });
  slots.replaceChildren(...cards);
  hydrateReaderImagesAround(index);
  observeReaderCards();
  updateReaderScrollMotion();
}

function renderReaderCard(item, index, isCurrent, eagerImage) {
  const article = node("article", `reader-card${isCurrent ? " is-current" : ""}`);
  article.tabIndex = isCurrent ? 0 : -1;
  article.dataset.readerIndex = String(index);
  article.dataset.readerItemKey = readerItemKey(item);
  article.setAttribute("aria-label", `Item ${index + 1} of ${state.reader.items.length}`);
  const frame = node("div", "reader-card-frame");

  const image = readerImage(item, eagerImage);
  if (image) frame.appendChild(image);
  else article.classList.add("is-text-first");

  const body = node("div", "reader-body");
  const meta = node("div", "reader-meta");
  meta.append(sourceLabel(item));
  meta.append(sep(), document.createTextNode(itemDateLabel(item)));
  if (item.primary?.discovered_at) meta.append(sep(), document.createTextNode(`${item.primary.discovery_reason === "trending" ? "trending observed" : "listed"} ${relTime(parseDate(item.primary.discovered_at))}`));
  if (item.kind && item.kind !== "unknown") meta.append(sep(), document.createTextNode(KIND_LABELS[item.kind] || item.kind));
  const score = Number(item.score);
  if (Number.isFinite(score) && item.primary?.learning?.track !== "foundations") meta.append(sep(), document.createTextNode(score.toFixed(2)));
  body.appendChild(meta);

  const title = item.primary?.title || "Untitled item";
  const heading = node("h2", "reader-title");
  heading.appendChild(link(item.primary?.url, title));
  body.appendChild(heading);

  if (item.top_news) {
    body.prepend(node("span", "reader-featured", "Top story"));
    body.append(node("p", "reader-line", item.top_news.dek));
    body.append(node("p", "reader-provenance", item.top_news.summary_method === "extractive" ? "Source excerpt" : item.top_news.summary_method === "source_metadata" ? "Source metadata" : "Legacy automated brief"));
  } else {
    const line = readableLine(item, title);
    if (line) body.appendChild(node("p", "reader-line", line));
  }

  if (item.primary?.learning?.track === "foundations") {
    article.classList.add("is-foundation");
    const course = item.primary.learning;
    body.append(node("p", "course-summary", `${course.level || "Level not stated"} · ${course.cost || "Cost not stated"} · Examples not run`));
    const reviewDue = Date.now() - Date.parse(course.reviewed_at) > 90 * MS_PER_DAY ? " · review due" : "";
    body.append(node("p", "course-review", `Syllabus reviewed ${course.reviewed_at || "unknown"}${reviewDue}`));
  }
  const reasons = (Array.isArray(item.why_this_surfaced) ? item.why_this_surfaced.filter(Boolean) : []).map(reason => reason.replace(/corroborated by (\d+) sources/, "seen on $1 feeds; not independent verification"));
  if (item.classification_method) reasons.push(`Assessment: ${item.classification_method}. ${item.classification_reason || ""}`);
  const firstReason = reasons[0] || item.builder_action || "";
  const explain = renderReaderExplain(item, reasons, firstReason);

  frame.appendChild(body);
  frame.appendChild(explain);
  article.appendChild(frame);
  return article;
}

function readerImage(item, eager) {
  const src = itemImageUrl(item);
  if (!src) return null;
  const img = document.createElement("img");
  img.className = "reader-media";
  if (eager) img.src = src;
  else img.dataset.src = src;
  img.alt = imageAltText(item);
  img.width = 800;
  img.height = 450;
  img.loading = eager ? "eager" : "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  try { img.fetchPriority = eager ? "high" : "low"; } catch (_) {}
  img.addEventListener("error", () => {
    const card = img.closest(".reader-card");
    img.remove();
    card?.classList.add("is-text-first");
  }, { once: true });
  return img;
}

function hydrateReaderImagesAround(index) {
  document.querySelectorAll(".reader-card").forEach((card) => {
    const cardIndex = Number(card.dataset.readerIndex);
    if (!Number.isFinite(cardIndex) || Math.abs(cardIndex - index) > 2) return;
    hydrateReaderImage(card.querySelector("img.reader-media"));
  });
}

function hydrateReaderImage(img) {
  const src = img?.dataset?.src;
  if (!src || img.getAttribute("src")) return;
  img.src = src;
  delete img.dataset.src;
}

function renderReaderExplain(item, reasons, firstReason) {
  const details = node("details", "reader-explain");
  details.dataset.noSwipe = "true";
  const summary = document.createElement("summary");
  summary.append(
    node("span", "reader-explain-label", item.primary?.learning?.track === "foundations" ? "course details" : "why surfaced"),
    node("span", "reader-explain-preview", item.primary?.learning?.track === "foundations" ? "Prerequisites & compatibility" : firstReason || "ranked by Chronicle signals"),
    node("span", "reader-explain-cue", "+"),
  );
  const list = document.createElement("ul");
  const rows = reasons.length ? reasons : [firstReason || "Ranked by Chronicle signals."];
  rows.forEach((reason) => {
    const row = document.createElement("li");
    row.textContent = reason;
    list.appendChild(row);
  });
  if (item.builder_action && !rows.includes(item.builder_action)) {
    const row = document.createElement("li");
    row.textContent = item.builder_action;
    list.appendChild(row);
  }
  details.append(summary);
  const facts = foundationFacts(item);
  if (facts) details.append(facts);
  details.append(list, link(rootUrl("methodology.html"), "How Chronicle selects stories · report a correction"));
  return details;
}

function updateReaderProgress() {
  const count = state.reader.items.length;
  const index = READER_HELPERS.clampIndex(state.reader.index, count);
  const counter = document.getElementById("readerCounter");
  if (counter) counter.textContent = count ? `${index + 1} / ${count}` : "0 / 0";
  const reader = document.getElementById("mobileReader");
  if (reader) reader.style.setProperty("--reader-progress", count ? String((index + 1) / count) : "0");
  state.reader.itemKey = readerItemKey(state.reader.items[index]);
  updateReaderFilterSummary();
}

function renderReaderIndexSheet() {
  const sheet = document.getElementById("readerIndexSheet");
  if (!sheet) return;
  const list = sheet.querySelector(".reader-index-list");
  if (!list) return;
  const refine = sheet.querySelector(".reader-refine");
  if (refine) {
    const wasOpen = refine.open;
    refine.open = wasOpen || activeReaderFilterLabels().length > 0;
    renderReaderRefineControls(refine.querySelector(".reader-refine-panel"));
  }
  const rows = state.reader.items.map((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "reader-index-row";
    row.dataset.noSwipe = "true";
    row.dataset.readerIndex = String(index);
    row.setAttribute("aria-current", String(index === state.reader.index));
    row.append(
      node("span", "reader-index-number", String(index + 1).padStart(2, "0")),
      node("span", "reader-index-title", item.primary?.title || "Untitled item"),
      node("span", "reader-index-meta", Number.isFinite(Number(item.score)) ? Number(item.score).toFixed(2) : ""),
    );
    row.addEventListener("click", () => {
      closeReaderIndexSheet();
      setReaderIndex(index, { focus: true, jumpcut: true });
    });
    return row;
  });
  list.replaceChildren(...rows);
}

function renderReaderRefineControls(panel) {
  if (!panel || !state.data) return;
  const counts = new Map();
  for (const item of state.data.clusters ?? []) {
    const k = item.kind || "unknown";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const kinds = [...counts.keys()].sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  const buttons = [];
  for (const value of kinds) {
    buttons.push(readerRefineButton(KIND_LABELS[value] || value, state.kinds.has(value), () => {
      toggleSet(state.kinds, value);
      applyReaderFilterChange();
    }));
  }
  buttons.push(readerRefineButton("high novelty", state.highNovelty, () => {
    state.highNovelty = !state.highNovelty;
    applyReaderFilterChange();
  }));
  buttons.push(readerRefineButton("discussion", state.discussionOnly, () => {
    state.discussionOnly = !state.discussionOnly;
    applyReaderFilterChange();
  }));
  if (activeReaderFilterLabels().length) {
    const reset = readerRefineButton("reset", false, () => {
      clearReaderFilters();
      applyReaderFilterChange();
    });
    reset.classList.add("is-reset");
    buttons.push(reset);
  }
  panel.replaceChildren(...buttons);
}

function readerRefineButton(label, active, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "reader-refine-button";
  button.textContent = label;
  button.dataset.noSwipe = "true";
  button.setAttribute("aria-pressed", String(active));
  button.addEventListener("click", onClick);
  return button;
}

function applyReaderFilterChange() {
  closeReaderIndexSheet();
  syncUrl();
  renderFilterShell();
  renderFeed();
}

function clearReaderFilters() {
  state.kinds.clear();
  state.highNovelty = false;
  state.discussionOnly = false;
}

function activeReaderFilterLabels() {
  const labels = [...state.kinds].map((value) => KIND_LABELS[value] || value);
  if (state.highNovelty) labels.push("high novelty");
  if (state.discussionOnly) labels.push("discussion");
  return labels;
}

function updateReaderFilterSummary() {
  const summary = document.getElementById("readerFilterSummary");
  if (!summary) return;
  const labels = activeReaderFilterLabels();
  summary.classList.toggle("is-visible", labels.length > 0);
  if (!labels.length) {
    summary.replaceChildren();
    return;
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "clear";
  clear.dataset.noSwipe = "true";
  clear.addEventListener("click", () => {
    clearReaderFilters();
    applyReaderFilterChange();
  });
  summary.replaceChildren(
    document.createTextNode(`Filtered: ${labels.join(", ")}`),
    clear,
  );
}

function toggleReaderIndexSheet() {
  state.reader.sheetOpen ? closeReaderIndexSheet() : openReaderIndexSheet();
}

function openReaderIndexSheet() {
  const sheet = document.getElementById("readerIndexSheet");
  const button = document.getElementById("readerIndexButton");
  if (!sheet || !button) return;
  renderReaderIndexSheet();
  sheet.hidden = false;
  state.reader.sheetOpen = true;
  button.setAttribute("aria-expanded", "true");
  sheet.querySelector(".reader-index-row[aria-current='true']")?.scrollIntoView({ block: "nearest" });
}

function closeReaderIndexSheet() {
  const sheet = document.getElementById("readerIndexSheet");
  const button = document.getElementById("readerIndexButton");
  if (!sheet || !button) return;
  sheet.style.transform = "";
  sheet.classList.remove("is-snapping");
  sheet.hidden = true;
  state.reader.sheetOpen = false;
  button.setAttribute("aria-expanded", "false");
}

function wireSheetSwipe(sheet) {
  let startY = 0;
  let currentY = 0;
  let dragging = false;

  // reset if sheet is closed externally mid-drag (outside click, keyboard, etc.)
  sheet.addEventListener("hidden", () => { dragging = false; }, { passive: true });

  sheet.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    if (sheet.scrollTop > 2) return;
    startY = e.touches[0].clientY;
    currentY = startY;
    dragging = true;
    sheet.classList.remove("is-snapping");
  }, { passive: true });

  sheet.addEventListener("touchmove", (e) => {
    if (!dragging || e.touches.length !== 1) return;
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy <= 0) {
      sheet.style.transform = "";
      return;
    }
    const clamped = dy < 80 ? dy : 80 + (dy - 80) * 0.25;
    sheet.style.transform = `translateY(${clamped.toFixed(1)}px)`;
  }, { passive: true });

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    const dy = currentY - startY;
    sheet.classList.add("is-snapping");
    if (dy > 72) {
      sheet.style.transform = `translateY(100%)`;
      const onCommit = (e) => {
        if (e.propertyName !== "transform") return;
        sheet.removeEventListener("transitionend", onCommit);
        closeReaderIndexSheet();
      };
      sheet.addEventListener("transitionend", onCommit);
    } else {
      sheet.style.transform = "";
      const onSnap = (e) => {
        if (e.propertyName !== "transform") return;
        sheet.removeEventListener("transitionend", onSnap);
        sheet.classList.remove("is-snapping");
      };
      sheet.addEventListener("transitionend", onSnap);
    }
  }

  sheet.addEventListener("touchend", onEnd, { passive: true });
  sheet.addEventListener("touchcancel", onEnd, { passive: true });
}

function setReaderIndex(index, options = {}) {
  if (!state.reader.active) return;
  const next = READER_HELPERS.clampIndex(index, state.reader.items.length);
  setActiveReaderIndex(next, { save: true });
  scrollReaderToIndex(next, { behavior: options.jumpcut || prefersReducedMotion() ? "auto" : "smooth" });
  if (options.focus) requestAnimationFrame(() => focusActiveReaderCard());
}

function setActiveReaderIndex(index, options = {}) {
  const next = READER_HELPERS.clampIndex(index, state.reader.items.length);
  state.reader.index = next;
  state.reader.itemKey = readerItemKey(state.reader.items[next]);
  hydrateReaderImagesAround(next);
  syncReaderCardStates();
  renderReaderIndexSheet();
  updateReaderProgress();
  if (options.save !== false) saveReaderProgress();
}

function syncReaderCardStates() {
  document.querySelectorAll(".reader-card").forEach((card) => {
    setReaderCardActive(card, Number(card.dataset.readerIndex) === state.reader.index);
  });
}

function setReaderCardActive(card, active) {
  card.classList.toggle("is-current", active);
  card.tabIndex = active ? 0 : -1;
  if (active) {
    card.removeAttribute("aria-hidden");
    card.inert = false;
    restoreFocusableChildren(card);
  } else {
    card.setAttribute("aria-hidden", "true");
    card.inert = true;
    disableFocusableChildren(card);
  }
}

function scrollReaderToIndex(index, options = {}) {
  const deck = document.getElementById("readerDeck");
  const card = document.querySelector(`.reader-card[data-reader-index="${READER_HELPERS.clampIndex(index, state.reader.items.length)}"]`);
  if (!deck || !card) return;
  const behavior = options.behavior || "auto";
  state.reader.syncingScroll = true;
  window.clearTimeout(state.reader.scrollReleaseTimer);
  deck.scrollTo({ top: card.offsetTop, behavior });
  updateReaderScrollMotion();
  state.reader.scrollReleaseTimer = window.setTimeout(() => {
    state.reader.syncingScroll = false;
    state.reader.scrollReleaseTimer = 0;
    onReaderDeckScroll();
  }, behavior === "smooth" ? 360 : 60);
}

function onReaderDeckScroll() {
  if (!state.reader.active || state.reader.scrollTicking) return;
  state.reader.scrollTicking = true;
  requestAnimationFrame(() => {
    state.reader.scrollTicking = false;
    updateReaderScrollMotion();
    if (state.reader.syncingScroll) return;
    const next = nearestReaderIndex();
    if (next !== state.reader.index) setActiveReaderIndex(next, { save: true });
  });
}

function observeReaderCards() {
  state.reader.visibility.clear();
  state.reader.observer?.disconnect();
  state.reader.observer = null;
  const deck = document.getElementById("readerDeck");
  const cards = document.querySelectorAll(".reader-card");
  if (!deck || !cards.length || typeof IntersectionObserver !== "function") return;
  state.reader.observer = new IntersectionObserver(onReaderIntersections, {
    root: deck,
    threshold: READER_VISIBILITY_THRESHOLDS,
  });
  cards.forEach((card) => state.reader.observer.observe(card));
}

function onReaderIntersections(entries) {
  for (const entry of entries) {
    const index = Number(entry.target.dataset.readerIndex);
    if (Number.isFinite(index)) {
      state.reader.visibility.set(index, entry.isIntersecting ? entry.intersectionRatio : 0);
    }
  }
  scheduleReaderMotionUpdate();
}

function scheduleReaderMotionUpdate() {
  if (!state.reader.active || state.reader.motionFrame) return;
  state.reader.motionFrame = requestAnimationFrame(() => {
    state.reader.motionFrame = 0;
    updateReaderScrollMotion();
  });
}

function updateReaderScrollMotion() {
  const deck = document.getElementById("readerDeck");
  const cards = document.querySelectorAll(".reader-card");
  if (!deck || !cards.length) return;
  if (prefersReducedMotion()) {
    cards.forEach((card) => {
      const frame = card.querySelector(".reader-card-frame");
      if (frame) clearReaderScrollMotion(frame);
    });
    return;
  }
  const height = Math.max(1, deck.clientHeight || deck.getBoundingClientRect().height || 1);
  cards.forEach((card) => {
    const frame = card.querySelector(".reader-card-frame");
    if (!frame) return;
    const index = Number(card.dataset.readerIndex);
    const raw = (card.offsetTop - deck.scrollTop) / height;
    const progress = Math.max(-1, Math.min(1, raw));
    const distance = Math.abs(progress);
    if (distance < 0.012) {
      restReaderScrollMotion(frame);
      return;
    }
    // cylinder curve: sin maps linear scroll distance onto a drum arc
    const arc = Math.sin(Math.min(1, distance) * Math.PI / 2);
    const eased = Math.sign(progress) * arc;
    // arrival: 0 = fully off-screen, 1 = snapped
    const fallbackArrival = Math.max(0, 1 - distance);
    const observedVisibility = Number.isFinite(index) ? state.reader.visibility.get(index) : undefined;
    const arrival = Math.max(fallbackArrival, Number.isFinite(observedVisibility) ? observedVisibility : 0);
    // opacity: 0.4 off-screen → 1.0 snapped (pow < 1 keeps mid-scroll visible)
    const opacity = 0.4 + Math.pow(arrival, 0.45) * 0.6;
    // tilt: stronger angle gives the cylindrical drum feel
    const tilt = -eased * 14;
    // lift: cards roll up/down as if on a drum surface
    const lift = eased * 18;
    // scaleX narrows card width as it rolls to the far edge of the cylinder
    const scaleX = 1 - arc * 0.15;
    // uniform scale: slight shrink adds depth without fighting scaleX
    const scale = Math.max(0.96, 1 - distance * 0.04);
    // shade darkens cards rolling away
    const shade = Math.min(0.32, arc * 0.32);
    frame.style.setProperty("--reader-tilt", `${tilt.toFixed(3)}deg`);
    frame.style.setProperty("--reader-lift", `${lift.toFixed(2)}px`);
    frame.style.setProperty("--reader-scaleX", scaleX.toFixed(4));
    frame.style.setProperty("--reader-scale", scale.toFixed(4));
    frame.style.setProperty("--reader-opacity", Math.min(0.999, opacity).toFixed(4));
    frame.style.setProperty("--reader-shade", shade.toFixed(4));
    frame.style.setProperty("--reader-fold-origin", progress < 0 ? "50% 0%" : "50% 100%");
  });
}

// Set vars to their CSS-default resting values so the CSS transition eases them in.
function restReaderScrollMotion(frame) {
  frame.style.setProperty("--reader-tilt", "0deg");
  frame.style.setProperty("--reader-lift", "0px");
  frame.style.setProperty("--reader-scaleX", "1");
  frame.style.setProperty("--reader-scale", "1");
  frame.style.setProperty("--reader-opacity", "1");
  frame.style.setProperty("--reader-shade", "0");
}

// Hard-remove all vars (no transition) — only used for prefers-reduced-motion.
function clearReaderScrollMotion(frame) {
  frame.style.removeProperty("--reader-tilt");
  frame.style.removeProperty("--reader-lift");
  frame.style.removeProperty("--reader-scaleX");
  frame.style.removeProperty("--reader-scale");
  frame.style.removeProperty("--reader-opacity");
  frame.style.removeProperty("--reader-shade");
  frame.style.removeProperty("--reader-fold-origin");
}

function nearestReaderIndex() {
  const deck = document.getElementById("readerDeck");
  const cards = [...document.querySelectorAll(".reader-card")];
  if (!deck || !cards.length) return state.reader.index;
  let closestIndex = state.reader.index;
  let closestDistance = Infinity;
  for (const card of cards) {
    const distance = Math.abs(card.offsetTop - deck.scrollTop);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = Number(card.dataset.readerIndex) || 0;
    }
  }
  return READER_HELPERS.clampIndex(closestIndex, state.reader.items.length);
}

function focusActiveReaderCard() {
  document.querySelector(".reader-card.is-current")?.focus({ preventScroll: true });
}

function navigateReader(direction, options = {}) {
  if (!state.reader.active) return;
  const delta = direction === "next" ? 1 : -1;
  const next = READER_HELPERS.clampIndex(state.reader.index + delta, state.reader.items.length);
  if (next !== state.reader.index) setReaderIndex(next, { focus: options.focus, jumpcut: options.jumpcut });
}

function onReaderKeyDown(event) {
  if (!state.reader.active || isReaderInteractiveTarget(event.target)) return;
  if (event.key === "ArrowDown" || event.key === "PageDown" || (event.key === " " && !event.shiftKey)) {
    event.preventDefault();
    navigateReader("next", { focus: true });
  } else if (event.key === "ArrowUp" || event.key === "PageUp" || (event.key === " " && event.shiftKey)) {
    event.preventDefault();
    navigateReader("previous", { focus: true });
  } else if (event.key === "Home") {
    event.preventDefault();
    setReaderIndex(0, { focus: true, jumpcut: true });
  } else if (event.key === "End") {
    event.preventDefault();
    setReaderIndex(state.reader.items.length - 1, { focus: true, jumpcut: true });
  } else if (event.key === "Escape" && state.reader.sheetOpen) {
    closeReaderIndexSheet();
  }
}

function isReaderInteractiveTarget(target) {
  return Boolean(target?.closest?.("a, button, summary, details, input, select, textarea, [data-no-swipe]"));
}

function disableFocusableChildren(root) {
  root.querySelectorAll("a, button, summary, input, select, textarea, [tabindex]").forEach((element) => {
    element.dataset.readerTabIndex = element.getAttribute("tabindex") || "";
    element.setAttribute("tabindex", "-1");
  });
}

function restoreFocusableChildren(root) {
  root.querySelectorAll("[data-reader-tab-index]").forEach((element) => {
    const previous = element.dataset.readerTabIndex;
    if (previous) element.setAttribute("tabindex", previous);
    else element.removeAttribute("tabindex");
    delete element.dataset.readerTabIndex;
  });
}

function lockGesture(owner) {
  if (state.gestureLock && state.gestureLock.owner !== owner) return false;
  state.gestureLock = { owner, ts: Date.now() };
  return true;
}

function releaseGesture(owner) {
  if (!state.gestureLock || state.gestureLock.owner === owner) state.gestureLock = null;
}

function readerFilterSignature() {
  return READER_HELPERS.filterSignature({
    learningTrack: state.activeFeed === "learning" ? state.learningTrack : "",
    kinds: [...state.kinds],
    highNovelty: state.highNovelty,
    discussionOnly: state.discussionOnly,
  });
}

function readerProgressKey() {
  return READER_HELPERS.progressKey(currentFeedDay(), state.activeFeed, readerFilterSignature());
}

function readerItemKey(item) {
  return item ? READER_HELPERS.itemKey(item) : "";
}

function readReaderProgress() {
  if (!READER_HELPERS) return null;
  try {
    const value = JSON.parse(localStorage.getItem(readerProgressKey()) || "null");
    if (!value || Date.now() - Number(value.ts || 0) > PROGRESS_TTL_MS) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function prepareReaderResumePrompt(total) {
  const saved = readReaderProgress();
  if (!saved || Number(saved.index) < 3 || saved.itemKey === state.reader.itemKey) {
    hideResumePrompt();
    return;
  }
  const index = READER_HELPERS.restoreIndex(state.reader.items, saved, 0);
  if (index <= state.reader.index || index >= total) {
    hideResumePrompt();
    return;
  }
  const prompt = document.getElementById("resumePrompt");
  const button = document.getElementById("resumeReading");
  prompt.dataset.readerIndex = String(index);
  button.textContent = `Resume at item ${index + 1}`;
  prompt.hidden = false;
}

function saveReaderProgress() {
  if (!state.reader.active || !state.reader.items.length || !READER_HELPERS) return;
  try {
    if (state.reader.index <= 0) {
      localStorage.removeItem(readerProgressKey());
      return;
    }
    localStorage.setItem(readerProgressKey(), JSON.stringify({
      itemKey: state.reader.itemKey,
      index: state.reader.index,
      ts: Date.now(),
    }));
  } catch (_) {}
}

function clearReaderProgress() {
  if (!READER_HELPERS) return;
  try { localStorage.removeItem(readerProgressKey()); } catch (_) {}
}

function updateReaderViewportHeight() {
  const height = Math.round(window.visualViewport?.height || window.innerHeight || 0);
  if (height > 0) document.documentElement.style.setProperty("--reader-vh", `${height}px`);
  const deck = document.getElementById("readerDeck");
  if (!deck || !state.reader.media?.matches) {
    document.documentElement.style.removeProperty("--reader-deck-h");
    document.body.classList.remove("is-reader-compact");
    return;
  }
  const rect = deck.getBoundingClientRect();
  const bottomInset = 18;
  const available = Math.floor(height - rect.top - bottomInset);
  if (available > 0) {
    const nextHeight = Math.max(286, Math.min(620, available));
    document.documentElement.style.setProperty("--reader-deck-h", `${nextHeight}px`);
    document.body.classList.toggle("is-reader-compact", nextHeight < 470 || height < 720);
    if (state.reader.active) {
      requestAnimationFrame(() => {
        scrollReaderToIndex(state.reader.index, { behavior: "auto" });
        updateReaderScrollMotion();
      });
    }
  }
}

function renderItem(item, displayIndex) {
  const article = node("article", "item");
  article.dataset.tier = Number(item.novelty || 0) >= NOVELTY_TOP ? "top" : "normal";
  article.dataset.readIndex = String(displayIndex);
  const body = node("div", "item-body");
  const image = itemImage(item);
  if (image) article.classList.add("has-image");

  const h3 = node("h3", "item-title");
  h3.appendChild(link(item.primary?.url, item.primary?.title || "Untitled item"));
  body.appendChild(h3);

  const title = item.primary?.title || "";
  const oneLiner = readableLine(item, title);
  if (oneLiner) {
    body.appendChild(node("p", "item-line", oneLiner));
  }

  const meta = node("div", "item-meta");
  meta.append(sourceLabel(item));
  meta.append(sep(), document.createTextNode(itemDateLabel(item)));
  if (item.primary?.discovered_at) meta.append(sep(), document.createTextNode(`${item.primary.discovery_reason === "trending" ? "trending observed" : "listed"} ${relTime(parseDate(item.primary.discovered_at))}`));
  if (item.kind && item.kind !== "unknown") meta.append(sep(), document.createTextNode(KIND_LABELS[item.kind] || item.kind));
  if (item.primary?.repo?.stargazers_count) {
    meta.append(sep(), document.createTextNode(`${formatNumber(item.primary.repo.stargazers_count)} stars`));
  }
  if (item.primary?.repo?.stars_today) {
    meta.append(sep(), document.createTextNode(`+${formatNumber(item.primary.repo.stars_today)} stars today`));
  }
  if (!item.primary?.repo?.stars_today && item.primary?.repo?.stars_delta_30d) {
    meta.append(sep(), document.createTextNode(`+${formatNumber(item.primary.repo.stars_delta_30d)} stars`));
  }
  if (item.primary?.learning?.provider) {
    meta.append(sep(), document.createTextNode(item.primary.learning.provider));
  }
  const discussions = discussionLinks(item);
  if (discussions.length) {
    meta.append(sep());
    discussions.forEach((d, index) => {
      if (index) meta.append(document.createTextNode(", "));
      meta.append(link(d.url, d.label));
    });
  }
  meta.append(node("span", "spacer"));
  const scoreNum = Number(item.score);
  const scoreSpan = node("span", "score", Number.isFinite(scoreNum) ? scoreNum.toFixed(2) : "—");
  scoreSpan.title = "score";
  meta.append(scoreSpan);

  const novelty = Number(item.novelty);
  const trust = Number(item.trust);
  if (Number.isFinite(novelty) || Number.isFinite(trust)) {
    const parts = [];
    if (Number.isFinite(novelty)) parts.push(`n ${novelty.toFixed(2)}`);
    if (Number.isFinite(trust)) parts.push(`t ${trust.toFixed(2)}`);
    meta.append(node("span", "score-detail", `(${parts.join(" · ")})`));
  }

  body.append(meta);
  const facts = foundationFacts(item);
  if (facts) body.append(facts);
  const explain = renderExplain(item);
  if (explain) body.appendChild(explain);
  if (sourceTrail(item).length > 1 || item.primary?.date_confidence !== "high") {
    body.appendChild(renderSourceTrail(item));
  }
  article.appendChild(body);
  if (image) article.appendChild(image);
  return article;
}

const SOURCE_GLYPHS = {
  arxiv: {
    viewBox: "0 0 17.732 24.269",
    content: '<path fill="currentColor" d="M573.549,280.916l2.266,2.738,6.674-7.84c.353-.47.52-.717.353-1.117a1.218,1.218,0,0,0-1.061-.748h0a.953.953,0,0,0-.712.262Z" transform="translate(-566.984 -271.548)"/><path fill="currentColor" d="M579.525,282.225l-10.606-10.174a1.413,1.413,0,0,0-.834-.5,1.09,1.09,0,0,0-1.027.66c-.167.4-.047.681.319,1.206l8.44,10.242h0l-6.282,7.716a1.336,1.336,0,0,0-.323,1.3,1.114,1.114,0,0,0,1.04.69A.992.992,0,0,0,571,293l8.519-7.92A1.924,1.924,0,0,0,579.525,282.225Z" transform="translate(-566.984 -271.548)"/><path fill="currentColor" d="M584.32,293.912l-8.525-10.275,0,0L573.53,280.9l-1.389,1.254a2.063,2.063,0,0,0,0,2.965l10.812,10.419a.925.925,0,0,0,.742.282,1.039,1.039,0,0,0,.953-.667A1.261,1.261,0,0,0,584.32,293.912Z" transform="translate(-566.984 -271.548)"/>',
  },
  reddit: {
    viewBox: "0 0 24 24",
    content: '<path fill="currentColor" d="M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z"/>',
  },
  youtube: {
    viewBox: "0 0 24 24",
    content: '<rect x="3.5" y="6.5" width="17" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" d="M10.4 9.25v5.5L15.25 12l-4.85-2.75Z"/>',
  },
  github: {
    viewBox: "0 0 24 24",
    content: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M7 4.5h9.5a2 2 0 0 1 2 2v13H8a2.5 2.5 0 0 1 0-5h10.5M7 4.5a2 2 0 0 0-2 2v10.5M9 8h6"/>',
  },
  huggingface: {
    viewBox: "0 0 24 24",
    content: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5.5 13.5c-.9-3.5 1.6-7 6.5-7s7.4 3.5 6.5 7c-.5 3.3-2.9 5.5-6.5 5.5s-6-2.2-6.5-5.5Z"/><circle cx="8.8" cy="10.5" r="1.05" fill="currentColor"/><circle cx="15.2" cy="10.5" r="1.05" fill="currentColor"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" d="M8.4 15c1.1 1.25 2.3 1.85 3.6 1.85s2.5-.6 3.6-1.85"/>',
  },
  "hacker-news": {
    viewBox: "0 0 24 24",
    content: '<rect x="4.5" y="4.5" width="15" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8.5 8l3.5 4 3.5-4M12 12v4"/>',
  },
  openai: {
    viewBox: "0 0 24 24",
    content: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M12 3.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5L12 3.5ZM5 16.5l.65 1.85L7.5 19l-1.85.65L5 21.5l-.65-1.85L2.5 19l1.85-.65L5 16.5ZM18.5 14l.45 1.25 1.3.5-1.3.5-.45 1.25-.5-1.25-1.25-.5 1.25-.5.5-1.25Z"/>',
  },
  news: {
    viewBox: "0 0 24 24",
    content: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4.5 6.5h15v10.8a1.7 1.7 0 0 1-1.7 1.7H6.2a1.7 1.7 0 0 1-1.7-1.7V6.5ZM7.5 10h4.5M7.5 13h9M7.5 16h7M14.5 9.5H17v2.5h-2.5z"/>',
  },
  discussion: {
    viewBox: "0 0 24 24",
    content: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5 6.5h10a2.5 2.5 0 0 1 2.5 2.5v3.5A2.5 2.5 0 0 1 15 15H8l-3 3v-3.2A2.5 2.5 0 0 1 2.5 12.3V9A2.5 2.5 0 0 1 5 6.5ZM8 10h5M8 12.8h3.5"/>',
  },
  feed: {
    viewBox: "0 0 24 24",
    content: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9" d="M5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM4 10a10 10 0 0 1 10 10M4 5a15 15 0 0 1 15 15"/>',
  },
};

function sourceLabel(item) {
  const data = sourceData(item);
  const kind = sourceGlyphKind(data);
  const source = node("span", "source");
  source.appendChild(sourceGlyph(kind));
  source.appendChild(document.createTextNode(data.source_name || "Unknown source"));
  return source;
}

function sourceData(item) {
  return item?.primary || item || {};
}

function sourceGlyph(kind) {
  const glyph = SOURCE_GLYPHS[kind] || SOURCE_GLYPHS.feed;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "source-glyph");
  svg.setAttribute("data-source-glyph", kind);
  svg.setAttribute("viewBox", glyph.viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = glyph.content;
  return svg;
}

function sourceGlyphKind(item) {
  const source = sourceData(item);
  const values = [
    source.source_id,
    source.source_name,
    source.url,
    source.original_url,
    source.discussion_url,
    source.discussion_source,
  ].filter(Boolean).join(" ").toLowerCase();
  const sourceId = String(source.source_id || "").toLowerCase();
  const sourceName = String(source.source_name || "").toLowerCase();
  if (sourceId.startsWith("r_") || sourceName.startsWith("r/") || values.includes("reddit.com")) return "reddit";
  if (sourceId.startsWith("arxiv_") || sourceName.startsWith("arxiv") || values.includes("arxiv.org")) return "arxiv";
  if (sourceId.startsWith("yt_") || values.includes("youtube") || values.includes("youtu.be")) return "youtube";
  if (sourceId.startsWith("github_") || sourceId.startsWith("repo_") || values.includes("github.com") || /\breleases\b/.test(sourceName)) return "github";
  if (sourceId.startsWith("hf_") || values.includes("hugging face") || values.includes("huggingface.co")) return "huggingface";
  if (sourceId.startsWith("hn_") || values.includes("hacker news") || values.includes("news.ycombinator.com")) return "hacker-news";
  if (sourceId === "openai" || sourceName.startsWith("openai") || values.includes("openai.com")) return "openai";
  if (sourceId.includes("lobsters") || values.includes("lobste.rs")) return "discussion";
  if (/(infoq|techcrunch|decoder|wired|venturebeat|verge)/.test(values)) return "news";
  return "feed";
}

function itemImage(item) {
  const src = itemImageUrl(item);
  if (!src) return null;
  const img = document.createElement("img");
  img.className = "item-thumb";
  img.dataset.src = src;
  img.alt = imageAltText(item);
  img.width = 352;
  img.height = 220;
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  try { img.fetchPriority = "low"; } catch (_) {}
  img.addEventListener("error", () => {
    const article = img.closest(".item");
    img.remove();
    article?.classList.remove("has-image");
  }, { once: true });
  return img;
}

function resetFeedImageHydration() {
  if (state.feedImageObserver) {
    state.feedImageObserver.disconnect();
    state.feedImageObserver = null;
  }
  if (state.feedImageTimer) {
    window.clearTimeout(state.feedImageTimer);
    state.feedImageTimer = 0;
  }
}

function scheduleFeedImageHydration(root) {
  const images = [...root.querySelectorAll("img.item-thumb[data-src]")];
  if (!images.length) return;
  const firstPaint = () => {
    images.slice(0, 2).forEach(hydrateFeedImage);
    const rest = images.slice(2).filter((img) => img.dataset.src);
    if (!rest.length) return;
    if (typeof IntersectionObserver === "function") {
      state.feedImageObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          state.feedImageObserver?.unobserve(entry.target);
          hydrateFeedImage(entry.target);
        }
      }, { rootMargin: IMAGE_HYDRATE_ROOT_MARGIN, threshold: 0.01 });
      rest.forEach((img) => state.feedImageObserver.observe(img));
      return;
    }
    hydrateFeedImagesInBatches(rest);
  };
  requestAnimationFrame(() => requestAnimationFrame(firstPaint));
}

function hydrateFeedImagesInBatches(images, index = 0) {
  const end = Math.min(images.length, index + IMAGE_HYDRATE_BATCH);
  for (let i = index; i < end; i++) hydrateFeedImage(images[i]);
  if (end >= images.length) return;
  state.feedImageTimer = window.setTimeout(() => hydrateFeedImagesInBatches(images, end), 80);
}

function hydrateFeedImage(img) {
  const src = img?.dataset?.src;
  if (!src || img.getAttribute("src")) return;
  img.src = src;
  delete img.dataset.src;
}

function itemImageUrl(item) {
  const candidates = [item?.primary, ...(Array.isArray(item?.members) ? item.members : [])];
  for (const candidate of candidates) {
    const src = safeImageUrl(candidate?.image_url);
    if (src) return src;
  }
  return "";
}

function imageAltText(item) {
  const title = decodeText(item?.primary?.title || item?.title || item?.one_liner || "Chronicle item");
  return truncateText(`Thumbnail for ${title}`, 160);
}

function renderExplain(item) {
  const reasons = (Array.isArray(item.why_this_surfaced) ? item.why_this_surfaced.filter(Boolean) : []).map(reason => reason.replace(/corroborated by (\d+) sources/, "seen on $1 feeds; not independent verification"));
  if (item.classification_method) reasons.push(`Assessment: ${item.classification_method}. ${item.classification_reason || ""}`);
  const action = item.builder_action;
  if (!reasons.length && !action) return null;
  const details = node("details", "item-explain");
  const summary = document.createElement("summary");
  summary.textContent = `why surfaced · ${item.novelty_label || "signal"}`;
  const list = document.createElement("ul");
  reasons.forEach((reason) => {
    const row = document.createElement("li");
    row.textContent = reason;
    list.appendChild(row);
  });
  if (action) {
    const row = document.createElement("li");
    row.textContent = action;
    list.appendChild(row);
  }
  details.append(summary, list);
  return details;
}

function renderCompletionRow() {
  const row = node("div", "completion-row");
  row.append(node("strong", "", "You're caught up"));
  row.append(document.createTextNode("·"));
  const top = document.createElement("button");
  top.type = "button";
  top.textContent = "Back to top";
  top.addEventListener("click", () => scrollToTop());
  row.append(top);
  if (!state.highNovelty) {
    row.append(document.createTextNode("·"));
    const novelty = document.createElement("button");
    novelty.type = "button";
    novelty.textContent = "High novelty only";
    novelty.addEventListener("click", () => {
      state.highNovelty = true;
      syncUrl();
      renderFilterShell();
      renderFeed();
      scrollToTop();
    });
    row.append(novelty);
  }
  return row;
}

function renderSourceTrail(item) {
  const details = node("details", "item-also");
  const summary = document.createElement("summary");
  const trail = sourceTrail(item);
  summary.textContent = `source trail · ${trail.length}`;
  const list = node("ul", "also-list");
  trail.forEach((source) => {
    const row = document.createElement("li");
    row.append(link(source.url, source.source_name || "source"));
    row.append(node("span", "also-meta", item.primary?.learning?.track === "foundations" ? itemDateLabel(item) : `${shortDate(parseDate(source.published_at))} · ${source.date_confidence || "unknown"} date`));
    if (source.title && source.title !== item.primary?.title) {
      row.append(node("span", "also-title", source.title));
    }
    if (source.discussion_url) {
      row.append(document.createTextNode(" · "));
      row.append(link(source.discussion_url, source.discussion_source || "discussion"));
    }
    list.appendChild(row);
  });
  details.append(summary, list);
  return details;
}

function sourceTrail(item) {
  if (item.source_trail?.length) return item.source_trail;
  const primary = item.primary ? [{
    source_id: item.primary.source_id,
    source_name: item.primary.source_name,
    title: item.primary.title,
    url: item.primary.url,
    published_at: item.primary.published_at,
    published_at_source: item.primary.published_at_source,
    date_confidence: item.primary.date_confidence,
    discussion_url: item.primary.discussion_url,
    discussion_source: item.primary.discussion_source,
  }] : [];
  return primary.concat(item.also_seen_on || []);
}

function visibleItems() {
  return (state.data?.clusters ?? []).filter(inLearningTrack).filter((item) => {
    if (state.kinds.size && !state.kinds.has(item.kind || "unknown")) return false;
    if (state.highNovelty && Number(item.novelty ?? 0) < NOVELTY_TOP) return false;
    if (state.discussionOnly && discussionLinks(item).length === 0) return false;
    return true;
  });
}

function discussionLinks(item) {
  const seen = new Set();
  const links = [];
  const add = (url, label) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ url, label: label || "discussion" });
  };
  add(item.primary?.discussion_url, item.primary?.discussion_source);
  (item.also_seen_on || []).forEach((source) => add(source.discussion_url, source.discussion_source));
  (item.source_trail || []).forEach((source) => add(source.discussion_url, source.discussion_source));
  return links;
}

function initFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  const kinds = csv(params.get("kind"));
  if (kinds.length) state.kinds = new Set(kinds);
  state.archiveDate = DATE_PATH_MATCH?.[1] || params.get("day") || null;
  state.learningTrack = params.get("track") === "foundations" ? "foundations" : "new";
  const requestedTab = params.get("tab");
  state.activeFeed = FEEDS[requestedTab] ? requestedTab : "main";
  state.highNovelty = params.get("novelty") === "high";
  state.discussionOnly = params.get("discussion") === "1";
}

function syncUrl() {
  const params = new URLSearchParams();
  if (state.kinds.size) params.set("kind", [...state.kinds].join(","));
  if (state.highNovelty) params.set("novelty", "high");
  if (state.discussionOnly) params.set("discussion", "1");
  if (state.activeFeed !== "main") params.set("tab", state.activeFeed);
  if (state.activeFeed === "learning" && state.learningTrack === "foundations") params.set("track", "foundations");
  if (document.body.classList.contains("is-detail")) params.set("detail", "1");
  const base = state.archiveDate ? rootUrl(`daily/${state.archiveDate}/`) : rootUrl("");
  const next = new URL(base);
  next.search = params.toString();
  history.replaceState(null, "", next.toString());
}

function feedUrl() {
  return feedUrlFor(state.activeFeed);
}

function feedUrlFor(role) {
  const feed = FEEDS[role] || FEEDS.main;
  if (state.archiveDate) return rootUrl(`daily/${state.archiveDate}/${feed.path}`);
  return rootUrl(feed.path);
}

function rootUrl(path) {
  return new URL(path, new URL(ROOT_PREFIX, location.href)).toString();
}

function scrollToTop() {
  hideResumePrompt();
  if (state.reader.active) {
    setReaderIndex(0, { focus: true, jumpcut: true });
    clearReaderProgress();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return;
  }
  clearReadingProgress();
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

function updateTopJump() {
  const button = document.getElementById("topJump");
  if (state.reader.active) {
    button.classList.remove("is-visible");
    return;
  }
  const feed = document.getElementById("feed");
  const feedTop = feed.getBoundingClientRect().top + window.scrollY;
  const nearTop = window.scrollY < Math.max(520, feedTop + 240);
  button.classList.toggle("is-visible", !nearTop);
}

function prepareResumePrompt(total) {
  const day = currentFeedDay();
  if (!day || state.resumePromptDay === day) return;
  state.resumePromptDay = day;
  const saved = readReadingProgress(day);
  if (!saved || saved.y < 640 || saved.index < 4) {
    hideResumePrompt();
    return;
  }
  const index = Math.max(1, Math.min(Number(saved.index) || 1, total));
  const prompt = document.getElementById("resumePrompt");
  const button = document.getElementById("resumeReading");
  prompt.dataset.resumeY = String(Math.max(0, Number(saved.y) || 0));
  button.textContent = `Resume at item ${index}`;
  prompt.hidden = false;
}

function hideResumePrompt() {
  const prompt = document.getElementById("resumePrompt");
  prompt.hidden = true;
  delete prompt.dataset.resumeY;
  delete prompt.dataset.readerIndex;
}

function saveReadingProgress() {
  if (state.reader.active) return;
  if (!state.data) return;
  const day = currentFeedDay();
  if (!day) return;
  if (window.scrollY < 160) {
    clearReadingProgress();
    return;
  }
  const index = currentReadIndex();
  try {
    localStorage.setItem(progressKey(day), JSON.stringify({
      y: Math.round(window.scrollY),
      index,
      ts: Date.now(),
    }));
  } catch (_) {}
}

function clearReadingProgress() {
  const day = currentFeedDay();
  if (!day) return;
  try { localStorage.removeItem(progressKey(day)); } catch (_) {}
}

function readReadingProgress(day) {
  try {
    const value = JSON.parse(localStorage.getItem(progressKey(day)) || "null");
    if (!value || Date.now() - Number(value.ts || 0) > PROGRESS_TTL_MS) return null;
    return value;
  } catch (_) {
    return null;
  }
}

function pruneReadingProgress() {
  try {
    const now = Date.now();
    const entries = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || (!key.startsWith("chronicle-progress:") && !key.startsWith("chronicle-reader:v1:"))) continue;
      let ts = 0;
      try {
        ts = Number(JSON.parse(localStorage.getItem(key) || "null")?.ts || 0);
      } catch (_) {}
      if (!ts || now - ts > PROGRESS_TTL_MS) {
        localStorage.removeItem(key);
        i -= 1;
      } else {
        entries.push({ key, ts });
      }
    }
    entries
      .sort((a, b) => b.ts - a.ts)
      .slice(MAX_PROGRESS_ENTRIES)
      .forEach((entry) => localStorage.removeItem(entry.key));
  } catch (_) {}
}

function currentReadIndex() {
  const items = [...document.querySelectorAll(".item[data-read-index]")];
  const anchor = Math.min(window.innerHeight * 0.35, 240);
  let current = 1;
  for (const item of items) {
    if (item.getBoundingClientRect().top <= anchor) current = Number(item.dataset.readIndex) || current;
    else break;
  }
  return current;
}

function currentFeedDay() {
  return state.archiveDate || String(state.data?.generated_at || "").slice(0, 10) || "today";
}

function progressKey(day) {
  return `chronicle-progress:${day}`;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function toggleSet(set, value) {
  set.has(value) ? set.delete(value) : set.add(value);
}
function csv(value) {
  return value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];
}
function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}
function comparableText(value) {
  return String(value || "").toLowerCase().replace(/[.…]+$/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function isDistinctExpansion(candidate, lead) {
  const candidateText = comparableText(candidate);
  const leadText = comparableText(lead);
  if (!candidateText || !leadText || candidateText === leadText) return false;
  const prefix = leadText.slice(0, Math.min(80, leadText.length));
  return prefix.length < 40 || !candidateText.startsWith(prefix);
}
function readableLine(item, title) {
  const line = item.one_liner || item.primary?.summary || "";
  const titleText = normalizeText(title);
  const lineText = normalizeText(line);
  if (!lineText || lineText === titleText) return "";
  if (titleText && lineText.startsWith(titleText)) return "";
  if (titleText.length > 40 && lineText.length > 40 && titleText.startsWith(lineText.slice(0, 80))) return "";
  if (isWeakLine(lineText)) return "";
  return decodeText(line);
}
function isWeakLine(value) {
  return value === "comments"
    || value.includes("/images/")
    || value.includes("[link] [comments]")
    || value.includes("submitted by /u/");
}
function truncateText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, Math.max(0, maxLength - 3));
  const boundary = clipped.search(/\s+\S*$/);
  const trimmed = (boundary > maxLength * 0.62 ? clipped.slice(0, boundary) : clipped).trimEnd();
  return `${trimmed.replace(/[,:;.\s]+$/, "")}...`;
}
function decodeText(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
function node(tag, className, textContent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (textContent !== undefined) element.textContent = textContent;
  return element;
}
function chip(label, active, onClick) {
  const button = document.createElement("button");
  button.className = "chip";
  button.type = "button";
  button.textContent = label;
  button.setAttribute("aria-pressed", String(active));
  button.addEventListener("click", onClick);
  return button;
}
function link(href, label) {
  const a = document.createElement("a");
  const safe = href && /^https?:\/\//i.test(href) ? href : "#";
  a.href = safe;
  a.textContent = label || href || "link";
  if (safe !== "#") {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}
function sep() {
  return Object.assign(document.createElement("span"), { className: "sep", textContent: "·" });
}
function emptyState(title, body) {
  const wrap = node("div", "empty");
  wrap.append(
    Object.assign(document.createElement("strong"), { textContent: title }),
    Object.assign(document.createElement("p"), { textContent: body }),
  );
  return wrap;
}
function showNotice(message) {
  const notice = document.getElementById("notice");
  notice.textContent = message;
  notice.classList.add("is-visible");
}
function clearNotice() {
  const notice = document.getElementById("notice");
  notice.textContent = "";
  notice.classList.remove("is-visible");
}
function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function relTime(date, includeNow = false) {
  if (!date) return "unknown";
  const diff = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (diff < 60 && includeNow) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function shortDate(date) {
  if (!date) return "unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(number) : "0";
}
function formatDay(value) {
  const date = parseDate(`${value}T00:00:00.000Z`);
  return date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : value;
}
