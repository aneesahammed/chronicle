import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sourceFamilyConfig from '../src/pipeline/source-family-config.json' with { type: 'json' };

const kinds = new Set([
  'paper',
  'model_release',
  'company_announcement',
  'tutorial',
  'opinion',
  'discussion',
  'tool',
  'news',
  'unknown',
]);

const qualities = new Set(['signal', 'mixed', 'hype']);
const refreshStatuses = new Set(['ok', 'partial', 'failed']);
const classificationModes = new Set(['llm', 'partial', 'fallback']);
const enrichmentStatuses = new Set(['ok', 'metadata_only', 'failed']);
const publishedAtSources = new Set([
  'feed',
  'api',
  'api_last_modified',
  'page_metadata',
  'sitemap_lastmod',
  'generated_fallback',
]);
const dateConfidences = new Set(['high', 'medium', 'low']);
// This is an operational alert threshold, not the arXiv selection cap. It warns
// when any family is still large enough to make the feed feel one-note.
const SOURCE_FAMILY_WARNING_RATIO = 0.40;

export function validateChronicleFeedPath(feedPath) {
  const failures = [];
  if (!existsSync(feedPath)) {
    return [`Missing Chronicle feed: ${feedPath}`];
  }

  let feed;
  try {
    feed = JSON.parse(readFileSync(feedPath, 'utf8'));
  } catch (error) {
    return [`Chronicle feed is not valid JSON: ${error.message}`];
  }

  return failures.concat(validateChronicleFeed(feed));
}

export function validateChronicleFeed(feed) {
  const failures = [];
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    return ['Chronicle feed should be a JSON object'];
  }

  const requiredKeys = [
    'generated_at',
    'last_successful_generated_at',
    'refresh_status',
    'classification_mode',
    'window_hours',
    'source_total',
    'source_ok',
    'source_failed',
    'failed_sources',
    'source_health',
    'count',
    'clusters',
  ];

  for (const key of requiredKeys) {
    if (!(key in feed)) failures.push(`Chronicle feed missing key: ${key}`);
  }

  if (!isIsoDate(feed.generated_at)) failures.push('Chronicle generated_at should be an ISO date');
  if (feed.last_successful_generated_at !== null && !isIsoDate(feed.last_successful_generated_at)) {
    failures.push('Chronicle last_successful_generated_at should be null or an ISO date');
  }
  if (!refreshStatuses.has(feed.refresh_status)) {
    failures.push(`Chronicle refresh_status is invalid: ${feed.refresh_status}`);
  }
  if (!classificationModes.has(feed.classification_mode)) {
    failures.push(`Chronicle classification_mode is invalid: ${feed.classification_mode}`);
  }
  for (const key of ['window_hours', 'source_total', 'source_ok', 'source_failed', 'count']) {
    if (!Number.isFinite(feed[key])) failures.push(`Chronicle ${key} should be numeric`);
  }
  if (!Array.isArray(feed.failed_sources)) failures.push('Chronicle failed_sources should be an array');
  if (!Array.isArray(feed.source_health)) {
    failures.push('Chronicle source_health should be an array');
  } else {
    feed.source_health.forEach((source, index) => validateSourceHealth(source, index, failures));
  }
  if (!Array.isArray(feed.clusters)) {
    failures.push('Chronicle feed clusters should be an array');
    return failures;
  }
  if (feed.top_news !== undefined) validateTopNews(feed.top_news, failures);
  if (Number.isFinite(feed.count) && feed.count !== feed.clusters.length) {
    failures.push(`Chronicle count ${feed.count} does not match clusters length ${feed.clusters.length}`);
  }

  feed.clusters.forEach((cluster, index) => {
    validateCluster(cluster, index, failures);
  });

  return failures;
}

export function collectChronicleFeedWarnings(feed) {
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.clusters) || feed.clusters.length === 0) {
    return [];
  }

  const counts = new Map();
  for (const cluster of feed.clusters) {
    const sourceId = cluster?.primary?.source_id;
    if (typeof sourceId !== 'string') continue;
    const family = sourceFamily(sourceId);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }

  const warnings = [];
  for (const [family, count] of counts) {
    const ratio = count / feed.clusters.length;
    if (ratio > SOURCE_FAMILY_WARNING_RATIO) {
      warnings.push(
        `Chronicle source family "${family}" is ${Math.round(ratio * 100)}% of the feed (${count}/${feed.clusters.length})`,
      );
    }
  }
  return warnings;
}

function validateTopNews(topNews, failures) {
  if (!Array.isArray(topNews)) {
    failures.push('Chronicle top_news should be an array when present');
    return;
  }
  if (topNews.length > 5) failures.push(`Chronicle top_news has too many items: ${topNews.length}`);
  topNews.forEach((item, index) => validateTopNewsItem(item, index, failures));
}

