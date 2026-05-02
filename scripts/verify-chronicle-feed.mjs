import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  if (!Array.isArray(feed.clusters)) {
    failures.push('Chronicle feed clusters should be an array');
    return failures;
  }
  if (Number.isFinite(feed.count) && feed.count !== feed.clusters.length) {
    failures.push(`Chronicle count ${feed.count} does not match clusters length ${feed.clusters.length}`);
  }

  feed.clusters.forEach((cluster, index) => {
    validateCluster(cluster, index, failures);
  });

  return failures;
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
  validateRawItem(cluster.primary, `${label} primary`, failures);
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
  if (!isUnitNumber(item.trust)) failures.push(`${label} trust should be a number from 0 to 1`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const feedPath = resolve(process.argv[2] ?? 'public/feed.json');
  const failures = validateChronicleFeedPath(feedPath);
  if (failures.length) {
    console.error('Chronicle feed verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('Chronicle feed verification passed.');
}
