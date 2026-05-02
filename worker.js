// worker.js — PRODUCTION READY, FULLY HARDENED

const PAGESPEED_API_KEY = null; // Optional

// --- Crawl budget + safe fetch ---
let subrequestCount = 0;

async function safeFetch(url, opts) {
  if (subrequestCount >= 40) {
    return null; // leave room for main page + fallback, redirects, etc.
  }
  subrequestCount++;
  return await fetch(url, opts);
}

// --- Max pages to crawl (excluding the main URL) ---
const MAX_PAGES = 12;

export default {
  async fetch(request, env, ctx) {
    try {
      const { searchParams } = new URL(request.url);
      const target = searchParams.get("url");
      if (!target) return jsonError("Missing ?url parameter", 400);

      const startUrl = normalizeUrl(target);
      if (!startUrl) return jsonError("Invalid URL", 400);

      // 1) Resolve redirects
      const redirectResult = await robustRedirectFollow(startUrl);
      const finalUrl = redirectResult.finalUrl;
      let baseResponse = redirectResult.finalResponse;

      // 2) Read HTML + fallback for ASP.NET/server errors
      let html = await safeReadText(baseResponse);
      if (isAspNetError(html) || baseResponse.status >= 500) {
        const fallback = await tryFallbackFetches(finalUrl);
        if (!fallback) {
          return structuredServerError(
            startUrl,
            finalUrl,
            redirectResult.chain,
            baseResponse.status
          );
        }
        baseResponse = fallback;
        html = await safeReadText(baseResponse);
        if (isAspNetError(html) || baseResponse.status >= 500) {
          return structuredServerError(
            startUrl,
            finalUrl,
            redirectResult.chain,
            baseResponse.status
          );
        }
      }

      // 3) Indexing signals
      const indexing = await getIndexingSignals(finalUrl);

      // 4) Analyze main page
      const mainPageSignals = await analyzePage(finalUrl, baseResponse, html);

      // 5) Discover crawl targets
      let crawlTargets = indexing.sitemaps.discoveredUrls.length
        ? indexing.sitemaps.discoveredUrls
        : extractHomepageLinks(finalUrl, mainPageSignals);

      // Deduplicate + avoid crawling the main URL again + cap by MAX_PAGES
      crawlTargets = [...new Set(crawlTargets)]
        .filter(u => stripHash(u) !== stripHash(finalUrl))
        .slice(0, Math.max(0, MAX_PAGES - 1));

      // 6) Crawl additional pages with crawl budget
      const crawlResults = [];
      for (const url of crawlTargets) {
        if (subrequestCount >= 40) {
          crawlResults.push({
            url,
            status: null,
            error: "crawl budget exceeded",
          });
          continue;
        }

        try {
          const res = await safeFetch(url, browserHeaders());
          if (!res) {
            crawlResults.push({
              url,
              status: null,
              error: "crawl budget exceeded",
            });
            continue;
          }

          const pageHtml = await safeReadText(res);

          if (isAspNetError(pageHtml)) {
            crawlResults.push({
              url,
              status: res.status,
              error: "ASP.NET error page",
            });
            continue;
          }

          const pageSignals = await analyzePage(url, res, pageHtml, { light: true });

          crawlResults.push({
            url,
            status: res.status,
            title: pageSignals.content.title,
            canonical: pageSignals.indexing.canonical,
            metaRobots: pageSignals.indexing.metaRobots,
          });
        } catch (e) {
          crawlResults.push({
            url,
            status: null,
            error: String(e?.message || e),
          });
        }
      }

      // 7) Final audit object
      const audit = {
        url: startUrl,
        finalUrl,
        redirectChain: redirectResult.chain,
        status: baseResponse.status,
        indexing,
        content: mainPageSignals.content,
        links: mainPageSignals.links,
        technical: mainPageSignals.technical,
        performance: { coreWebVitals: null, pageSpeedScore: null },
        offPage: { backlinksSummary: null },
        competitors: null,
        crawl: crawlResults,
      };

      return json(audit);
    } catch (err) {
      return jsonError("Worker error", 500, err);
    }
  },
};

/* ----------------- JSON HELPERS ----------------- */