function validateTopNewsItem(item, index, failures) {
  const label = `Chronicle top_news ${index}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    failures.push(`${label} should be an object`);
    return;
  }
  for (const key of ['cluster_id', 'title', 'url', 'source_name', 'published_at', 'kind', 'dek', 'brief', 'enrichment_status', 'enriched_at']) {
    if (!item[key] || typeof item[key] !== 'string') failures.push(`${label} missing string ${key}`);
  }
  if (!isHttpsUrl(item.url)) failures.push(`${label} url should be https: ${item.url}`);
  if (!isIsoDate(item.published_at)) failures.push(`${label} published_at should be an ISO date`);
  if (!isIsoDate(item.enriched_at)) failures.push(`${label} enriched_at should be an ISO date`);
  if (!kinds.has(item.kind)) failures.push(`${label} has invalid kind: ${item.kind}`);
  if (!isUnitNumber(item.score)) failures.push(`${label} score should be a number from 0 to 1`);
  if (!enrichmentStatuses.has(item.enrichment_status)) {
    failures.push(`${label} has invalid enrichment_status: ${item.enrichment_status}`);
  }
  validateBoundedString(item.title, `${label} title`, 240, failures);
  validateBoundedString(item.dek, `${label} dek`, 220, failures);
  validateBoundedString(item.brief, `${label} brief`, 500, failures);
  if (item.image_url !== undefined && !isHttpsUrl(item.image_url)) {
    failures.push(`${label} image_url should be https: ${item.image_url}`);
  }
  if (item.image_alt !== undefined) validateBoundedString(item.image_alt, `${label} image_alt`, 140, failures);
  if (item.image_source !== undefined) validateBoundedString(item.image_source, `${label} image_source`, 100, failures);
}

function validateCluster(cluster, index, failures) {
  const label = `Chronicle cluster ${index}`;
  if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster)) {
    failures.push(`${label} should be an object`);
    return;
  }

  if (!cluster.id || typeof cluster.id !== 'string') failures.push(`${label} missing string id`);
  if (!kinds.has(cluster.kind)) failures.push(`${label} has invalid kind: ${cluster.kind}`);
  if (!qualities.has(cluster.quality)) failures.push(`${label} has invalid quality: ${cluster.quality}`);
  if (typeof cluster.one_liner !== 'string') failures.push(`${label} missing one_liner`);
  for (const key of ['score', 'novelty', 'trust']) {
    if (!isUnitNumber(cluster[key])) failures.push(`${label} ${key} should be a number from 0 to 1`);
  }
  if (!Array.isArray(cluster.members)) failures.push(`${label} members should be an array`);
  if (!Array.isArray(cluster.also_seen_on)) failures.push(`${label} also_seen_on should be an array`);
  if (!Array.isArray(cluster.source_trail)) failures.push(`${label} source_trail should be an array`);
  validateRawItem(cluster.primary, `${label} primary`, failures);
  cluster.source_trail?.forEach((source, sourceIndex) => validateSourceTrailItem(source, `${label} source_trail ${sourceIndex}`, failures));
}

function validateRawItem(item, label, failures) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    failures.push(`${label} should be an object`);
    return;
  }

  for (const key of ['id', 'source_id', 'source_name', 'title', 'url', 'original_url', 'published_at']) {
    if (!item[key] || typeof item[key] !== 'string') failures.push(`${label} missing string ${key}`);
  }
  if (!isHttpUrl(item.url)) failures.push(`${label} url should be http(s): ${item.url}`);
  if (!isIsoDate(item.published_at)) failures.push(`${label} published_at should be an ISO date`);
  if (!publishedAtSources.has(item.published_at_source)) failures.push(`${label} has invalid published_at_source: ${item.published_at_source}`);
  if (!dateConfidences.has(item.date_confidence)) failures.push(`${label} has invalid date_confidence: ${item.date_confidence}`);
  if (!isUnitNumber(item.trust)) failures.push(`${label} trust should be a number from 0 to 1`);
}

function validateSourceTrailItem(source, label, failures) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    failures.push(`${label} should be an object`);
    return;
  }
  for (const key of ['source_id', 'source_name', 'title', 'url', 'published_at']) {
    if (!source[key] || typeof source[key] !== 'string') failures.push(`${label} missing string ${key}`);
  }
  if (!isHttpUrl(source.url)) failures.push(`${label} url should be http(s): ${source.url}`);
  if (!isIsoDate(source.published_at)) failures.push(`${label} published_at should be an ISO date`);
  if (!publishedAtSources.has(source.published_at_source)) failures.push(`${label} has invalid published_at_source: ${source.published_at_source}`);
  if (!dateConfidences.has(source.date_confidence)) failures.push(`${label} has invalid date_confidence: ${source.date_confidence}`);
}

function validateSourceHealth(source, index, failures) {
  const label = `Chronicle source_health ${index}`;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    failures.push(`${label} should be an object`);
    return;
  }
  for (const key of ['id', 'name', 'status']) {
    if (!source[key] || typeof source[key] !== 'string') failures.push(`${label} missing string ${key}`);
  }
  if (!['ok', 'failed'].includes(source.status)) failures.push(`${label} has invalid status: ${source.status}`);
  for (const key of ['fetched_count', 'fresh_count', 'stale_count']) {
    if (source[key] !== undefined && (!Number.isFinite(source[key]) || source[key] < 0)) {
      failures.push(`${label} ${key} should be a non-negative number`);
    }
  }
}

function isUnitNumber(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateBoundedString(value, label, max, failures) {
  if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
    failures.push(`${label} should be a string <= ${max} chars`);
  }
}

function sourceFamily(sourceId) {
  for (const { prefix, family } of sourceFamilyConfig.prefixFamilies) {
    if (sourceId.startsWith(prefix)) return family;
  }
  return sourceFamilyConfig.sourceFamilies[sourceId] ?? sourceId;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const feedPath = resolve(process.argv[2] ?? 'public/feed.json');
  const failures = validateChronicleFeedPath(feedPath);
  if (failures.length) {
    console.error('Chronicle feed verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const feed = JSON.parse(readFileSync(feedPath, 'utf8'));
  for (const warning of collectChronicleFeedWarnings(feed)) {
    console.warn(`Chronicle feed warning: ${warning}`);
  }
  console.log('Chronicle feed verification passed.');
}
