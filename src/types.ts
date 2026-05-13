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
  | "repo_release"
  | "repo_trending"
  | "video"
  | "course"
  | "news"
  | "unknown";

export type Quality = "signal" | "mixed" | "hype";
export type NoveltyLabel = "high" | "medium" | "familiar";
export type SourceRole = "main" | "repo" | "learning";
export type RefreshStatus = "ok" | "partial" | "failed";
export type ClassificationMode = "llm" | "partial" | "fallback" | "deterministic";
export type EnrichmentStatus = "ok" | "metadata_only" | "failed";
export type PublishedAtSource =
  | "feed"
  | "api"
  | "api_last_modified"
  | "page_metadata"
  | "sitemap_lastmod"
  | "generated_fallback";
export type DateConfidence = "high" | "medium" | "low";

export interface SourceConfig {
  id: string;
  name: string;
  type:
    | "rss"
    | "hn_algolia"
    | "reddit"
    | "hf_papers"
    | "hf_models"
    | "sitemap"
    | "github_releases"
    | "github_repo_search"
    | "github_trending"
    | "page_list"
    | "youtube_rss";
  url: string;
  trust: number;
  source_role?: SourceRole;
  kind_hint?: Kind;
  ai_filter?: boolean;
  url_include?: string[];
  url_exclude?: string[];
  title_prefix?: string;
  item_selector?: string;
  link_selector?: string;
  title_selector?: string;
  summary_selector?: string;
  date_selector?: string;
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
  source_role?: SourceRole;
  trust: number;
  kind_hint?: Kind;
  title: string;
  url: string;            // canonicalized
  original_url: string;   // pre-canonicalization, preserved for display
  discussion_url?: string;
  discussion_source?: string;
  summary?: string;
  image_url?: string;
  image_source?: string;
  published_at: string;   // ISO
  published_at_source: PublishedAtSource;
  date_confidence: DateConfidence;
  // Source-native engagement signals, optional. Used as a weak prior.
  engagement?: {
    score?: number;       // upvotes / points
    comments?: number;
  };
  repo?: RepoMetadata;
  learning?: LearningMetadata;
}

export interface RepoMetadata {
  full_name: string;
  html_url: string;
  description?: string;
  language?: string;
  license?: string;
  topics?: string[];
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  pushed_at?: string;
  created_at?: string;
  release_tag?: string;
  release_name?: string;
  stars_today?: number;
  stars_delta_run?: number;
  stars_delta_30d?: number;
  trending_period?: "daily";
  readme_image_url?: string;
}

export interface LearningMetadata {
  provider?: string;
  channel_id?: string;
  video_id?: string;
  playlist_url?: string;
  course_url?: string;
  level?: "beginner" | "intermediate" | "advanced" | "unknown";
}

export function sourceRoleOf(item: Pick<RawItem, "source_role"> | undefined): SourceRole {
  return item?.source_role ?? "main";
}

export interface Cluster {
  id: string;             // hash of primary item id
  primary: RawItem;       // highest-trust representative
  members: RawItem[];     // all items including primary
  source_trail: SourceTrailItem[];
  also_seen_on: {
    source_name: string;
    title: string;
    url: string;
    published_at: string;
    published_at_source: PublishedAtSource;
    date_confidence: DateConfidence;
    discussion_url?: string;
    discussion_source?: string;
  }[];
}

export interface SourceTrailItem {
  source_id: string;
  source_name: string;
  title: string;
  url: string;
  published_at: string;
  published_at_source: PublishedAtSource;
  date_confidence: DateConfidence;
  discussion_url?: string;
  discussion_source?: string;
}

export interface ScoredCluster extends Cluster {
  kind: Kind;
  quality: Quality;
  one_liner: string;      // <= 140 chars, factual, no hype
  novelty: number;        // 0..1
  novelty_label: NoveltyLabel;
  trust: number;          // 0..1, primary's trust
  score: number;          // composite final score
  why_this_surfaced: string[];
  builder_action: string;
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
  source_health: SourceHealth[];
  top_news?: TopNewsItem[];
  count: number;
  clusters: ScoredCluster[];
}

export type MainFeedFile = FeedFile;
export type RepoFeedFile = FeedFile;
export type LearningFeedFile = FeedFile;

export interface TopNewsItem {
  cluster_id: string;
  title: string;
  url: string;
  source_name: string;
  published_at: string;
  kind: Kind;
  score: number;
  dek: string;
  brief: string;
  image_url?: string;
  image_alt?: string;
  image_source?: string;
  enrichment_status: EnrichmentStatus;
  enriched_at: string;
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
  source_health: SourceHealth[];
}

export interface SourceHealth {
  id: string;
  name: string;
  status: "ok" | "failed";
  fetched_count: number;
  fresh_count?: number;
  stale_count?: number;
  newest_published_at?: string;
  oldest_published_at?: string;
  message?: string;
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