function json(obj) {
  return new Response(JSON.stringify([obj], null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonError(message, status = 500, raw = null) {
  const body = { error: "Worker error", message };
  if (raw) body.details = String(raw);
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* ----------------- SAFE TEXT READER ----------------- */

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/* ----------------- HOMEPAGE LINK EXTRACTION ----------------- */

function extractHomepageLinks(baseUrl, mainPageSignals) {
  const origin = getOrigin(baseUrl);
  if (!origin) return [];

  const internalLinks =
    mainPageSignals?.links?.internal && Array.isArray(mainPageSignals.links.internal)
      ? mainPageSignals.links.internal
      : [];

  return internalLinks
    .map(l => l.href)
    .filter(href => href && href.startsWith(origin));
}

/* ----------------- UTILITIES ----------------- */

function normalizeUrl(input) {
  try {
    const u = new URL(input);
    if (!u.protocol.startsWith("http")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function getOrigin(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function stripHash(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

/* ----------------- REDIRECT FOLLOW ----------------- */

async function robustRedirectFollow(startUrl, maxHops = 10) {
  const chain = [];
  let currentUrl = startUrl;
  let lastResponse = null;

  for (let i = 0; i < maxHops; i++) {
    const res = await safeFetch(currentUrl, { redirect: "manual", ...browserHeaders() });
    if (!res) break;

    const location = res.headers.get("location");

    chain.push({
      url: currentUrl,
      status: res.status,
      location: location ? new URL(location, currentUrl).toString() : null,
    });

    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
      lastResponse = res;
      continue;
    }

    const followRes = await safeFetch(currentUrl, { redirect: "follow", ...browserHeaders() });
    if (!followRes) {
      lastResponse = res;
      break;
    }

    lastResponse = followRes;
    chain.push({
      url: currentUrl,
      status: lastResponse.status,
      location: null,
    });
    break;
  }

  return { finalUrl: currentUrl, finalResponse: lastResponse, chain };
}

/* ----------------- BROWSER HEADERS ----------------- */

function browserHeaders() {
  return {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      Connection: "keep-alive",
    },
  };
}

/* ----------------- ASP.NET ERROR DETECTION ----------------- */

function isAspNetError(html) {
  if (!html) return false;
  const patterns = [
    "Server Error in '/' Application.",
    "Object reference not set to an instance of an object.",
    "Runtime Error",
  ];
  return patterns.some(p => html.includes(p));
}

async function tryFallbackFetches(url) {
  const strategies = [
    () => safeFetch(url, browserHeaders()),
    () => safeFetch(url, { redirect: "follow", ...browserHeaders() }),
    () => safeFetch(url, { redirect: "manual", ...browserHeaders() }),
    () => safeFetch(url, { cf: { httpProtocol: "http1.1" }, ...browserHeaders() }),
  ];

  for (const attempt of strategies) {
    try {
      const res = await attempt();
      if (!res) continue;
      const html = await safeReadText(res);
      if (res.ok && !isAspNetError(html)) {
        return new Response(html, { status: res.status, headers: res.headers });
      }
    } catch {}
  }
  return null;
}

function structuredServerError(startUrl, finalUrl, chain, status) {
  const audit = {
    url: startUrl,
    finalUrl,
    redirectChain: chain,
    status,
    indexing: {
      robotsTxtUrl: null,
      robotsTxt: null,
      robotsRulesSummary: { blockedPaths: [], sitemaps: [] },
      canonical: null,
      metaRobots: null,
      xRobotsTag: null,
      sitemaps: { sitemapUrls: [], discoveredUrls: [] },
    },
    content: {
      title: null,
      description: null,
      headings: { h1: [], h2: [], h3: [] },
      wordCount: 0,
      images: { total: 0, missingAlt: 0 },
    },
    links: { internal: [], external: [] },
    technical: {
      schemaOrg: { hasJsonLd: false, hasMicrodata: false },
      openGraph: { hasOgTitle: false, hasOgDescription: false, hasOgImage: false },
      hreflang: [],
      viewportMeta: null,
      mixedContent: false,
      securityHeaders: {
        strictTransportSecurity: null,
        contentSecurityPolicy: null,
        xFrameOptions: null,
        xContentTypeOptions: null,
        referrerPolicy: null,
      },
    },
    performance: { coreWebVitals: null, pageSpeedScore: null },
    offPage: { backlinksSummary: null },
    competitors: null,
    crawl: [],
  };

  return json(audit);
}
/* ----------------- INDEXING (ROBOTS + SITEMAPS) ----------------- */

async function getIndexingSignals(finalUrl) {
  const origin = getOrigin(finalUrl);
  const robotsTxtUrl = origin ? `${origin}/robots.txt` : null;

  let robotsTxt = null;
  let robotsRulesSummary = { blockedPaths: [], sitemaps: [] };

  if (robotsTxtUrl) {
    try {
      const res = await safeFetch(robotsTxtUrl, browserHeaders());
      if (res && res.ok) {
        robotsTxt = await safeReadText(res);
        robotsRulesSummary = parseRobotsTxt(robotsTxt);
      }
    } catch {}
  }

  const sitemapUrls = new Set(robotsRulesSummary.sitemaps || []);
  if (origin) sitemapUrls.add(`${origin}/sitemap.xml`);

  const discoveredUrls = [];
  for (const smUrl of sitemapUrls) {
    try {
      const urls = await parseSitemap(smUrl);
      urls.forEach(u => discoveredUrls.push(u));
    } catch {}
  }

  return {
    robotsTxtUrl,
    robotsTxt,
    robotsRulesSummary,
    canonical: null,
    metaRobots: null,
    xRobotsTag: null,
    sitemaps: {
      sitemapUrls: Array.from(sitemapUrls),
      discoveredUrls: Array.from(new Set(discoveredUrls)),
    },
  };
}

function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/);
  const blockedPaths = [];
  const sitemaps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const lower = trimmed.toLowerCase();
    if (lower.startsWith("disallow:")) {
      const path = trimmed.split(":")[1]?.trim();
      if (path) blockedPaths.push(path);
    }
    if (lower.startsWith("sitemap:")) {
      const url = trimmed.split(":")[1]?.trim();
      if (url) sitemaps.push(url);
    }
  }

  return { blockedPaths, sitemaps };
}

async function parseSitemap(sitemapUrl) {
  const res = await safeFetch(sitemapUrl, browserHeaders());
  if (!res || !res.ok) return [];

  const contentType = res.headers.get("content-type") || "";
  const body = await safeReadText(res);

  if (!contentType.includes("xml") && !body.includes("<urlset") && !body.includes("<sitemapindex")) {
    return [];
  }

  const urls = [];
  const locRegex = /<loc>([^<]+)<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(body)) !== null) {
    try {
      const u = new URL(match[1].trim());
      urls.push(u.toString());
    } catch {}
  }

  return urls;
}

/* ----------------- PAGE ANALYSIS ----------------- */

async function analyzePage(url, res, html, options = {}) {
  const light = options.light === true; // kept for future use if you want to branch logic

  const content = extractContent(html);
  const links = extractLinks(url, html);
  const technical = extractTechnical(url, res, html);

  const indexing = {
    robotsTxtUrl: null,
    robotsTxt: null,
    robotsRulesSummary: { blockedPaths: [], sitemaps: [] },
    canonical: extractCanonical(url, html),
    metaRobots: extractMetaRobots(html),
    xRobotsTag: res.headers.get("x-robots-tag"),
    sitemaps: { sitemapUrls: [], discoveredUrls: [] },
  };

  return { content, links, technical, indexing };
}

/* ----------------- CONTENT EXTRACTION (SAFE) ----------------- */

function extractContent(html) {
  if (!html) html = "";

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1].trim()) : null;

  const safeMatchAll = (regex) => {
    try {
      return Array.from(html.matchAll(regex)).map(m => cleanText(m[1] || ""));
    } catch {
      return [];
    }
  };

  const h1 = safeMatchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi);
  const h2 = safeMatchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi);
  const h3 = safeMatchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi);

  let textOnly = "";
  try {
    textOnly = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    textOnly = "";
  }

  const wordCount = textOnly ? textOnly.split(/\s+/).length : 0;

  let images = [];
  try {
    images = Array.from(html.matchAll(/<img[^>]*>/gi));
  } catch {
    images = [];
  }

  let totalImages = images.length;
  let missingAlt = 0;
  for (const img of images) {
    const tag = img[0] || "";
    const hasAlt = /alt\s*=\s*["'][^"']*["']/i.test(tag);
    if (!hasAlt) missingAlt++;
  }

  return {
    title,
    description: extractMeta(html, "description"),
    headings: { h1, h2, h3 },
    wordCount,
    images: { total: totalImages, missingAlt },
  };
}

