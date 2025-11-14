import "dotenv/config";
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
    throw new Error(
      "No start URL provided. Pass a URL as a CLI arg or set START_URL."
    );
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

function normalizePathPrefix(pathname: string): string {
  if (!pathname) return "/";
  let p = pathname.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (!p.endsWith("/")) p = `${p}/`;
  return p;
}

function getHostnameToPathPrefixes(urls: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const u of urls) {
    try {
      const { hostname, pathname } = new URL(u);
      const prefix = normalizePathPrefix(pathname || "/");
      const arr = map.get(hostname) ?? [];
      if (!arr.includes(prefix)) arr.push(prefix);
      map.set(hostname, arr);
    } catch {
      // ignore
    }
  }
  return map;
}

function getHostnameToScopeTokens(
  hostPrefixes: Map<string, string[]>
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [host, prefixes] of hostPrefixes) {
    const tokens = new Set<string>();
    for (const p of prefixes) {
      // token is the first non-empty segment (e.g., "/dubai/" -> "dubai")
      const seg = p.split("/").filter(Boolean)[0] ?? "";
      if (seg) tokens.add(seg.toLowerCase());
    }
    map.set(host, tokens);
  }
  return map;
}

function isLikelyBinaryAsset(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  const nonHtmlExts = [
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".zip",
    ".rar",
    ".7z",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
    ".mp4",
    ".mov",
    ".avi",
    ".mp3",
    ".wav",
    ".m4a",
  ];
  return nonHtmlExts.some((ext) => lower.endsWith(ext));
}

function isInScope(
  urlObj: URL,
  sameDomainOnly: boolean,
  allowedHostnames: Set<string>,
  hostPrefixes: Map<string, string[]>
): boolean {
  if (sameDomainOnly && !allowedHostnames.has(urlObj.hostname)) return false;
  const prefixes = hostPrefixes.get(urlObj.hostname);
  if (prefixes && prefixes.length > 0) {
    const normalizedPath = normalizePathPrefix(urlObj.pathname || "/");
    return prefixes.some((p) => normalizedPath.startsWith(p));
  }
  return true;
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

function assetMatchesScope(
  urlObj: URL,
  hostScopeTokens: Map<string, Set<string>>
): boolean {
  const tokens = hostScopeTokens.get(urlObj.hostname);
  // If no tokens (e.g., root "/"), allow all assets on this host
  if (!tokens || tokens.size === 0) return true;
  const lowerPath = urlObj.pathname.toLowerCase();
  for (const t of tokens) {
    if (lowerPath.includes(t)) return true;
  }
  return false;
}

async function main() {
  const crawlee = (await import("crawlee")) as any;
  const { PlaywrightCrawler } = crawlee;

  const startUrls = parseStartUrls();
  const sameDomainOnly =
    (process.env.SAME_DOMAIN_ONLY ?? "true").toLowerCase() === "true";
  const waitUntil = (process.env.WAIT_UNTIL as LoadState) ?? "networkidle";
  const headful = process.env.PLAYWRIGHT_HEADFUL === "1";
  const maxRequestsPerCrawl = Number(process.env.MAX_REQUESTS_PER_CRAWL ?? 500);
  const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 10);

  const allowedHostnames = getAllowedHostnames(startUrls);
  const hostnameToPrefixes = getHostnameToPathPrefixes(startUrls);
  const hostnameToScopeTokens = getHostnameToScopeTokens(hostnameToPrefixes);
  const discoveredLinks = new Set<string>();

  const crawler = new PlaywrightCrawler({
    headless: !headful,
    maxRequestsPerCrawl,
    maxConcurrency,
    navigationTimeoutSecs: 45,
    requestHandlerTimeoutSecs: 90,
    requestHandler: async ({ page, request, enqueueLinks }: any) => {
      // Navigate using the Playwright page context already at the URL.
      // Ensure network settled for JS-heavy pages.
      await page.waitForLoadState(waitUntil);

      // Extract absolute URLs from <a href> elements
      const pageLinks = await page.$$eval("a[href]", (anchors: Element[]) =>
        anchors
          .map((a: Element) => {
            try {
              // Use HTMLAnchorElement.href which is absolute in the browser
              return (a as HTMLAnchorElement).href;
            } catch {
              return undefined;
            }
          })
          .filter((u: string | undefined): u is string => Boolean(u))
      );

      for (const href of pageLinks) {
        if (isSkippableScheme(href)) continue;
        try {
          const absolute = new URL(href).href.split("#")[0];
          const u = new URL(absolute);
          const isAsset = isLikelyBinaryAsset(u.pathname);
          const withinHost =
            !sameDomainOnly || allowedHostnames.has(u.hostname);
          // Collect assets even if outside path prefix (as long as host matches).
          // Only collect HTML pages when within the path scope.
          if (isAsset) {
            if (withinHost && assetMatchesScope(u, hostnameToScopeTokens))
              discoveredLinks.add(u.href);
          } else {
            if (
              isInScope(u, sameDomainOnly, allowedHostnames, hostnameToPrefixes)
            ) {
              discoveredLinks.add(u.href);
            }
          }
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
        transformRequestFunction: (req: any) => {
          try {
            const u = new URL(req.url);
            // Strip fragments to avoid duplicate entries caused by hashes
            u.hash = "";
            req.url = u.href;
            if (u.protocol !== "http:" && u.protocol !== "https:") return null;
            if (
              !isInScope(
                u,
                sameDomainOnly,
                allowedHostnames,
                hostnameToPrefixes
              )
            )
              return null;
            // Do not navigate to likely file downloads; they remain in discoveredLinks
            if (isLikelyBinaryAsset(u.pathname)) return null;
            return req;
          } catch {
            return null;
          }
        },
      });
    },
  });

  await crawler.run(startUrls);

  const linksArray = [...discoveredLinks].sort();
  console.log(linksArray);
}

main().catch((err) => {
  process.exit(1);
});
