#!/usr/bin/env node
'use strict';

/**
 * brave-search - dependency-free Brave Search + page-content CLI for agents.
 *
 * Auth sources, in priority order:
 *   --api-key / --token, BRAVE_API_KEY, BRAVE_SEARCH_API_KEY, config profile apiKey
 *
 * Uses Node's built-in fetch and filesystem APIs. No npm install required.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');

const VERSION = '1.0.0';
const NAME = 'brave-search';
const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1';
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'brave-search', 'config.json');
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'brave-search');
const USER_AGENT = `${NAME}/${VERSION} node/${process.version}`;

class CliError extends Error {
  constructor(message, code = 1, details = undefined) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

const SHORT_FLAGS = {
  C: 'country',
  c: 'count',
  f: 'freshness',
  h: 'help',
  k: 'apiKey',
  l: 'searchLang',
  n: 'count',
  o: 'output',
  q: 'q',
  v: 'verbose'
};

const REPEATABLE_FLAGS = new Set([
  'filter', 'resultFilter', 'header', 'param', 'query', 'variation', 'url', 'column'
]);

const BOOLEAN_FLAGS = new Set([
  'help', 'verbose', 'quiet', 'raw', 'json', 'pretty', 'table', 'markdown', 'md',
  'urls', 'ndjson', 'fetch', 'content', 'noCache', 'spellcheck', 'summary',
  'textDecorations', 'extraSnippets', 'includeRaw', 'links', 'headings',
  'debug', 'showRateLimit', 'rateLimit'
]);

const SEARCH_ENDPOINTS = {
  search: '/web/search',
  web: '/web/search',
  news: '/news/search',
  image: '/images/search',
  images: '/images/search',
  video: '/videos/search',
  videos: '/videos/search',
  suggest: '/suggest/search',
  suggestions: '/suggest/search',
  spell: '/spellcheck/search',
  spellcheck: '/spellcheck/search'
};

const SEARCH_COMMANDS = new Set(Object.keys(SEARCH_ENDPOINTS));
const COMMANDS = new Set([
  ...SEARCH_COMMANDS,
  'fetch', 'content', 'page', 'research', 'multi', 'batch', 'request',
  'rate-limit', 'limits', 'auth', 'config', 'help', 'version'
]);

function normalizeFlagName(name) {
  return String(name).replace(/^-+/, '').replace(/-([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

function addFlag(flags, key, value) {
  key = normalizeFlagName(key);
  if (REPEATABLE_FLAGS.has(key)) {
    if (!Array.isArray(flags[key])) flags[key] = flags[key] === undefined ? [] : [flags[key]];
    flags[key].push(value);
  } else if (flags[key] !== undefined) {
    if (!Array.isArray(flags[key])) flags[key] = [flags[key]];
    flags[key].push(value);
  } else {
    flags[key] = value;
  }
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      if (arg.startsWith('--no-')) {
        addFlag(flags, arg.slice(5), false);
        continue;
      }
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        addFlag(flags, arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const normalized = normalizeFlagName(key);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(normalized)) {
        addFlag(flags, key, true);
      } else if (next !== undefined && (!next.startsWith('-') || /^-?\d+(\.\d+)?$/.test(next))) {
        addFlag(flags, key, next);
        i += 1;
      } else {
        addFlag(flags, key, true);
      }
      continue;
    }

    if (/^-[A-Za-z]$/.test(arg)) {
      const key = SHORT_FLAGS[arg.slice(1)] || arg.slice(1);
      const normalized = normalizeFlagName(key);
      const next = argv[i + 1];
      if (BOOLEAN_FLAGS.has(normalized)) {
        addFlag(flags, key, true);
      } else if (next !== undefined) {
        addFlag(flags, key, next);
        i += 1;
      } else {
        addFlag(flags, key, true);
      }
      continue;
    }

    positionals.push(arg);
  }

  return { flags, positionals };
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch (_) { /* best effort */ }
}

function readJsonFile(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`Failed to read JSON file ${file}: ${error.message}`);
  }
}

function writeJsonFile(file, value) {
  ensureDir(path.dirname(file), 0o700);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return defaultValue;
}

function parseNumber(value, defaultValue, { min, max, integer = true } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = integer ? parseInt(String(value), 10) : Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  let out = n;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

function parseDurationMs(value, defaultValue, defaultUnitMs = 1000) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'number') return value;
  const s = String(value).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return defaultValue;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : defaultUnitMs;
  return Math.max(0, Math.round(n * mult));
}

function parseConfigValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
  return value;
}

function readConfig(configPath) {
  const config = readJsonFile(configPath, {});
  if (!config.profiles && Object.keys(config).length > 0) {
    // Accept a flat legacy config as the default profile.
    return { profile: 'default', profiles: { default: config } };
  }
  if (!config.profile) config.profile = 'default';
  if (!config.profiles) config.profiles = {};
  return config;
}

function activeProfile(config, requestedProfile) {
  const name = requestedProfile || config.profile || 'default';
  const defaults = config.defaults && typeof config.defaults === 'object' ? config.defaults : {};
  const profile = config.profiles && config.profiles[name] ? config.profiles[name] : {};
  return { name, profile: { ...defaults, ...profile } };
}

function maskSecret(value) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function sanitizedConfig(config) {
  const copy = JSON.parse(JSON.stringify(config || {}));
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [key, value] of Object.entries(obj)) {
      if (/key|token|secret|password/i.test(key) && typeof value === 'string') obj[key] = maskSecret(value);
      else walk(value);
    }
  }
  walk(copy);
  return copy;
}

