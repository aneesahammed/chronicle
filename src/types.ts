// Core data shapes flowing through the pipeline.
//
// item     : raw unit from a single source after normalization
// cluster  : group of items judged to be the same story
// scored   : cluster + LLM classification + scores

export type Kind =
  | "paper"
  | "model_release"
  | "company_announcement"
  | "tutorial"
  | "opinion"
  | "discussion"
  | "tool"
  | "news"
  | "unknown";

export type Quality = "signal" | "mixed" | "hype";
export type RefreshStatus = "ok" | "partial" | "failed";
export type ClassificationMode = "llm" | "partial" | "fallback";

export interface SourceConfig {
  id: string;
  name: string;
  type: "rss" | "hn_algolia" | "reddit" | "hf_papers" | "hf_models" | "sitemap";
  url: string;
  trust: number;
  kind_hint?: Kind;
  ai_filter?: boolean;
  url_include?: string[];
  url_exclude?: string[];
  title_prefix?: string;
  limit: number;
}

export interface Registry {
  sources: SourceConfig[];
  hn_ai_keywords: string[];
}

export interface RawItem {
  id: string;             // stable hash of canonical url
  source_id: string;
  source_name: string;
  trust: number;
  kind_hint?: Kind;
  title: string;
  url: string;            // canonicalized
  original_url: string;   // pre-canonicalization, preserved for display
  discussion_url?: string;
  discussion_source?: string;
  summary?: string;
  published_at: string;   // ISO
  // Source-native engagement signals, optional. Used as a weak prior.
  engagement?: {
    score?: number;       // upvotes / points
    comments?: number;
  };
}

export interface Cluster {
  id: string;             // hash of primary item id
  primary: RawItem;       // highest-trust representative
  members: RawItem[];     // all items including primary
  also_seen_on: {
    source_name: string;
    url: string;
    discussion_url?: string;
    discussion_source?: string;
  }[];
}

export interface ScoredCluster extends Cluster {
  kind: Kind;
  quality: Quality;
  one_liner: string;      // <= 140 chars, factual, no hype
  novelty: number;        // 0..1
  trust: number;          // 0..1, primary's trust
  score: number;          // composite final score
}

export interface FeedFile {
  generated_at: string;
  last_successful_generated_at: string | null;
  refresh_status: RefreshStatus;
  classification_mode: ClassificationMode;
  window_hours: number;
  source_total: number;
  source_ok: number;
  source_failed: number;
  failed_sources: SourceFetchFailure[];
  count: number;
  clusters: ScoredCluster[];
}

export interface SourceFetchFailure {
  id: string;
  name: string;
  message: string;
}

export interface FetchResult {
  items: RawItem[];
  source_total: number;
  source_ok: number;
  source_failed: number;
  failed_sources: SourceFetchFailure[];
}

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  date: string; // YYYY-MM-DD
}

export interface HistoryFile {
  entries: HistoryEntry[];
}
