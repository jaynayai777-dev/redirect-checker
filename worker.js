// worker.js

const PAGESPEED_API_KEY = null; // Optional: add your API key or leave null to disable

export default {
  async fetch(request, env, ctx) {
    try {
      const { searchParams } = new URL(request.url);
      const target = searchParams.get("url");
      if (!target) {
        return jsonResponse({ error: "Missing ?url=" }, 400);
      }

      const startUrl = normalizeUrl(target);

      // 1) Follow redirects and fetch main HTML
      const redirectResult = await followRedirects(startUrl);
      const { finalUrl, chain, status, response, html } = redirectResult;

      const origin = new URL(finalUrl).origin;

      // 2) Security headers
      const securityHeaders = extractSecurityHeaders(response.headers);

      // 3) Parse HTML into a lightweight "doc" wrapper
      const doc = parseHtml(html);

      // 4) Indexing signals (robots, sitemaps, canonical, meta robots, x-robots-tag)
      const indexing = await collectIndexingSignals(finalUrl, response, doc);

      // 5) Sitemap parsing (Phase 1A)
      const sitemapSignals = await collectSitemapSignals(
        indexing.robotsRulesSummary,
        origin
      );

      // 6) Content signals (title, description, headings, word count, images)
      const content = collectContentSignals(doc);

      // 7) Link signals (internal vs external, anchors)
      const links = collectLinkSignals(finalUrl, doc);

      // 8) Technical signals (schema, OG, hreflang, viewport, mixed content)
      const technical = collectTechnicalSignals(response.headers, doc);

      // 9) Multi-page crawling (Phase 2A) – crawl up to 10 sitemap URLs
      const crawlResults = await crawlPages(
        sitemapSignals.discoveredUrls,
        10 // adjust as needed
      );

      // 10) Stubbed external integrations (can be wired later)
      const performance = await collectPerformanceSignals(finalUrl, env);
      const offPage = await collectOffPageSignals(finalUrl, env);
      const competitors = await collectCompetitorSignals(finalUrl, env);

      const result = {
        url: startUrl,
        finalUrl,
        redirectChain: chain,
        status,
        indexing: {
          ...indexing,
          sitemaps: sitemapSignals
        },
        content,
        links,
        technical: {
          ...technical,
          securityHeaders
        },
        performance,
        offPage,
        competitors,
        crawl: crawlResults
      };

      return jsonResponse(result, 200);
    } catch (err) {
      return jsonResponse(
        {
          error: "Worker error",
          message: err instanceof Error ? err.message : String(err)
        },
        500
      );
    }
  }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (!u.protocol) u.protocol = "https:";
    return u.toString();
  } catch {
    throw new Error("Invalid URL");
  }
}

async function followRedirects(startUrl, maxHops = 10) {
  let currentUrl = startUrl;
  const chain = [];

  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        "User-Agent": "JaySEO-AuditBot/1.0 (+https://yourdomain.com)"
      }
    });

    const status = res.status;
    const location = res.headers.get("Location");
    chain.push({ url: currentUrl, status, location });

    if (!location || status < 300 || status > 399) {
      const html = await res.text();
      return {
        finalUrl: currentUrl,
        chain,
        status,
        response: res,
        html
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error("Max redirect hops exceeded");
}

function extractSecurityHeaders(headers) {
  const h = (name) => headers.get(name) || null;
  return {
    strictTransportSecurity: h("strict-transport-security"),
    contentSecurityPolicy: h("content-security-policy"),
    xFrameOptions: h("x-frame-options"),
    xContentTypeOptions: h("x-content-type-options"),
    referrerPolicy: h("referrer-policy")
  };
}

// Simple "doc" wrapper – we keep raw HTML and let helpers operate on it
function parseHtml(html) {
  return { html };
}

function collectContentSignals(doc) {
  const html = doc.html;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i
  );
  const description = descMatch ? descMatch[1].trim() : null;

  const headings = {
    h1: matchAllText(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi),
    h2: matchAllText(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi),
    h3: matchAllText(html, /<h3[^>]*>([\s\S]*?)<\/h3>/gi)
  };

  const images = matchAll(html, /<img[^>]*>/gi);
  const missingAlt = images.filter((img) => !/alt=/i.test(img.full)).length;

  const textOnly = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  const words = textOnly
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const wordCount = words.length;

  return {
    title,
    description,
    headings,
    wordCount,
    images: {
      total: images.length,
      missingAlt
    }
  };
}

function collectLinkSignals(baseUrl, doc) {
  const html = doc.html;
  const linkRegex =
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const linksRaw = matchAll(html, linkRegex);

  const base = new URL(baseUrl);
  const internal = [];
  const external = [];

  for (const link of linksRaw) {
    const href = link.groups.href;
    const anchor = stripTags(link.groups.anchor || "").trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) continue;

    let resolved;
    try {
      resolved = new URL(href, base).toString();
    } catch {
      continue;
    }

    if (new URL(resolved).hostname === base.hostname) {
      internal.push({ href: resolved, anchor });
    } else {
      external.push({ href: resolved, anchor });
    }
  }

  return { internal, external };
}