function buildContext(parsed) {
  const flags = parsed.flags;
  const configPath = expandHome(firstDefined(flags.config, process.env.BRAVE_SEARCH_CONFIG, DEFAULT_CONFIG_PATH));
  const config = readConfig(configPath);
  const { name: profileName, profile } = activeProfile(config, flags.profile);

  const apiKey = firstDefined(
    flags.apiKey,
    flags.token,
    process.env.BRAVE_API_KEY,
    process.env.BRAVE_SEARCH_API_KEY,
    profile.apiKey,
    profile.token
  );

  let output = firstDefined(flags.output, profile.output, 'markdown');
  if (flags.json) output = 'json';
  if (flags.pretty) output = 'pretty';
  if (flags.table) output = 'table';
  if (flags.markdown || flags.md) output = 'markdown';
  if (flags.urls) output = 'urls';
  if (flags.ndjson) output = 'ndjson';
  if (flags.raw) output = 'raw';

  const rateLimitEnabled = flags.rateLimit !== false && profile.rateLimit !== false;

  return {
    flags,
    positionals: parsed.positionals,
    config,
    configPath,
    profileName,
    profile,
    apiKey,
    baseUrl: firstDefined(flags.baseUrl, profile.baseUrl, DEFAULT_BASE_URL),
    cacheDir: expandHome(firstDefined(flags.cacheDir, profile.cacheDir, DEFAULT_CACHE_DIR)),
    cacheTtlMs: parseDurationMs(firstDefined(flags.cacheTtl, profile.cacheTtl), 0),
    output,
    timeoutMs: parseDurationMs(firstDefined(flags.timeout, profile.timeout), 20000),
    fetchTimeoutMs: parseDurationMs(firstDefined(flags.fetchTimeout, profile.fetchTimeout, flags.timeout, profile.timeout), 20000),
    retries: parseNumber(firstDefined(flags.retries, profile.retries), 3, { min: 0, max: 10 }),
    retryDelayMs: parseDurationMs(firstDefined(flags.retryDelay, profile.retryDelay), 1200),
    maxBytes: parseNumber(firstDefined(flags.maxBytes, profile.maxBytes), 2_000_000, { min: 1024, max: 50_000_000 }),
    maxChars: parseNumber(firstDefined(flags.maxChars, profile.maxChars), 12000, { min: 100, max: 500000 }),
    contentChars: parseNumber(firstDefined(flags.contentChars, profile.contentChars), 6000, { min: 100, max: 500000 }),
    concurrency: parseNumber(firstDefined(flags.concurrency, profile.concurrency), 1, { min: 1, max: 10 }),
    rateLimitEnabled,
    minApiIntervalMs: rateLimitEnabled ? parseDurationMs(firstDefined(flags.minApiInterval, flags.minApiIntervalMs, flags.rateLimitInterval, profile.minApiInterval, profile.minApiIntervalMs, profile.rateLimitInterval), 1100, 1) : 0,
    apiRateQueue: Promise.resolve(),
    lastApiRequestAt: 0,
    lastRateLimit: undefined
  };
}

function getProfileOption(ctx, flagName, profileName, fallback = undefined) {
  return firstDefined(ctx.flags[flagName], ctx.profile[profileName || flagName], fallback);
}

function parseKeyValue(text, label = 'value') {
  const eq = String(text).indexOf('=');
  if (eq === -1) throw new CliError(`${label} must be key=value: ${text}`);
  return [String(text).slice(0, eq), String(text).slice(eq + 1)];
}

