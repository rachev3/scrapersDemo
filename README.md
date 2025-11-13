# Crawlee Dual Crawler (Cheerio + Playwright)

Two runnable crawlers using Crawlee:
- CheerioCrawler (fast, no browser)
- PlaywrightCrawler (full browser with JS rendering)

## Prerequisites
- Node.js >= 18
- Yarn

## Install

```bash
yarn install
```

If you plan to use Playwright:

```bash
# Install browser binaries
yarn dlx playwright install --with-deps
```

## Run

You can pass the start URL as a CLI argument or via env var `START_URL` (comma-separated for multiple).

Cheerio (fast, cheap):
```bash
yarn start:cheerio https://bianco-pizza.com
```

Playwright (JS rendering):
```bash
yarn start:playwright https://bianco-pizza.com
```

## Options (env vars)
- `START_URL`: Comma-separated list of seed URLs (fallback to CLI args).
- `MAX_REQUESTS_PER_CRAWL`: Default 500.
- `MAX_CONCURRENCY`: Default 10.
- `SAME_DOMAIN_ONLY`: `true|false`, default true. If true, only same-domain links are enqueued.
- `WAIT_UNTIL`: Playwright only. One of `load|domcontentloaded|networkidle` (default `networkidle`).
- `PLAYWRIGHT_HEADFUL`: Set to `1` to see the browser window.

## Output
Data is stored in Crawlee default dataset directory (`./storage/datasets/default`).

## Notes
- For complex SPA sites, prefer the Playwright crawler.
- Start with Cheerio; if content appears empty due to JS, switch to Playwright.