function collectTechnicalSignals(headers, doc) {
  const html = doc.html;

  const schemaJsonLd =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi.test(
      html
    );
  const schemaMicrodata = /itemscope/i.test(html);

  const og = {
    hasOgTitle: /<meta[^>]+property=["']og:title["'][^>]*>/i.test(html),
    hasOgDescription: /<meta[^>]+property=["']og:description["'][^>]*>/i.test(
      html
    ),
    hasOgImage: /<meta[^>]+property=["']og:image["'][^>]*>/i.test(html)
  };

  const hreflang = [];
  const hreflangRegex =
    /<link[^>]+rel=["']alternate["'][^>]+hreflang=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = hreflangRegex.exec(html)) !== null) {
    hreflang.push({ lang: m[1], href: m[2] });
  }

  const viewportMatch = html.match(
    /<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']*)["'][^>]*>/i
  );
  const viewportMeta = viewportMatch ? viewportMatch[1].trim() : null;

  const mixedContent =
    /https:\/\//i.test(html) && /http:\/\//i.test(html);

  return {
    schemaOrg: {
      hasJsonLd: schemaJsonLd,
      hasMicrodata: schemaMicrodata
    },
    openGraph: og,
    hreflang,
    viewportMeta,
    mixedContent
  };
}

async function collectIndexingSignals(finalUrl, response, doc) {
  const urlObj = new URL(finalUrl);
  const robotsTxtUrl = `${urlObj.origin}/robots.txt`;

  let robotsTxt = null;
  let robotsRulesSummary = {
    blockedPaths: [],
    sitemaps: []
  };

  try {
    const robotsRes = await fetch(robotsTxtUrl, {
      headers: {
        "User-Agent": "JaySEO-AuditBot/1.0 (+https://yourdomain.com)"
      }
    });
    if (robotsRes.ok) {
      robotsTxt = await robotsRes.text();
      robotsRulesSummary = parseRobotsTxt(robotsTxt);
    }
  } catch {
    // ignore robots errors
  }

  const html = doc.html;

  const canonicalMatch = html.match(
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i
  );
  const canonical = canonicalMatch ? canonicalMatch[1].trim() : null;

  const metaRobotsMatch = html.match(
    /<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["'][^>]*>/i
  );
  const metaRobots = metaRobotsMatch ? metaRobotsMatch[1].trim() : null;

  const xRobotsTag = response.headers.get("x-robots-tag");

  return {
    robotsTxtUrl,
    robotsTxt,
    robotsRulesSummary,
    canonical,
    metaRobots,
    xRobotsTag
  };
}

// Phase 1A – Sitemap parsing
async function collectSitemapSignals(robotsRulesSummary, origin) {
  const sitemapUrls = [...robotsRulesSummary.sitemaps];

  if (sitemapUrls.length === 0) {
    sitemapUrls.push(`${origin}/sitemap.xml`);
  }

  const discovered = [];

  for (const sitemapUrl of sitemapUrls) {
    try {
      const res = await fetch(sitemapUrl);
      if (!res.ok) continue;

      const xml = await res.text();

      if (xml.includes("<sitemapindex")) {
        const childSitemaps = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(
          (m) => m[1]
        );
        for (const child of childSitemaps) {
          try {
            const childRes = await fetch(child);
            if (!childRes.ok) continue;
            const childXml = await childRes.text();
            const urls = [...childXml.matchAll(/<loc>(.*?)<\/loc>/g)].map(
              (m) => m[1]
            );
            discovered.push(...urls);
          } catch {
            // ignore child sitemap errors
          }
        }
      } else {
        const urls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(
          (m) => m[1]
        );
        discovered.push(...urls);
      }
    } catch {
      // ignore sitemap errors
    }
  }

  return {
    sitemapUrls,
    discoveredUrls: discovered.slice(0, 5000)
  };
}

// Phase 2A – Multi-page crawling
async function crawlPages(urls, limit = 10) {
  const results = [];

  const max = Math.min(urls.length, limit);
  for (let i = 0; i < max; i++) {
    const url = urls[i];

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "JaySEO-AuditBot/1.0 (+https://yourdomain.com)"
        }
      });

      if (!res.ok) continue;

      const html = await res.text();
      const doc = parseHtml(html);

      results.push({
        url,
        status: res.status,
        content: collectContentSignals(doc),
        links: collectLinkSignals(url, doc),
        technical: collectTechnicalSignals(res.headers, doc)
      });
    } catch {
      // skip failed pages
    }
  }

  return results;
}

function parseRobotsTxt(text) {
  const lines = text.split(/\r?\n/);
  const blockedPaths = [];
  const sitemaps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const [directiveRaw, valueRaw] = trimmed.split(":");
    if (!directiveRaw || !valueRaw) continue;

    const directive = directiveRaw.trim().toLowerCase();
    const value = valueRaw.trim();

    if (directive === "disallow") {
      blockedPaths.push(value);
    } else if (directive === "sitemap") {
      sitemaps.push(value);
    }
  }

  return { blockedPaths, sitemaps };
}

function matchAll(html, regex) {
  const results = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const groups = {};
    if (m.length > 1) {
      if (m.groups) {
        Object.assign(groups, m.groups);
      } else {
        groups.href = m[1];
        groups.anchor = m[2] || "";
      }
    }
    results.push({ full: m[0], groups });
  }
  return results;
}

function matchAllText(html, regex) {
  const results = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    results.push(stripTags(m[1]).trim());
  }
  return results;
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, " ");
}

// Stub external integrations – wire real APIs later
async function collectPerformanceSignals(url, env) {
  return {
    coreWebVitals: null,
    pageSpeedScore: null
  };
}

async function collectOffPageSignals(url, env) {
  return {
    backlinksSummary: null
  };
}

async function collectCompetitorSignals(url, env) {
  return null;
}