function addCommonSearchParams(params, ctx, kind, query) {
  const flags = ctx.flags;
  const set = (key, value) => {
    if (value !== undefined && value !== null && value !== '') params[key] = value;
  };

  set('q', query);
  set('country', getProfileOption(ctx, 'country'));
  set('search_lang', firstDefined(flags.searchLang, flags.lang, ctx.profile.searchLang, ctx.profile.lang));
  set('ui_lang', firstDefined(flags.uiLang, ctx.profile.uiLang));
  set('count', getProfileOption(ctx, 'count'));
  set('offset', getProfileOption(ctx, 'offset'));
  set('safesearch', firstDefined(flags.safesearch, flags.safe, ctx.profile.safesearch, ctx.profile.safe));
  set('freshness', firstDefined(flags.freshness, ctx.profile.freshness));
  set('goggles_id', firstDefined(flags.gogglesId, ctx.profile.gogglesId));
  set('units', firstDefined(flags.units, ctx.profile.units));

  if (flags.from && flags.to) set('freshness', `${flags.from}to${flags.to}`);
  if (flags.spellcheck !== undefined) set('spellcheck', parseBoolean(flags.spellcheck) ? '1' : '0');
  if (flags.summary !== undefined) set('summary', parseBoolean(flags.summary) ? '1' : '0');
  if (flags.extraSnippets !== undefined) set('extra_snippets', parseBoolean(flags.extraSnippets) ? 'true' : 'false');
  if (flags.textDecorations !== undefined) set('text_decorations', parseBoolean(flags.textDecorations) ? 'true' : 'false');
  else if (!['suggest', 'suggestions', 'spell', 'spellcheck'].includes(kind)) set('text_decorations', 'false');

  const filters = [...toArray(flags.resultFilter), ...toArray(flags.filter)]
    .flatMap((item) => String(item).split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  if (filters.length) set('result_filter', [...new Set(filters)].join(','));

  for (const item of toArray(flags.param)) {
    const [key, value] = parseKeyValue(item, '--param');
    set(key, value);
  }

  if (kind === 'suggest' || kind === 'suggestions' || kind === 'spell' || kind === 'spellcheck') {
    delete params.count;
    delete params.offset;
    delete params.result_filter;
  }
}

function urlForEndpoint(ctx, endpoint, params = {}) {
  const base = String(ctx.baseUrl).replace(/\/+$/, '');
  const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? new URL(endpoint)
    : new URL(`${base}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    for (const item of toArray(value)) url.searchParams.append(key, String(item));
  }
  return url;
}

function parseHeaders(headerFlags) {
  const headers = {};
  for (const item of toArray(headerFlags)) {
    const [key, value] = parseKeyValue(item, '--header');
    headers[key] = value;
  }
  return headers;
}

function cachePathFor(ctx, method, url) {
  const hash = crypto.createHash('sha256').update(`${method.toUpperCase()} ${url}`).digest('hex');
  return path.join(ctx.cacheDir, `${hash}.json`);
}

function readCache(ctx, method, url) {
  if (ctx.cacheTtlMs <= 0 || ctx.flags.noCache || ctx.flags.cache === false) return undefined;
  const file = cachePathFor(ctx, method, url);
  try {
    if (!fs.existsSync(file)) return undefined;
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!cached.created || Date.now() - cached.created > ctx.cacheTtlMs) return undefined;
    return cached.data;
  } catch (_) {
    return undefined;
  }
}

function writeCache(ctx, method, url, data) {
  if (ctx.cacheTtlMs <= 0 || ctx.flags.noCache || ctx.flags.cache === false) return;
  try {
    ensureDir(ctx.cacheDir, 0o700);
    const file = cachePathFor(ctx, method, url);
    fs.writeFileSync(file, JSON.stringify({ created: Date.now(), url: String(url), data }) + '\n', { mode: 0o600 });
  } catch (_) {
    // Cache failures should never break search.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForApiSlot(ctx) {
  if (!ctx.minApiIntervalMs) return;
  const previous = ctx.apiRateQueue || Promise.resolve();
  let release;
  ctx.apiRateQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const elapsed = Date.now() - (ctx.lastApiRequestAt || 0);
    const waitMs = Math.max(0, ctx.minApiIntervalMs - elapsed);
    if (waitMs > 0) {
      if (ctx.flags.verbose) process.stderr.write(`rate-limit wait ${waitMs}ms\n`);
      await sleep(waitMs);
    }
    ctx.lastApiRequestAt = Date.now();
  } finally {
    release();
  }
}

function splitHeaderValues(value) {
  return value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function toMaybeNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

function rateLimitFromHeaders(headers) {
  const limit = headers.get('x-ratelimit-limit');
  const policy = headers.get('x-ratelimit-policy');
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const retryAfter = headers.get('retry-after');
  if (!limit && !policy && !remaining && !reset && !retryAfter) return undefined;

  const limits = splitHeaderValues(limit);
  const policies = splitHeaderValues(policy);
  const remainings = splitHeaderValues(remaining);
  const resets = splitHeaderValues(reset);
  const windows = policies.length || limits.length || remainings.length || resets.length
    ? Array.from({ length: Math.max(policies.length, limits.length, remainings.length, resets.length) }, (_, index) => {
      const match = policies[index] && policies[index].match(/^(\d+(?:\.\d+)?);w=(\d+(?:\.\d+)?)/);
      return {
        limit: toMaybeNumber(match ? match[1] : limits[index]),
        window_seconds: toMaybeNumber(match ? match[2] : undefined),
        policy: policies[index],
        remaining: toMaybeNumber(remainings[index]),
        reset_seconds: toMaybeNumber(resets[index])
      };
    })
    : [];

  return {
    limit,
    policy,
    remaining,
    reset,
    retry_after: retryAfter || undefined,
    windows
  };
}

function retryDelayFromHeaders(headers, fallbackMs) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter)) return Math.max(0, Number(retryAfter) * 1000);
  const rateLimit = rateLimitFromHeaders(headers);
  const resets = (rateLimit?.windows || [])
    .map((window) => Number(window.reset_seconds))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (resets.length) return Math.max(1000, Math.min(60000, (Math.min(...resets) + 0.1) * 1000));
  return fallbackMs;
}

function monthlyQuotaExhausted(data) {
  const meta = data && data.error && data.error.meta;
  if (!meta) return false;
  const quotaLimit = Number(meta.quota_limit);
  const quotaCurrent = Number(meta.quota_current);
  return Number.isFinite(quotaLimit) && quotaLimit > 0 && Number.isFinite(quotaCurrent) && quotaCurrent >= quotaLimit;
}

function summarizeRateLimit(rateLimit) {
  if (!rateLimit || !rateLimit.windows || !rateLimit.windows.length) return undefined;
  return rateLimit.windows.map((window) => {
    const parts = [];
    if (window.limit !== undefined) parts.push(`${window.limit} request${window.limit === 1 ? '' : 's'}`);
    if (window.window_seconds !== undefined) parts.push(`per ${window.window_seconds}s`);
    if (window.remaining !== undefined) parts.push(`${window.remaining} remaining`);
    if (window.reset_seconds !== undefined) parts.push(`resets in ${window.reset_seconds}s`);
    return parts.join(' ');
  }).join('; ');
}

async function apiRequest(ctx, endpoint, params = {}, { method = 'GET', body = undefined, auth = true, includeMeta = false, cache = true } = {}) {
  if (auth && !ctx.apiKey) {
    throw new CliError(`No Brave Search API key found. Set BRAVE_API_KEY/BRAVE_SEARCH_API_KEY or run: ${NAME} config set apiKey -`);
  }

  const url = urlForEndpoint(ctx, endpoint, params);
  const cacheable = cache && method.toUpperCase() === 'GET';
  if (cacheable) {
    const cached = readCache(ctx, method, url);
    if (cached !== undefined) {
      if (ctx.flags.verbose) process.stderr.write(`cache hit: ${url}\n`);
      return includeMeta ? { data: cached, cached: true, url: String(url), rate_limit: ctx.lastRateLimit } : cached;
    }
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    ...parseHeaders(ctx.flags.header)
  };
  if (auth) headers['X-Subscription-Token'] = ctx.apiKey;
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  let lastError;
  for (let attempt = 0; attempt <= ctx.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      await waitForApiSlot(ctx);
      if (ctx.flags.verbose) process.stderr.write(`${method.toUpperCase()} ${url}\n`);
      const response = await fetch(url, {
        method: method.toUpperCase(),
        headers,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

      const rateLimit = rateLimitFromHeaders(response.headers);
      if (rateLimit) {
        ctx.lastRateLimit = rateLimit;
        if (ctx.flags.showRateLimit) process.stderr.write(`rate-limit ${JSON.stringify(rateLimit)}\n`);
      }

      if (!response.ok) {
        const detail = typeof data === 'string' ? data.slice(0, 1000) : JSON.stringify(data);
        const retryable = [408, 429, 500, 502, 503, 504].includes(response.status) && !monthlyQuotaExhausted(data);
        if (retryable && attempt < ctx.retries) {
          const retryDelay = retryDelayFromHeaders(response.headers, ctx.retryDelayMs * Math.pow(2, attempt));
          if (ctx.flags.verbose) process.stderr.write(`retry in ${retryDelay}ms after ${response.status}\n`);
          await sleep(retryDelay);
          continue;
        }
        throw new CliError(`Brave API request failed (${response.status} ${response.statusText}): ${detail}`, response.status >= 500 ? 2 : 1, data);
      }

      if (cacheable) writeCache(ctx, method, url, data);
      return includeMeta ? { data, status: response.status, url: String(url), rate_limit: rateLimit } : data;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (error.name === 'AbortError') lastError = new CliError(`Request timed out after ${ctx.timeoutMs}ms: ${url}`);
      if (attempt < ctx.retries && !(lastError instanceof CliError && lastError.code === 1)) {
        const retryDelay = ctx.retryDelayMs * Math.pow(2, attempt);
        if (ctx.flags.verbose) process.stderr.write(`retry in ${retryDelay}ms after error: ${lastError.message}\n`);
        await sleep(retryDelay);
        continue;
      }
      break;
    }
  }

  if (lastError instanceof CliError) throw lastError;
  throw new CliError(`Request failed: ${lastError ? lastError.message : 'unknown error'}`);
}

function stripHtml(value) {
  if (value === undefined || value === null) return '';
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function normalizeResult(item, category, index) {
  const url = item.url || item.page_url || item.profile?.url || item.thumbnail?.original || item.properties?.url || '';
  const source = item.meta_url?.hostname || item.meta_url?.netloc || item.source || item.publisher || hostFromUrl(url);
  const title = item.title || item.name || item.heading || item.profile?.name || url || '(untitled)';
  const description = item.description || item.snippet || item.body || item.content || '';
  const thumbnail = item.thumbnail?.src || item.thumbnail?.url || item.thumbnail?.original || item.image?.url || item.properties?.url || undefined;
  const normalized = {
    rank: index + 1,
    category,
    title: stripHtml(title),
    url,
    source: stripHtml(source),
    description: stripHtml(description),
    age: item.age || item.page_age || item.published || item.date || undefined,
    language: item.language || undefined,
    family_friendly: item.family_friendly,
    type: item.type || undefined
  };
  if (thumbnail) normalized.thumbnail = thumbnail;
  if (item.duration) normalized.duration = item.duration;
  if (item.views) normalized.views = item.views;
  if (item.creator) normalized.creator = stripHtml(item.creator);
  if (item.properties) normalized.properties = item.properties;
  if (Array.isArray(item.extra_snippets) && item.extra_snippets.length) {
    normalized.extra_snippets = item.extra_snippets.map(stripHtml).filter(Boolean);
  }
  return normalized;
}

function normalizeSearchResponse(kind, query, raw, ctx, params = {}) {
  const results = [];
  const sections = ['web', 'news', 'videos', 'images', 'discussions', 'faq', 'locations'];
  for (const section of sections) {
    const bucket = raw && raw[section];
    if (bucket && Array.isArray(bucket.results)) {
      for (const item of bucket.results) results.push(normalizeResult(item, section, results.length));
    }
  }

  if (raw && Array.isArray(raw.results)) {
    for (const item of raw.results) results.push(normalizeResult(item, kind, results.length));
  }

  // Brave suggestions/spellcheck responses are compact and not always result arrays.
  if (!results.length && raw && Array.isArray(raw.query?.suggestions)) {
    for (const suggestion of raw.query.suggestions) {
      results.push({ rank: results.length + 1, category: 'suggestion', title: stripHtml(suggestion), url: '', source: '', description: '' });
    }
  }
  if (!results.length && raw && Array.isArray(raw.suggestions)) {
    for (const suggestion of raw.suggestions) {
      const text = typeof suggestion === 'string' ? suggestion : suggestion.query || suggestion.text || JSON.stringify(suggestion);
      results.push({ rank: results.length + 1, category: 'suggestion', title: stripHtml(text), url: '', source: '', description: '' });
    }
  }

  const output = {
    type: 'brave_search',
    kind,
    query,
    requested_at: new Date().toISOString(),
    params: sanitizedParams(params),
    result_count: results.length,
    query_info: raw ? raw.query : undefined,
    answer: normalizeAnswer(raw),
    infobox: raw ? raw.infobox : undefined,
    summarizer: raw ? raw.summarizer : undefined,
    results
  };

  if (ctx.flags.includeRaw) output.raw = raw;
  return output;
}

function sanitizedParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (/key|token|secret/i.test(key)) out[key] = maskSecret(value);
    else out[key] = value;
  }
  return out;
}

function normalizeAnswer(raw) {
  if (!raw) return undefined;
  if (raw.answer) return raw.answer;
  if (raw.calculator) return raw.calculator;
  if (raw.currency) return raw.currency;
  if (raw.time_zone) return raw.time_zone;
  if (raw.unit_converter) return raw.unit_converter;
  return undefined;
}

function getQuery(args, flags) {
  const fromFlags = firstDefined(flags.q, flags.queryText, flags.queryString);
  if (fromFlags) return String(fromFlags).trim();
  return args.join(' ').trim();
}

async function commandSearch(ctx, kind, args) {
  const query = getQuery(args, ctx.flags);
  if (!query) throw new CliError(`Usage: ${NAME} ${kind} "search query"`);
  const endpoint = SEARCH_ENDPOINTS[kind] || SEARCH_ENDPOINTS.web;
  const params = {};
  addCommonSearchParams(params, ctx, kind, query);
  const raw = await apiRequest(ctx, endpoint, params);
  const normalized = normalizeSearchResponse(kind, query, raw, ctx, params);

  if (parseBoolean(firstDefined(ctx.flags.fetch, ctx.flags.content), false)) {
    await attachFetchedContent(ctx, normalized);
  }

  outputData(ctx.flags.raw ? raw : normalized, ctx);
}

async function attachFetchedContent(ctx, normalized) {
  const urls = normalized.results.filter((r) => r.url && /^https?:\/\//i.test(r.url));
  const fetchCount = parseNumber(firstDefined(ctx.flags.fetchCount, ctx.flags.contentCount), Math.min(3, urls.length), { min: 1, max: 20 });
  const targets = urls.slice(0, fetchCount);
  const fetched = await mapLimit(targets, ctx.concurrency, async (result) => {
    try {
      const page = await fetchPage(result.url, ctx, { maxChars: ctx.contentChars });
      return { result, page };
    } catch (error) {
      return { result, page: { type: 'page_fetch_error', url: result.url, error: error.message } };
    }
  });

  for (const { result, page } of fetched) {
    result.content = {
      title: page.title,
      final_url: page.final_url,
      status: page.status,
      content_type: page.content_type,
      text: page.text,
      error: page.error,
      truncated: page.truncated
    };
  }
}

async function commandResearch(ctx, args) {
  const baseQuery = getQuery(args, ctx.flags);
  if (!baseQuery) throw new CliError(`Usage: ${NAME} research "topic"`);
  const variationCount = parseNumber(ctx.flags.variations, 5, { min: 1, max: 20 });
  const variations = toArray(ctx.flags.variation).map(String).filter(Boolean);
  while (variations.length < variationCount) {
    const generated = generateVariations(baseQuery);
    for (const item of generated) {
      if (!variations.includes(item)) variations.push(item);
      if (variations.length >= variationCount) break;
    }
  }

  const kind = firstDefined(ctx.flags.kind, 'web');
  const searches = await mapLimit(variations.slice(0, variationCount), ctx.concurrency, async (query) => {
    const params = {};
    addCommonSearchParams(params, ctx, kind, query);
    const raw = await apiRequest(ctx, SEARCH_ENDPOINTS[kind] || SEARCH_ENDPOINTS.web, params);
    return normalizeSearchResponse(kind, query, raw, ctx, params);
  });

  const seen = new Set();
  const results = [];
  for (const search of searches) {
    for (const result of search.results) {
      const key = normalizeUrlKey(result.url) || `${result.title}|${result.source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ ...result, source_query: search.query, rank: results.length + 1 });
    }
  }

  const output = {
    type: 'brave_research',
    query: baseQuery,
    kind,
    requested_at: new Date().toISOString(),
    variations: variations.slice(0, variationCount),
    result_count: results.length,
    results,
    searches: searches.map((s) => ({ query: s.query, result_count: s.result_count, answer: s.answer, query_info: s.query_info }))
  };

  if (parseBoolean(firstDefined(ctx.flags.fetch, ctx.flags.content), false)) {
    await attachFetchedContent(ctx, output);
  }

  outputData(output, ctx);
}

