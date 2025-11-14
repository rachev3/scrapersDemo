import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type LoadState = "load" | "domcontentloaded" | "networkidle";

function parseStartUrls(): string[] {
  const cliArgs = process.argv.slice(2).filter(Boolean);
  const envArg =
    process.env.START_URL?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const startUrls = cliArgs.length > 0 ? cliArgs : envArg;
  if (startUrls.length === 0) {
    console.error(
      "No start URL provided. Pass a URL as a CLI arg or set START_URL."
    );
    console.info("Example: yarn start:links https://example.com");
    process.exit(1);
  }
  return startUrls;
}

function getAllowedHostnames(urls: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const u of urls) {
    try {
      hosts.add(new URL(u).hostname);
    } catch {
      // ignore invalid urls here; crawler will handle errors on navigation
    }
  }
  return hosts;
}

function isSkippableScheme(href: string): boolean {
  const lower = href.toLowerCase();
  return (
    lower.startsWith("javascript:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("data:")
  );
}

async function main() {
  const crawlee = (await import("crawlee")) as any;
  const { PlaywrightCrawler, Dataset, log } = crawlee;

  log.setLevel((process.env.LOG_LEVEL as any) ?? "INFO");

  const startUrls = parseStartUrls();
  const sameDomainOnly =
    (process.env.SAME_DOMAIN_ONLY ?? "true").toLowerCase() === "true";
  const waitUntil = (process.env.WAIT_UNTIL as LoadState) ?? "networkidle";
  const headful = process.env.PLAYWRIGHT_HEADFUL === "1";
  const maxRequestsPerCrawl = Number(process.env.MAX_REQUESTS_PER_CRAWL ?? 500);
  const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 10);

  const allowedHostnames = getAllowedHostnames(startUrls);
  const discoveredLinks = new Set<string>();

  const crawler = new PlaywrightCrawler({
    headless: !headful,
    maxRequestsPerCrawl,
    maxConcurrency,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    requestHandler: async ({ page, request, enqueueLinks }) => {
      log.info(`Processing: ${request.url}`);

      // Navigate using the Playwright page context already at the URL.
      // Ensure network settled for JS-heavy pages.
      await page.waitForLoadState(waitUntil);

      // Extract absolute URLs from <a href> elements
      const pageLinks = await page.$$eval("a[href]", (anchors) =>
        anchors
          .map((a) => {
            try {
              // Use HTMLAnchorElement.href which is absolute in the browser
              return (a as HTMLAnchorElement).href;
            } catch {
              return undefined;
            }
          })
          .filter((u): u is string => Boolean(u))
      );

      for (const href of pageLinks) {
        if (isSkippableScheme(href)) continue;
        try {
          const absolute = new URL(href).href.split("#")[0];
          if (sameDomainOnly) {
            const hostname = new URL(absolute).hostname;
            if (!allowedHostnames.has(hostname)) continue;
          }
          discoveredLinks.add(absolute);
        } catch {
          // ignore malformed
        }
      }

      // Enqueue further links for crawling
      await enqueueLinks({
        // Keep crawling within the same hostname by default
        strategy: sameDomainOnly ? "same-hostname" : "all",
        selector: "a[href]",
        // Additional filter at enqueue time to skip non-http(s) links
        transformRequestFunction: (req) => {
          try {
            const u = new URL(req.url);
            // Strip fragments to avoid duplicate entries caused by hashes
            u.hash = "";
            req.url = u.href;
            if (u.protocol !== "http:" && u.protocol !== "https:") return null;
            if (sameDomainOnly && !allowedHostnames.has(u.hostname))
              return null;
            return req;
          } catch {
            return null;
          }
        },
      });
    },
    failedRequestHandler: async ({ request }) => {
      log.warning(`Request failed: ${request.url}`);
    },
  });

  await crawler.run(startUrls);

  // Save to a dedicated dataset named "links"
  const linksArray = [...discoveredLinks].sort();
  const dataset = await Dataset.open("links");
  // Store as individual items for easier export
  await dataset.pushData(linksArray.map((url) => ({ url })));

  // Also save a flat file for convenience
  const outDir = path.resolve(process.cwd(), "storage", "outputs");
  const jsonPath = path.join(outDir, "links.json");
  const txtPath = path.join(outDir, "links.txt");

  // Ensure directory exists lazily
  await writeFile(jsonPath, JSON.stringify(linksArray, null, 2), {
    flag: "w",
  }).catch(async (err: any) => {
    // If directory missing, create it and retry
    if (err && err.code === "ENOENT") {
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(outDir, { recursive: true })
      );
      await writeFile(jsonPath, JSON.stringify(linksArray, null, 2), {
        flag: "w",
      });
    } else {
      throw err;
    }
  });
  await writeFile(txtPath, linksArray.join("\n"), { flag: "w" });

  log.info(`Discovered unique links: ${linksArray.length}`);
  log.info(`Saved dataset: "links" (storage/datasets/links)`);
  log.info(
    `Saved files: ${path.relative(process.cwd(), jsonPath)}, ${path.relative(
      process.cwd(),
      txtPath
    )}`
  );
}

main().catch((err) => {
  console.error("Crawler failed", err);
  process.exit(1);
});
