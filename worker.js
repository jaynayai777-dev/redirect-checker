// worker.js

const PAGESPEED_API_KEY = null; // Optional: add your API key or leave null to disable

export default {
  async fetch(request, env, ctx) {
    try {
      const { searchParams } = new URL(request.url);
      const target = searchParams.get("url");

      if (!target) {
        return jsonError("Missing ?url parameter", 400);
      }

      const startUrl = normalizeUrl(target);
      if (!startUrl) {
        return jsonError("Invalid URL", 400);
      }

      const MAX_PAGES = 50; // tune as needed

      // 1) Resolve redirects and get final URL + base response
      const redirectResult = await followRedirects(startUrl);
      const finalUrl = redirectResult.finalUrl;
      const baseResponse = redirectResult.finalResponse;

      // 2) Fetch robots.txt + sitemap(s)
      const indexing = await getIndexingSignals(finalUrl);

      // 3) Fetch main page HTML and extract signals
      const mainHtml = await baseResponse.text();
      const mainPageSignals = await analyzePage(finalUrl, baseResponse, mainHtml);

      // 4) Discover crawl targets (sitemap → fallback to homepage links)
      const discoveredFromSitemap = indexing.sitemaps.sitemapUrls.length
        ? indexing.sitemaps.discoveredUrls
        : [];

      let crawlTargets = [...discoveredFromSitemap];

      if (crawlTargets.length === 0) {
        // Fallback: discover from homepage internal links
        const homepageLinks = mainPageSignals.links.internal
          .map(l => l.href)
          .filter(href => href && href.startsWith(getOrigin(finalUrl)));
        crawlTargets = Array.from(new Set(homepageLinks));
      }

      // Ensure we don't re-crawl the main URL
      crawlTargets = crawlTargets.filter(u => stripHash(u) !== stripHash(finalUrl));

      // Limit to MAX_PAGES - 1 (main page already analyzed)
      crawlTargets = crawlTargets.slice(0, Math.max(0, MAX_PAGES - 1));

      // 5) Crawl additional pages (shallow analysis for now)
      const crawlResults = [];
      for (const url of crawlTargets) {
        try {
          const res = await fetch(url, { redirect: "follow" });
          const html = await res.text();
          const pageSignals = await analyzePage(url, res, html, { light: true });
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

      // 6) Build final audit object (single-item array, like your current output)
      const audit = {
        url: startUrl,
        finalUrl,
        redirectChain: redirectResult.chain,
        status: baseResponse.status,

        indexing,
        content: mainPageSignals.content,
        links: mainPageSignals.links,
        technical: mainPageSignals.technical,
        performance: {
          coreWebVitals: null,
          pageSpeedScore: null,
        },
        offPage: {
          backlinksSummary: null,
        },
        competitors: null,
        crawl: crawlResults,
      };

      return new Response(JSON.stringify([audit], null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch (err) {
      return jsonError("Worker error", 500, err);
    }
  },
};

/* ----------------- Helpers ----------------- */

function jsonError(message, status = 500, rawError = null) {
  const body = {
    error: "Worker error",
    message,
  };
  if (rawError) {
    body.details = String(rawError?.message || rawError);
  }
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

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

async function followRedirects(startUrl, maxHops = 10) {
  const chain = [];
  let currentUrl = startUrl;
  let lastResponse = null;

  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(currentUrl, { redirect: "manual" });
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

    // Final response (200, 4xx, 5xx, etc.)
    lastResponse = await fetch(currentUrl, { redirect: "follow" });
    chain.push({
      url: currentUrl,
      status: lastResponse.status,
      location: null,
    });
    break;
  }

  return {
    finalUrl: currentUrl,
    finalResponse: lastResponse,
    chain,
  };
}

async function getIndexingSignals(finalUrl) {
  const origin = getOrigin(finalUrl);
  const robotsTxtUrl = origin ? `${origin}/robots.txt` : null;

  let robotsTxt = null;
  let robotsRulesSummary = { blockedPaths: [], sitemaps: [] };
  let metaRobots = null;
  let xRobotsTag = null;

  if (robotsTxtUrl) {
    try {
      const res = await fetch(robotsTxtUrl);
      if (res.ok) {
        robotsTxt = await res.text();
        robotsRulesSummary = parseRobotsTxt(robotsTxt);
      }
    } catch {
      // ignore robots.txt failures
    }
  }

  // Sitemaps from robots.txt + heuristic default
  const sitemapUrls = new Set(robotsRulesSummary.sitemaps || []);
  sitemapUrls.add(`${origin}/sitemap.xml`);

  const discoveredUrls = [];
  for (const smUrl of sitemapUrls) {
    try {
      const urls = await parseSitemap(smUrl);
      urls.forEach(u => discoveredUrls.push(u));
    } catch {
      // ignore bad sitemaps
    }
  }

  return {
    robotsTxtUrl,
    robotsTxt,
    robotsRulesSummary,
    canonical: null, // filled per-page in analyzePage if needed
    metaRobots,
    xRobotsTag,
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
  const res = await fetch(sitemapUrl);
  if (!res.ok) return [];

  const contentType = res.headers.get("content-type") || "";
  const body = await res.text();

  if (!contentType.includes("xml") && !body.includes("<urlset") && !body.includes("<sitemapindex")) {
    // Likely HTML or something else
    return [];
  }

  const urls = [];

  // Simple <loc> extraction
  const locRegex = /<loc>([^<]+)<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(body)) !== null) {
    try {
      const u = new URL(match[1].trim());
      urls.push(u.toString());
    } catch {
      // ignore invalid URLs
    }
  }

  return urls;
}

async function analyzePage(url, res, html, options = {}) {
  const light = options.light === true;

  const content = extractContent(html);
  const links = extractLinks(url, html);
  const technical = extractTechnical(url, res, html);

  const indexing = {
    robotsTxtUrl: null,
    robotsTxt: null,
    robotsRulesSummary: {
      blockedPaths: [],
      sitemaps: [],
    },
    canonical: extractCanonical(url, html),
    metaRobots: extractMetaRobots(html),
    xRobotsTag: res.headers.get("x-robots-tag"),
    sitemaps: {
      sitemapUrls: [],
      discoveredUrls: [],
    },
  };

  if (light) {
    // For crawled pages, we keep it shallow
    return { content, links, technical, indexing };
  }

  return { content, links, technical, indexing };
}

function extractContent(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtml(titleMatch[1].trim()) : null;

  const h2 = Array.from(html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)).map(m =>
    cleanText(m[1])
  );
  const h3 = Array.from(html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)).map(m =>
    cleanText(m[1])
  );
  const h1 = Array.from(html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)).map(m =>
    cleanText(m[1])
  );

  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const wordCount = textOnly ? textOnly.split(/\s+/).length : 0;

  const images = Array.from(html.matchAll(/<img[^>]*>/gi));
  let totalImages = images.length;
  let missingAlt = 0;
  for (const img of images) {
    const tag = img[0];
    const hasAlt = /alt\s*=\s*["'][^"']*["']/i.test(tag);
    if (!hasAlt) missingAlt++;
  }

  return {
    title,
    description: extractMeta(html, "description"),
    headings: { h1, h2, h3 },
    wordCount,
    images: {
      total: totalImages,
      missingAlt,
    },
  };
}

function extractLinks(baseUrl, html) {
  const origin = getOrigin(baseUrl);
  const internal = [];
  const external = [];

  const linkRegex = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1].trim();
    const anchorRaw = match[2] || "";
    const anchor = cleanText(anchorRaw);

    try {
      const abs = new URL(href, baseUrl).toString();
      if (origin && abs.startsWith(origin)) {
        internal.push({ href: abs, anchor });
      } else {
        external.push({ href: abs, anchor });
      }
    } catch {
      // ignore invalid hrefs
    }
  }

  return { internal, external };
}