function generateVariations(query) {
  const q = query.trim().replace(/^['"]|['"]$/g, '');
  const currentYear = new Date().getUTCFullYear();
  return [
    q,
    `${q} official documentation`,
    `${q} overview`,
    `${q} latest ${currentYear}`,
    `${q} examples`,
    `${q} tutorial`,
    `${q} reference`,
    `${q} best practices`,
    `${q} troubleshooting`,
    `${q} site:github.com`
  ];
}

function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.sort();
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

async function commandMulti(ctx, args) {
  let queries = toArray(ctx.flags.query).map(String).filter(Boolean);
  if (args.length) queries.push(...args.join(' ').split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean));
  if (!queries.length) queries = (await readStdin()).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!queries.length) throw new CliError(`Usage: ${NAME} multi --query "one" --query "two"`);

  const kind = firstDefined(ctx.flags.kind, 'web');
  const searches = await mapLimit(queries, ctx.concurrency, async (query) => {
    const params = {};
    addCommonSearchParams(params, ctx, kind, query);
    const raw = await apiRequest(ctx, SEARCH_ENDPOINTS[kind] || SEARCH_ENDPOINTS.web, params);
    return normalizeSearchResponse(kind, query, raw, ctx, params);
  });

  outputData({ type: 'brave_multi_search', kind, requested_at: new Date().toISOString(), query_count: queries.length, searches }, ctx);
}

