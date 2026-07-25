---
name: brave-search
description: Search the internet with Brave Search API and extract readable page content using a standalone JavaScript CLI. Use for current facts, documentation lookup, news, image/video search, suggestions, spellcheck, multi-query research, and fetching web pages for source-grounded answers.
allowed-tools: Bash(brave-search:*)
---

# Brave Search Skill

Use the bundled standalone JavaScript CLI for internet search and readable page extraction.

- Preferred command when available: `brave-search`
- Portable script path: `./brave-search.js` from this skill directory
- No npm install is required; it uses Node's built-in `fetch` and filesystem APIs.

## Authentication

The CLI reads the Brave Search API key from, in order:

1. `--api-key <key>` or `--token <key>` (avoid unless necessary because it can enter shell history)
2. `BRAVE_API_KEY` or `BRAVE_SEARCH_API_KEY`
3. `~/.config/brave-search/config.json`

Never ask the user to paste an API key into chat. If a key needs to be stored, tell the user to run:

```bash
brave-search config set apiKey -
```

Then paste the key on stdin and end input. Verify without exposing secrets:

```bash
brave-search auth check
brave-search auth show
brave-search rate-limit
```

## Rate Limits

The free Brave Search API plan observed for this key reports:

- `1` request per `1` second
- `2000` successful requests per month/window

Always trust the live headers over hard-coded assumptions. Check them with:

```bash
brave-search rate-limit --output json
# or
brave-search auth limits --output json
```

The CLI now protects free-plan keys by default:

- in-process API calls are spaced by `1100ms`
- multi/research/batch commands default to `--concurrency 1`
- 429 responses use `Retry-After` / `X-RateLimit-Reset` when present
- monthly quota exhaustion is not retried repeatedly

If the user has a paid plan, they can opt out or raise throughput:

```bash
brave-search web "query" --no-rate-limit --concurrency 5
brave-search config set minApiInterval 250ms
```

## Recommended Workflow

1. Search broadly first, using `--count 5` to `--count 10`.
2. Prefer official/primary sources when available.
3. Fetch page content when snippets are insufficient or when citing/grounding an answer.
4. For deeper research, use `research` or `multi`, then deduplicate and inspect the best URLs.
5. Use `--output markdown` for human-readable context, `--output json` for scripting, and `--select` for precise extraction.
6. The CLI defaults to sequential, rate-limited API calls to respect free-plan limits; raise `--concurrency` or use `--no-rate-limit` only when the API plan allows it.

## Common Commands

Web search:

```bash
brave-search web "query" --count 10
brave-search "query" --count 10                  # default is web search
brave-search web "query" --filter web --filter news
brave-search web "query" --freshness pw          # recent week
brave-search web "query" --country US --search-lang en
```

Search and fetch readable content from top results:

```bash
brave-search web "query" --count 5 --fetch --fetch-count 3 --content-chars 6000
```

Fetch/read a specific page:

```bash
brave-search fetch https://example.com --max-chars 12000
brave-search fetch https://example.com --output json --select text
```

News, images, videos, suggestions, and spellcheck:

```bash
brave-search news "topic" --freshness pd --count 10
brave-search images "topic" --count 10 --output table
brave-search videos "topic" --safesearch strict
brave-search suggest "partial query"
brave-search spellcheck "mispeled qury"
```

Multi-query and research mode:

```bash
brave-search multi --query "first query" --query "second query" --count 5
brave-search research "topic" --variations 5 --count 5
brave-search research "topic" --variations 5 --fetch --fetch-count 3
```

Batch search from a file or stdin:

```bash
brave-search batch --file queries.txt --count 3 --output json
printf '%s\n' "query one" "query two" | brave-search batch --count 3 --output ndjson
```

Generic Brave API endpoint access:

```bash
brave-search request /web/search --param q=node --param count=3
brave-search request GET /news/search --param q="AI regulation" --param freshness=pd
```

Rate-limit inspection:

```bash
brave-search rate-limit
brave-search auth check --show-rate-limit
brave-search web "query" --show-rate-limit --count 1
```

## Useful Options

```bash
--count N                  number of results
--offset N                 pagination offset
--country CC               country code, e.g. US, ES, GB
--search-lang LANG         search language, e.g. en, es
--ui-lang LANG             UI language, e.g. en-US
--safesearch off|moderate|strict
--freshness pd|pw|pm|py    day/week/month/year freshness
--from YYYY-MM-DD --to YYYY-MM-DD
--filter NAME              Brave result_filter entry; repeatable or comma-separated
--goggles-id ID            use Brave Goggles
--extra-snippets           request extra snippets when supported
--summary                  request Brave summarizer key when supported by the API plan
--param key=value          pass any Brave API query parameter
--fetch --fetch-count N    fetch readable content for top search results
--content-chars N          max fetched chars per result
--max-chars N              max chars for standalone page fetch
--timeout 20s              API timeout
--fetch-timeout 20s        page fetch timeout
--rate-limit/--no-rate-limit
                            enable/disable in-process API throttling
--min-api-interval 1100ms   minimum spacing between API calls
--show-rate-limit           print Brave X-RateLimit headers to stderr
--concurrency N             parallel searches/fetches; default 1 for free-plan safety
--cache-ttl 10m             cache API GET responses briefly
--output markdown|json|table|urls|ndjson|raw
--select path              select JSON path, e.g. results[0].url
--save file                save formatted output
```

## Output Tips for Pi

- For quick answers: `brave-search web "query" --count 5`
- For source-grounded answers: `brave-search web "query" --count 5 --fetch --fetch-count 2`
- For just URLs: `brave-search web "query" --count 10 --output urls`
- For structured processing: `brave-search web "query" --output json`
- For a page's text only: `brave-search fetch <url> --output raw --select text`

## Help

```bash
brave-search help
brave-search config show
brave-search rate-limit
```