function extractTechnical(url, res, html) {
  const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/i.test(
    html
  );
  const hasMicrodata = /\sitemscope(\s|>)/i.test(html);

  const hasOgTitle = /<meta[^>]+property=["']og:title["'][^>]*>/i.test(html);
  const hasOgDescription = /<meta[^>]+property=["']og:description["'][^>]*>/i.test(html);
  const hasOgImage = /<meta[^>]+property=["']og:image["'][^>]*>/i.test(html);

  const viewportMatch = html.match(
    /<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']+)["'][^>]*>/i
  );
  const viewportMeta = viewportMatch ? viewportMatch[1].trim() : null;

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
    schemaOrg: {
      hasJsonLd,
      hasMicrodata,
    },
    openGraph: {
      hasOgTitle,
      hasOgDescription,
      hasOgImage,
    },
    hreflang: extractHreflang(html),
    viewportMeta,
    mixedContent,
    securityHeaders,
  };
}

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
  const results = [];
  const linkRegex =
    /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    results.push({
      hreflang: match[1].trim(),
      href: match[2].trim(),
    });
  }
  return results;
}

function detectMixedContent(pageUrl, html) {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "https:") return false;
  } catch {
    return false;
  }

  // crude but effective: look for http:// resources
  return /http:\/\//i.test(html);
}

function cleanText(str) {
  return decodeHtml(
    str
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtml(str) {
  const map = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&#160;": " ",
    "&nbsp;": " ",
  };
  return str.replace(/(&amp;|&lt;|&gt;|&quot;|&#39;|&#160;|&nbsp;)/g, m => map[m] || m);
}