async function commandBatch(ctx, args) {
  let input = '';
  if (ctx.flags.file) input = fs.readFileSync(expandHome(ctx.flags.file), 'utf8');
  else if (args.length) input = args.join('\n');
  else input = await readStdin();
  const queries = input.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  if (!queries.length) throw new CliError(`Usage: ${NAME} batch < queries.txt`);

  const kind = firstDefined(ctx.flags.kind, 'web');
  const searches = await mapLimit(queries, ctx.concurrency, async (query) => {
    const params = {};
    addCommonSearchParams(params, ctx, kind, query);
    const raw = await apiRequest(ctx, SEARCH_ENDPOINTS[kind] || SEARCH_ENDPOINTS.web, params);
    return normalizeSearchResponse(kind, query, raw, ctx, params);
  });

  outputData({ type: 'brave_batch_search', kind, requested_at: new Date().toISOString(), query_count: queries.length, searches }, ctx);
}

async function commandRequest(ctx, args) {
  let method = 'GET';
  let endpoint;
  if (args[0] && /^[A-Z]+$/i.test(args[0]) && args[1]) {
    method = args[0].toUpperCase();
    endpoint = args[1];
  } else {
    endpoint = args[0];
  }
  if (!endpoint) throw new CliError(`Usage: ${NAME} request [METHOD] /endpoint --param key=value`);
  const params = {};
  for (const item of toArray(ctx.flags.param)) {
    const [key, value] = parseKeyValue(item, '--param');
    params[key] = value;
  }
  const body = ctx.flags.data ? await readDataArg(ctx.flags.data) : undefined;
  const data = await apiRequest(ctx, endpoint, params, { method, body });
  outputData(data, ctx);
}

async function readDataArg(value) {
  if (value === '-') return readStdin();
  if (String(value).startsWith('@')) return fs.readFileSync(expandHome(String(value).slice(1)), 'utf8');
  return value;
}

async function commandRateLimit(ctx, args = []) {
  const query = args.length ? args.join(' ') : 'test';
  const response = await apiRequest(ctx, '/web/search', { q: query, count: '1', text_decorations: 'false' }, { includeMeta: true, cache: false });
  outputData({
    type: 'brave_rate_limit',
    ok: true,
    message: 'Observed Brave rate-limit headers from a live web search request. This consumes one successful API request.',
    profile: ctx.profileName,
    query,
    summary: summarizeRateLimit(response.rate_limit),
    rate_limit: response.rate_limit,
    result_count: response.data?.web?.results?.length || 0
  }, ctx);
}

async function commandAuth(ctx, args) {
  const sub = args[0] || 'check';
  if (sub === 'show') {
    outputData({
      api_key_found: Boolean(ctx.apiKey),
      api_key: ctx.apiKey ? maskSecret(ctx.apiKey) : null,
      source: ctx.flags.apiKey || ctx.flags.token ? 'flag' : process.env.BRAVE_API_KEY ? 'BRAVE_API_KEY' : process.env.BRAVE_SEARCH_API_KEY ? 'BRAVE_SEARCH_API_KEY' : 'config',
      profile: ctx.profileName,
      config_path: ctx.configPath,
      in_process_rate_limit: {
        enabled: ctx.rateLimitEnabled,
        min_api_interval_ms: ctx.minApiIntervalMs
      }
    }, ctx);
    return;
  }
  if (sub === 'limits' || sub === 'limit' || sub === 'rate-limit') return commandRateLimit(ctx, args.slice(1));
  if (sub !== 'check' && sub !== 'verify') throw new CliError(`Usage: ${NAME} auth [check|show|limits]`);
  const response = await apiRequest(ctx, '/web/search', { q: 'test', count: '1', text_decorations: 'false' }, { includeMeta: true, cache: false });
  outputData({
    ok: true,
    message: 'Brave Search API key works.',
    profile: ctx.profileName,
    query_info: response.data.query,
    result_count: response.data.web?.results?.length || 0,
    rate_limit_summary: summarizeRateLimit(response.rate_limit),
    rate_limit: response.rate_limit
  }, ctx);
}

async function commandConfig(ctx, args) {
  const sub = args[0] || 'show';
  const config = ctx.config;
  const profileName = ctx.profileName || 'default';

  if (sub === 'path') {
    process.stdout.write(`${ctx.configPath}\n`);
    return;
  }

  if (sub === 'show') {
    outputData({ config_path: ctx.configPath, active_profile: profileName, config: sanitizedConfig(config) }, ctx);
    return;
  }

  if (sub === 'profiles') {
    outputData({ active_profile: config.profile || 'default', profiles: Object.keys(config.profiles || {}) }, ctx);
    return;
  }

  if (sub === 'use') {
    const name = args[1];
    if (!name) throw new CliError(`Usage: ${NAME} config use <profile>`);
    config.profile = name;
    if (!config.profiles) config.profiles = {};
    if (!config.profiles[name]) config.profiles[name] = {};
    writeJsonFile(ctx.configPath, config);
    outputData({ ok: true, active_profile: name, config_path: ctx.configPath }, ctx);
    return;
  }

  if (sub === 'get') {
    const key = args[1];
    if (!key) throw new CliError(`Usage: ${NAME} config get <key>`);
    const profile = (config.profiles ||= {})[profileName] || {};
    const value = getNested(profile, normalizeConfigKey(key));
    outputData(/key|token|secret/i.test(key) ? maskSecret(value) : value, ctx);
    return;
  }

  if (sub === 'set') {
    let key = args[1];
    if (!key) throw new CliError(`Usage: ${NAME} config set <key> <value|->`);
    key = normalizeConfigKey(key);
    let value = args.slice(2).join(' ');
    if (!value) throw new CliError(`Usage: ${NAME} config set <key> <value|->`);
    if (value === '-') value = (await readStdin()).trim();
    const profile = ((config.profiles ||= {})[profileName] ||= {});
    setNested(profile, key, parseConfigValue(value));
    if (!config.profile) config.profile = profileName;
    writeJsonFile(ctx.configPath, config);
    outputData({ ok: true, profile: profileName, key, value: /key|token|secret/i.test(key) ? maskSecret(value) : parseConfigValue(value), config_path: ctx.configPath }, ctx);
    return;
  }

  if (sub === 'unset') {
    let key = args[1];
    if (!key) throw new CliError(`Usage: ${NAME} config unset <key>`);
    key = normalizeConfigKey(key);
    const profile = ((config.profiles ||= {})[profileName] ||= {});
    deleteNested(profile, key);
    writeJsonFile(ctx.configPath, config);
    outputData({ ok: true, profile: profileName, unset: key, config_path: ctx.configPath }, ctx);
    return;
  }

  throw new CliError(`Unknown config command: ${sub}`);
}