/* ----------------- LINK EXTRACTION ----------------- */

function extractLinks(baseUrl, html) {
  if (!html) html = "";

  const origin = getOrigin(baseUrl);
  const internal = [];
  const external = [];

  const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const hrefRaw = match?.[1] || "";
    const anchorRaw = match?.[2] || "";
    const anchor = cleanText(anchorRaw);

    try {
      const abs = new URL(hrefRaw.trim(), baseUrl).toString();
      if (origin && abs.startsWith(origin)) {
        internal.push({ href: abs, anchor });
      } else {
        external.push({ href: abs, anchor });
      }
    } catch {}
  }

  return { internal, external };
}

/* ----------------- TECHNICAL SIGNALS (SAFE) ----------------- */

function extractTechnical(url, res, html) {
  if (!html) html = "";

  const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i.test(html);
  const hasMicrodata = /\sitemscope(\s|>)/i.test(html);

  const hasOgTitle = /<meta[^>]+property=["']og:title["'][^>]*>/i.test(html);
  const hasOgDescription = /<meta[^>]+property=["']og:description["'][^>]*>/i.test(html);
  const hasOgImage = /<meta[^>]+property=["']og:image["'][^>]*>/i.test(html);

  let viewportMeta = null;
  try {
    const viewportMatch = html.match(
      /<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']+)["'][^>]*>/i
    );
    viewportMeta = viewportMatch?.[1]?.trim() || null;
  } catch {
    viewportMeta = null;
  }

  const mixedContent = detectMixedContent(url, html);

  const headers = res.headers;
  const securityHeaders = {
    strictTransportSecurity: headers.get("strict-transport-security"),
    contentSecurityPolicy: headers.get("content-security-policy"),
    xFrameOptions: headers.get("x-frame-options"),
    xContentTypeOptions: headers.get("x-content-type-options"),
    referrerPolicy: headers.get("referrer-policy"),
  };

  return {
    schemaOrg: { hasJsonLd, hasMicrodata },
    openGraph: { hasOgTitle, hasOgDescription, hasOgImage },
    hreflang: extractHreflang(html),
    viewportMeta,
    mixedContent,
    securityHeaders,
  };
}

/* ----------------- META / CANONICAL / HREFLANG ----------------- */

function extractCanonical(baseUrl, html) {
  const match = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i
  );
  if (!match) return null;
  try {
    return new URL(match[1].trim(), baseUrl).toString();
  } catch {
    return null;
  }
}

function extractMetaRobots(html) {
  const match = html.match(
    /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  return match ? match[1].trim() : null;
}

function extractMeta(html, name) {
  const regex = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function extractHreflang(html) {
  if (!html) return [];

  const results = [];
  const linkRegex =
    /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*>/gi;

  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const lang = match?.[1]?.trim() || null;
    const href = match?.[2]?.trim() || null;
    if (lang && href) {
      results.push({ hreflang: lang, href });
    }
  }

  return results;
}

/* ----------------- MIXED CONTENT ----------------- */

function detectMixedContent(pageUrl, html) {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "https:") return false;
  } catch {
    return false;
  }
  return /http:\/\//i.test(html);
}

/* ----------------- TEXT CLEANUP ----------------- */

function cleanText(str) {
  if (!str) return "";
  return decodeHtml(
    str
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtml(str) {
  if (!str) return "";
  const map = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&#160": " ",
    "&#160;": " ",
    "&nbsp;": " ",
  };
  return str.replace(/(&amp;|&lt;|&gt;|&quot;|&#39;|&#160;|&#160|&nbsp;)/g, m => map[m] || m);
}
