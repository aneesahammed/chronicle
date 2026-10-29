import type { Cluster, Kind, Quality } from "../types.ts";

// Evidence rules, not an assessment of truth. Unknown evidence stays mixed.
export function instructionalIntent(title: string, summary = ""): boolean {
  if (/\b(credits|plans|pricing|trailer|teaser|coming soon|ceo|interview|brand film|commercial)\b/i.test(title)) return false;
  const instruction = /\b(how to|tutorial|workshop|lecture|walkthrough|quickstart|hands.on|from scratch|course|lesson|introduction to|learn to|learn how|guide to|build hour)\b/i;
  return instruction.test(title) || /^build (?:your own|an? |ai |llm |rag )/i.test(title)
    || (summary.length >= 30 && (instruction.test(summary) || /\buse .{1,35} to\b/i.test(summary))
      && /\b(code|build|implement|evaluate|deploy|train|debug|using|design|api|studio)\b/i.test(title));
}

export function evidenceQuality(cluster: Cluster, kind: Kind): Quality {
  const item = cluster.primary;
  const summary = item.summary?.trim() ?? "";
  // Syllabus review is not proof that old exercises still execute successfully.
  if (item.learning?.track === "foundations") return "mixed";
  if (kind === "video" || kind === "course" || kind === "tutorial") {
    return summary.length >= 60 && instructionalIntent(item.title, summary) ? "signal" : "mixed";
  }
  if (kind === "repo_trending" || kind === "repo_release") {
    const repo = item.repo;
    const age = Date.parse(item.discovered_at ?? item.published_at) - Date.parse(repo?.pushed_at ?? "");
    const maintained = Number.isFinite(age) && age >= 0 && age <= 180 * 864e5;
    return repo?.has_readme && repo.license && repo.license !== "NOASSERTION"
      && (repo.description?.length ?? 0) >= 40 && maintained ? "signal" : "mixed";
  }
  return "mixed";
}

export function builderValue(cluster: Cluster): number {
  const { title, summary = "" } = cluster.primary;
  // Require a concrete engineering subject; novelty and publisher prestige alone
  // should not put corporate speculation at the top of a builder's digest.
  if (/\b(ipo|acquir\w*|fundrais\w*|ceo says|agi timeline|firings?|book about|partnership announcement)\b/i.test(title)) return 0;
  if (instructionalIntent(title, summary)) return 1;
  const subject = /\b(inference|llms?|language models?|agents?|rag|mcp|sdk|api|vllm|gpu|tool.call|kv cache|fine.tun\w*|alignment|diariz\w*|coding|retrieval|model release|model.*(?:releases?|available))\b/i;
  if (!subject.test(title)) return subject.test(summary) && summary.length > 80 ? 0.4 : 0.1;
  return summary.length >= 60 ? 1 : 0.55;
}