function normalizeConfigKey(key) {
  if (key === 'token' || key === 'api-key' || key === 'api_key') return 'apiKey';
  return normalizeFlagName(key);
}

function getNested(obj, key) {
  return String(key).split('.').filter(Boolean).reduce((cur, part) => cur == null ? undefined : cur[part], obj);
}

function setNested(obj, key, value) {
  const parts = String(key).split('.').filter(Boolean);
  let cur = obj;
  while (parts.length > 1) {
    const part = parts.shift();
    if (!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[0]] = value;
}

function deleteNested(obj, key) {
  const parts = String(key).split('.').filter(Boolean);
  let cur = obj;
  while (parts.length > 1) {
    cur = cur[parts.shift()];
    if (!cur || typeof cur !== 'object') return;
  }
  delete cur[parts[0]];
}

async function commandFetch(ctx, args) {
  const url = firstDefined(args[0], ctx.flags.url);
  if (!url) throw new CliError(`Usage: ${NAME} fetch https://example.com`);
  const page = await fetchPage(url, ctx, { maxChars: ctx.maxChars });
  outputData(page, ctx);
}

async function fetchPage(inputUrl, ctx, { maxChars } = {}) {
  let url;
  try { url = new URL(inputUrl); } catch (_) { throw new CliError(`Invalid URL: ${inputUrl}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new CliError(`Only http(s) URLs can be fetched: ${inputUrl}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.fetchTimeoutMs);
  try {
    if (ctx.flags.verbose) process.stderr.write(`FETCH ${url}\n`);
    const response = await fetch(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
        'User-Agent': firstDefined(ctx.flags.userAgent, ctx.profile.userAgent, USER_AGENT)
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timer);

    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length');
    const { text, truncated: byteTruncated } = await readResponseTextLimited(response, ctx.maxBytes);
    const finalUrl = response.url || String(url);

    let page;
    if (/html|xml/i.test(contentType) || /<html[\s>]/i.test(text)) {
      page = extractHtmlPage(text, finalUrl, { maxChars: maxChars || ctx.maxChars, includeLinks: ctx.flags.links !== false, includeHeadings: ctx.flags.headings !== false });
    } else if (/json/i.test(contentType)) {
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { /* keep raw */ }
      page = { title: '', description: '', text: truncate(pretty, maxChars || ctx.maxChars), links: [], headings: [] };
    } else if (/^text\//i.test(contentType) || !contentType) {
      page = { title: '', description: '', text: truncate(text, maxChars || ctx.maxChars), links: [], headings: [] };
    } else {
      page = { title: '', description: '', text: `[non-text content: ${contentType || 'unknown'}]`, links: [], headings: [] };
    }

    return {
      type: 'page_fetch',
      url: String(url),
      final_url: finalUrl,
      status: response.status,
      ok: response.ok,
      content_type: contentType,
      content_length: contentLength ? Number(contentLength) : undefined,
      fetched_at: new Date().toISOString(),
      title: page.title,
      description: page.description,
      canonical_url: page.canonical_url,
      headings: page.headings,
      links: page.links,
      text: page.text,
      truncated: byteTruncated || (page.text && page.text.length >= (maxChars || ctx.maxChars))
    };
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') throw new CliError(`Fetch timed out after ${ctx.fetchTimeoutMs}ms: ${inputUrl}`);
    if (error instanceof CliError) throw error;
    throw new CliError(`Fetch failed for ${inputUrl}: ${error.message}`);
  }
}

async function readResponseTextLimited(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.slice(0, remaining)));
      total += remaining;
      truncated = true;
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function extractHtmlPage(html, baseUrl, options = {}) {
  const cleaned = cleanHtml(html);
  const title = firstDefined(extractTagText(cleaned, 'title'), getMeta(cleaned, ['og:title', 'twitter:title'])) || '';
  const description = getMeta(cleaned, ['description', 'og:description', 'twitter:description']) || '';
  const canonical_url = extractCanonical(cleaned, baseUrl);
  const main = extractMainHtml(cleaned);
  const headings = options.includeHeadings ? extractHeadings(main) : [];
  const links = options.includeLinks ? extractLinks(main, baseUrl, parseNumber(options.linksLimit, 80, { min: 0, max: 500 })) : [];
  const text = truncate(htmlToText(main), options.maxChars || 12000);
  return { title: stripHtml(title), description: stripHtml(description), canonical_url, headings, links, text };
}

function cleanHtml(html) {
  return String(html || '')
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
}

function extractMainHtml(html) {
  const withoutChrome = html.replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, ' ');
  const candidates = [];
  for (const tag of ['main', 'article']) {
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = re.exec(withoutChrome))) {
      const textLength = htmlToText(match[1]).length;
      candidates.push({ html: match[1], textLength });
    }
  }
  candidates.sort((a, b) => b.textLength - a.textLength);
  if (candidates[0] && candidates[0].textLength > 300) return candidates[0].html;
  const body = withoutChrome.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : withoutChrome;
}

function extractTagText(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = html.match(re);
  return match ? htmlToText(match[1]) : undefined;
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = decodeEntities(match[2] || match[3] || match[4] || '');
  return attrs;
}

function getMeta(html, names) {
  const wanted = new Set(names.map((s) => s.toLowerCase()));
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = parseAttrs(tag);
    const name = (attrs.name || attrs.property || '').toLowerCase();
    if (wanted.has(name) && attrs.content) return attrs.content;
  }
  return undefined;
}

function extractCanonical(html, baseUrl) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = parseAttrs(tag);
    if ((attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical') && attrs.href) {
      try { return new URL(attrs.href, baseUrl).toString(); } catch (_) { return attrs.href; }
    }
  }
  return undefined;
}

function extractHeadings(html) {
  const headings = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = re.exec(html))) {
    const text = htmlToText(match[2]);
    if (text) headings.push({ level: Number(match[1]), text });
    if (headings.length >= 80) break;
  }
  return headings;
}

