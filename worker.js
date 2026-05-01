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
      const redirectResult = await followRedirects(startUrl);
      const { finalUrl, chain, status, response, html } = redirectResult;

      // Basic headers & security
      const securityHeaders = extractSecurityHeaders(response.headers);

      // Parse HTML
      const doc = parseHtml(html);
      const indexing = await collectIndexingSignals(finalUrl, response, doc);
      const content = collectContentSignals(doc);
      const links = collectLinkSignals(finalUrl, doc);
      const technical = collectTechnicalSignals(response.headers, doc);

      // External APIs (stubbed – wire real ones later)
      const performance = await collectPerformanceSignals(finalUrl, env);
      const offPage = await collectOffPageSignals(finalUrl, env);
      const competitors = await collectCompetitorSignals(finalUrl, env);

      const result = {
        url: startUrl,
        finalUrl,
        redirectChain: chain,
        status,
        indexing,
        content,
        links,
        technical: {
          ...technical,
          securityHeaders
        },
        performance,
        offPage,
        competitors
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

// Very lightweight HTML parsing using DOMParser-like approach via HTMLRewriter is possible,
// but for simplicity we’ll use regex-ish extraction here. For production, consider a proper parser.

function parseHtml(html) {
  return { html }; // placeholder – we’ll pass raw HTML into helpers
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
  const missingAlt = images.filter((img) => !/alt=/i.test(img)).length;

  const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, "")
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
  const linksRaw = matchAll(html, /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);

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

  const schemaJsonLd = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi.test(
    html
  );
  const schemaMicrodata = /itemscope/i.test(html);

  const og = {
    hasOgTitle: /<meta[^>]+property=["']og:title["'][^>]*>/i.test(html),
    hasOgDescription: /<meta[^>]+property=["']og:description["'][^>]*>/i.test(html),
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

  const mixedContent = /https:\/\//i.test(html) && /http:\/\//i.test(html);

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

  const sitemaps = robotsRulesSummary.sitemaps.map((url) => ({
    url,
    type: "xml",
    discoveredUrls: null // you can later fetch & count
  }));

  return {
    robotsTxtUrl,
    robotsTxt,
    robotsRulesSummary,
    sitemaps,
    canonical,
    metaRobots,
    xRobotsTag
  };
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
      // named groups or positional
      if (m.groups) {
        Object.assign(groups, m.groups);
      } else {
        // assume first capture is href, second is anchor when relevant
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
  // Example: call PageSpeed Insights or your own CWV API
  // const res = await fetch(`https://your-cwv-api?url=${encodeURIComponent(url)}&key=${env.CWV_API_KEY}`);
  // const data = await res.json();
  // return data;
  return {
    coreWebVitals: null,
    pageSpeedScore: null
  };
}

async function collectOffPageSignals(url, env) {
  // Example: call backlink API
  return {
    backlinksSummary: null
  };
}

async function collectCompetitorSignals(url, env) {
  // Example: call SERP API to get top 3 competitors
  return null;
}