function extractLinks(html, baseUrl, limit = 80) {
  const links = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(html))) {
    const href = decodeEntities(match[1] || match[2] || match[3] || '').trim();
    if (!href || /^(javascript:|mailto:|tel:)/i.test(href)) continue;
    let absolute = href;
    try { absolute = new URL(href, baseUrl).toString(); } catch (_) { /* keep href */ }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const text = htmlToText(match[4]).slice(0, 200);
    links.push({ text, url: absolute });
    if (links.length >= limit) break;
  }
  return links;
}

function htmlToText(html) {
  let text = String(html || '');
  text = text.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/(p|div|section|article|main|li|ul|ol|h[1-6]|tr|table|blockquote|pre)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\r/g, '\n');
  text = text.replace(/[\t\f\v ]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™'
};

function decodeEntities(value) {
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (full, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] && entity[1].toLowerCase() === 'x';
      const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code)) {
        try { return String.fromCodePoint(code); } catch (_) { return full; }
      }
      return full;
    }
    return ENTITIES[entity.toLowerCase()] || full;
  });
}

function truncate(value, maxChars) {
  const s = String(value || '');
  if (!maxChars || s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n…[truncated]`;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function selectPath(value, expression) {
  if (!expression) return value;
  const parts = String(expression).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = value;
  for (const part of parts) {
    if (part === '*') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.flatMap((item) => item === undefined || item === null ? [] : [item]);
      continue;
    }
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur) && !/^\d+$/.test(part)) {
      cur = cur.map((item) => item == null ? undefined : item[part]);
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

function outputData(data, ctx) {
  let selected = ctx.flags.select ? selectPath(data, ctx.flags.select) : data;
  let text;
  switch (String(ctx.output).toLowerCase()) {
    case 'json':
    case 'pretty':
      text = JSON.stringify(selected, null, 2);
      break;
    case 'raw':
      text = typeof selected === 'string' ? selected : (selected === undefined ? '' : JSON.stringify(selected));
      break;
    case 'ndjson':
      text = formatNdjson(selected);
      break;
    case 'table':
      text = formatTableOutput(selected, ctx);
      break;
    case 'urls':
      text = collectResults(selected).map((r) => r.url).filter(Boolean).join('\n');
      break;
    case 'markdown':
    case 'md':
    default:
      text = formatMarkdown(selected, ctx);
      break;
  }

  if (ctx.flags.save) {
    const file = expandHome(ctx.flags.save);
    fs.writeFileSync(file, text + (text.endsWith('\n') ? '' : '\n'));
    if (!ctx.flags.quiet) process.stderr.write(`saved ${file}\n`);
  } else {
    process.stdout.write(text + (text.endsWith('\n') ? '' : '\n'));
  }
}

function formatNdjson(value) {
  const rows = Array.isArray(value) ? value : collectResults(value);
  if (rows.length) return rows.map((row) => JSON.stringify(row)).join('\n');
  return JSON.stringify(value);
}

function collectResults(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.results)) return value.results;
  if (Array.isArray(value.searches)) return value.searches.flatMap((s) => collectResults(s));
  return [];
}

function formatTableOutput(value, ctx) {
  const rows = collectResults(value);
  if (!rows.length) return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '');
  const columns = toArray(ctx.flags.column).length ? toArray(ctx.flags.column).map(String) : ['rank', 'title', 'source', 'url'];
  return table(rows, columns);
}

function table(rows, columns) {
  const widths = columns.map((col) => Math.min(80, Math.max(col.length, ...rows.map((row) => String(row[col] ?? '').replace(/\s+/g, ' ').length))));
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const header = columns.map((col, i) => pad(col, widths[i])).join('  ');
  const body = rows.map((row) => columns.map((col, i) => pad(clip(String(row[col] ?? '').replace(/\s+/g, ' '), widths[i]), widths[i])).join('  '));
  return [header, sep, ...body].join('\n');
}

function pad(value, width) {
  const s = String(value);
  return s + ' '.repeat(Math.max(0, width - s.length));
}

function clip(value, width) {
  const s = String(value);
  if (s.length <= width) return s;
  return `${s.slice(0, Math.max(0, width - 1))}…`;
}

function formatMarkdown(value, ctx) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value !== 'object') return String(value);
  if (value.type === 'brave_search') return formatSearchMarkdown(value, ctx);
  if (value.type === 'brave_research') return formatResearchMarkdown(value, ctx);
  if (value.type === 'brave_multi_search' || value.type === 'brave_batch_search') return formatMultiMarkdown(value, ctx);
  if (value.type === 'page_fetch') return formatPageMarkdown(value, ctx);
  if (Array.isArray(value)) return value.map((item, index) => formatResultMarkdown(item, index + 1, ctx)).join('\n\n');
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

function formatSearchMarkdown(data, ctx) {
  const lines = [];
  lines.push(`# Brave ${data.kind} search: ${data.query}`);
  lines.push('');
  lines.push(`Results: ${data.result_count}`);
  if (data.query_info?.altered) lines.push(`Altered query: ${stripHtml(data.query_info.altered)}`);
  if (data.answer) {
    lines.push('', '## Answer', '');
    lines.push(formatSmallObject(data.answer));
  }
  if (data.infobox) {
    lines.push('', '## Infobox', '');
    lines.push(formatSmallObject(data.infobox));
  }
  if (data.results && data.results.length) {
    lines.push('', '## Results', '');
    data.results.forEach((result, i) => lines.push(formatResultMarkdown(result, i + 1, ctx), ''));
  }
  if (data.summarizer?.key) {
    lines.push(`Summarizer key available from Brave API: ${data.summarizer.key}`);
  }
  return lines.join('\n').trimEnd();
}

function formatResearchMarkdown(data, ctx) {
  const lines = [];
  lines.push(`# Brave research: ${data.query}`, '');
  lines.push(`Variations: ${data.variations.join(' | ')}`);
  lines.push(`Deduped results: ${data.result_count}`);
  if (data.results && data.results.length) {
    lines.push('', '## Results', '');
    data.results.forEach((result, i) => lines.push(formatResultMarkdown(result, i + 1, ctx), ''));
  }
  return lines.join('\n').trimEnd();
}

function formatMultiMarkdown(data, ctx) {
  const lines = [];
  lines.push(`# Brave ${data.kind || 'web'} searches`, '');
  for (const search of data.searches || []) {
    lines.push(`## ${search.query}`, '');
    for (const result of search.results || []) lines.push(formatResultMarkdown(result, result.rank, ctx), '');
  }
  return lines.join('\n').trimEnd();
}

function formatResultMarkdown(result, number, ctx) {
  if (!result || typeof result !== 'object') return `${number}. ${String(result)}`;
  const lines = [];
  const title = result.title || result.url || '(untitled)';
  lines.push(`${number}. **${title}**`);
  if (result.url) lines.push(`   ${result.url}`);
  const meta = [result.category, result.source, result.age, result.language].filter(Boolean).join(' · ');
  if (meta) lines.push(`   ${meta}`);
  if (result.description) lines.push(`   ${truncate(result.description, parseNumber(ctx.flags.snippetChars, 700, { min: 80, max: 5000 })).replace(/\n/g, '\n   ')}`);
  if (result.extra_snippets && result.extra_snippets.length) {
    for (const snippet of result.extra_snippets.slice(0, 3)) lines.push(`   - ${truncate(snippet, 500)}`);
  }
  if (result.content) {
    if (result.content.error) lines.push(`   Content fetch error: ${result.content.error}`);
    else if (result.content.text) {
      lines.push('');
      lines.push(`   Content excerpt${result.content.final_url && result.content.final_url !== result.url ? ` (${result.content.final_url})` : ''}:`);
      lines.push(indentBlock(truncate(result.content.text, ctx.contentChars), '   > '));
    }
  }
  if (result.source_query) lines.push(`   Source query: ${result.source_query}`);
  return lines.join('\n');
}

function formatPageMarkdown(page, ctx) {
  const lines = [];
  lines.push(`# ${page.title || 'Fetched page'}`, '');
  lines.push(`URL: ${page.final_url || page.url}`);
  if (page.status) lines.push(`Status: ${page.status}`);
  if (page.content_type) lines.push(`Content-Type: ${page.content_type}`);
  if (page.description) lines.push('', `> ${page.description}`);
  if (page.headings && page.headings.length) {
    lines.push('', '## Headings', '');
    for (const h of page.headings.slice(0, 30)) lines.push(`${'  '.repeat(Math.max(0, h.level - 1))}- ${h.text}`);
  }
  lines.push('', '## Text', '', page.text || '');
  if (page.links && page.links.length) {
    lines.push('', '## Links', '');
    for (const link of page.links.slice(0, 30)) lines.push(`- ${link.text || link.url}: ${link.url}`);
  }
  return lines.join('\n').trimEnd();
}

function indentBlock(text, prefix) {
  return String(text || '').split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function formatSmallObject(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return stripHtml(value);
  if (typeof value !== 'object') return String(value);
  const lines = [];
  for (const [key, val] of Object.entries(value)) {
    if (val === undefined || val === null || val === '') continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') lines.push(`- ${key}: ${stripHtml(val)}`);
  }
  return lines.length ? lines.join('\n') : '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

function printHelp() {
  process.stdout.write(`brave-search ${VERSION}

Standalone Brave Search API and page-content CLI for Pi/agents.

Usage:
  brave-search "query"                         # web search (default)
  brave-search web "query" --count 10
  brave-search news "query" --freshness pd
  brave-search images "query" --count 10 --output table
  brave-search videos "query" --safesearch strict
  brave-search suggest "partial query"
  brave-search spellcheck "mispeled qury"
  brave-search web "query" --fetch --fetch-count 3
  brave-search fetch https://example.com --max-chars 12000
  brave-search research "topic" --variations 5 --count 5
  brave-search multi --query "one" --query "two" --count 3
  brave-search batch --file queries.txt --output json
  brave-search request /web/search --param q=node --param count=3
  brave-search rate-limit                       # show live X-RateLimit headers

Authentication:
  BRAVE_API_KEY=... brave-search web "query"
  brave-search config set apiKey -             # paste key on stdin, avoids shell history
  brave-search auth check                       # also shows observed rate-limit headers

Search options:
  --count N              result count
  --offset N             result offset
  --country CC           country code, e.g. US, ES, GB
  --search-lang LANG     search language, e.g. en, es
  --ui-lang LANG         UI language, e.g. en-US
  --safesearch VALUE     off|moderate|strict
  --freshness VALUE      pd|pw|pm|py or YYYY-MM-DDtoYYYY-MM-DD
  --from DATE --to DATE  build a date range freshness value
  --filter NAME          result_filter entry (repeatable or comma-separated)
  --goggles-id ID        Brave Goggles ID
  --units metric|imperial
  --spellcheck/--no-spellcheck
  --extra-snippets       request extra snippets when supported
  --summary              request Brave summarizer key when supported by your plan
  --param key=value      pass any Brave API query parameter

Content options:
  --fetch                fetch readable content for top search results
  --fetch-count N        how many result URLs to fetch
  --content-chars N      max fetched text chars per result
  --max-bytes N          max bytes to read per page fetch
  --max-chars N          max chars for standalone fetch output
  --timeout 20s          API request timeout
  --fetch-timeout 20s    page fetch timeout
  --concurrency N        parallel searches/fetches

Rate-limit options:
  Free plan observed with this key: 1 request/second and 2000 successful requests/month.
  Use 'brave-search rate-limit' for live authoritative X-RateLimit headers.
  --rate-limit/--no-rate-limit
                          enable/disable in-process API throttling (default on)
  --min-api-interval 1100ms
                          minimum spacing between API calls (default protects free 1 req/s plans)
  --show-rate-limit       print X-RateLimit headers to stderr after API calls

Output options:
  --output markdown|json|table|urls|ndjson|raw
  --select path          select a JSON path before output, e.g. results[0].url
  --save file            save formatted output to file
  --include-raw          include raw Brave API response in JSON output
  --cache-ttl 10m        cache GET API responses for duration
  --no-cache             bypass cache

Config:
  brave-search config show
  brave-search config path
  brave-search config set country US
  brave-search config set apiKey -
  brave-search config set minApiInterval 1100ms
  brave-search config use work

Environment:
  BRAVE_API_KEY or BRAVE_SEARCH_API_KEY
`);
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const ctx = buildContext(parsed);
  let [command, ...args] = parsed.positionals;

  if (ctx.flags.help || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (!command) {
    printHelp();
    return;
  }

  if (!COMMANDS.has(command)) {
    args = parsed.positionals;
    command = 'web';
  }

  if (SEARCH_COMMANDS.has(command)) return commandSearch(ctx, command, args);
  if (command === 'fetch' || command === 'content' || command === 'page') return commandFetch(ctx, args);
  if (command === 'research') return commandResearch(ctx, args);
  if (command === 'multi') return commandMulti(ctx, args);
  if (command === 'batch') return commandBatch(ctx, args);
  if (command === 'request') return commandRequest(ctx, args);
  if (command === 'rate-limit' || command === 'limits') return commandRateLimit(ctx, args);
  if (command === 'auth') return commandAuth(ctx, args);
  if (command === 'config') return commandConfig(ctx, args);

  throw new CliError(`Unknown command: ${command}. Run '${NAME} help'.`);
}

main(process.argv.slice(2)).catch((error) => {
  if (error instanceof CliError) {
    process.stderr.write(`Error: ${error.message}\n`);
    if (error.details && process.env.DEBUG) process.stderr.write(`${util.inspect(error.details, { depth: 5 })}\n`);
    process.exit(error.code || 1);
  }
  process.stderr.write(`Unexpected error: ${error.stack || error.message}\n`);
  process.exit(1);
});
