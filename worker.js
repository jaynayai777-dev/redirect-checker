const PAGESPEED_API_KEY = null; // Optional: add your API key or leave null to disable

export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url");

    if (!target) {
      return jsonError("Missing ?url parameter", 400);
    }

    const normalizedTarget = normalizeUrl(target);

    // 1) Redirect chain + final HTML
    const redirectResult = await followRedirects(normalizedTarget);
    if (redirectResult.error) {
      return jsonError(redirectResult.error, redirectResult.status || 500, redirectResult);
    }

    const {
      finalUrl,
      chain,
      status,
      contentType,
      server,
      body: html
    } = redirectResult;

    const isHtml = contentType && contentType.toLowerCase().includes("text/html");

    // 2) Metadata & on-page signals (only if HTML)
    const meta = isHtml ? extractAllMetadata(html) : emptyMetadata();

    // 3) Robots.txt + sitemap discovery
    const robotsInfo = await fetchRobotsAndSitemaps(finalUrl);

    // 4) Performance (PageSpeed Insights) - optional
    let performance = null;
    if (PAGESPEED_API_KEY) {
      performance = await fetchPageSpeed(finalUrl, PAGESPEED_API_KEY);
    }

    // 5) Security / HTTPS signals
    const security = analyzeSecuritySignals(chain, finalUrl);

    // 6) Assemble full audit object
    const audit = {
      url: normalizedTarget,
      finalUrl,
      status,
      redirected: chain.length > 1,
      chain,
      contentType,
      server,
      security,
      robots: {
        meta: meta.robots,
        xRobotsTag: meta.xRobotsTag,
        robotsTxt: robotsInfo.robotsTxt,
        sitemaps: robotsInfo.sitemaps
      },
      sitemaps: robotsInfo.sitemaps,
      seo: {
        canonicalUrl: meta.canonicalUrl,
        title: meta.title,
        description: meta.description,
        ogUrl: meta.ogUrl,
        ogTitle: meta.ogTitle,
        ogDescription: meta.ogDescription,
        ogImage: meta.ogImage,
        hreflang: meta.hreflang,
        favicon: meta.favicon,
        headings: meta.headings,
        images: meta.images,
        links: meta.links,
        structuredData: meta.structuredData
      },
      performance,
      body: isHtml ? html : null
    };

    return jsonResponse(audit);
  }
};

// -------------------------
// Redirect handling
// -------------------------

async function followRedirects(target) {
  let currentUrl = target;
  let chain = [];
  const maxHops = 10;
  const visited = new Set();

  for (let i = 0; i < maxHops; i++) {
    if (visited.has(currentUrl)) {
      return { error: "Redirect loop detected", status: 508, chain };
    }
    visited.add(currentUrl);

    const res = await fetch(currentUrl, { redirect: "manual" });
    const status = res.status;
    const location = res.headers.get("Location");
    const contentType = res.headers.get("Content-Type") || null;
    const server = res.headers.get("Server") || null;

    chain.push({ url: currentUrl, status, location, contentType, server });

    if (!location || status < 300 || status > 399) {
      let body = "";
      if (contentType && contentType.toLowerCase().includes("text/html")) {
        body = await res.text();
      }
      return {
        finalUrl: currentUrl,
        chain,
        status,
        contentType,
        server,
        body
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  return { error: "Max redirect hops exceeded", status: 508, chain };
}

// -------------------------
// JSON helpers
// -------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function jsonError(message, status = 500, extra = {}) {
  return jsonResponse({ error: message, ...extra }, status);
}

// -------------------------
// Metadata extraction
// -------------------------

function emptyMetadata() {
  return {
    canonicalUrl: null,
    title: null,
    description: null,
    ogUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    robots: null,
    xRobotsTag: null,
    hreflang: [],
    favicon: null,
    headings: {
      h1: [],
      h2: [],
      h3: []
    },
    images: {
      total: 0,
      missingAlt: 0
    },
    links: {
      internal: [],
      external: [],
      nofollow: []
    },
    structuredData: []
  };
}

function extractAllMetadata(html) {
  const meta = emptyMetadata();

  // Canonical
  const canonicalMatch = html.match(
    /<link[^>]*rel=["']?canonical["']?[^>]*href=["']?([^"'>\s]+)["']?[^>]*>/i
  );
  meta.canonicalUrl = canonicalMatch ? canonicalMatch[1].trim() : null;

  // Title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  meta.title = titleMatch ? titleMatch[1].trim() : null;

  // Meta Description
  const descriptionMatch = html.match(
    /<meta[^>]*name=["']?description["']?[^>]*content=["']([^"']+)["'][^>]*>/i
  );
  meta.description = descriptionMatch ? descriptionMatch[1].trim() : null;

  // Robots meta
  const robotsMatch = html.match(
    /<meta[^>]*name=["']?robots["']?[^>]*content=["']([^"']+)["'][^>]*>/i
  );
  meta.robots = robotsMatch ? robotsMatch[1].trim() : null;

  // OG tags
  meta.ogUrl = extractOgTag(html, "og:url");
  meta.ogTitle = extractOgTag(html, "og:title");
  meta.ogDescription = extractOgTag(html, "og:description");
  meta.ogImage = extractOgTag(html, "og:image");

  // Hreflang
  meta.hreflang = extractHreflang(html);

  // Favicon
  meta.favicon = extractFavicon(html);

  // Headings
  meta.headings = extractHeadings(html);

  // Images / alt
  meta.images = extractImageStats(html);

  // Links
  meta.links = extractLinks(html);

  // Structured data (JSON-LD)
  meta.structuredData = extractStructuredData(html);

  return meta;
}

function extractOgTag(html, property) {
  const regex = new RegExp(
    `<meta[^>]*property=["']?${escapeRegex(property)}["']?[^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = html.match(regex);
  return match ? match[1].trim() : null;
}

function extractHreflang(html) {
  const regex = /<link[^>]*rel=["']?alternate["']?[^>]*href=["']([^"']+)["'][^>]*hreflang=["']([^"']+)["'][^>]*>/gi;
  const results = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    results.push({
      href: match[1].trim(),
      hreflang: match[2].trim()
    });
  }
  return results;
}

function extractFavicon(html) {
  const match = html.match(
    /<link[^>]*rel=["']?(?:shortcut icon|icon)["']?[^>]*href=["']([^"']+)["'][^>]*>/i
  );
  return match ? match[1].trim() : null;
}

function extractHeadings(html) {
  const headings = { h1: [], h2: [], h3: [] };

  const h1Regex = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;

  let match;
  while ((match = h1Regex.exec(html)) !== null) {
    headings.h1.push(cleanText(match[1]));
  }
  while ((match = h2Regex.exec(html)) !== null) {
    headings.h2.push(cleanText(match[1]));
  }
  while ((match = h3Regex.exec(html)) !== null) {
    headings.h3.push(cleanText(match[1]));
  }

  return headings;
}

function extractImageStats(html) {
  const imgRegex = /<img[^>]*>/gi;
  const altRegex = /alt=["']([^"']*)["']/i;

  let total = 0;
  let missingAlt = 0;
  let match;

  while ((match = imgRegex.exec(html)) !== null) {
    total++;
    const tag = match[0];
    const altMatch = tag.match(altRegex);
    if (!altMatch || altMatch[1].trim() === "") {
      missingAlt++;
    }
  }

  return { total, missingAlt };
}

function extractLinks(html) {
  const aRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  const nofollowRegex = /rel=["'][^"']*nofollow[^"']*["']/i;

  const internal = [];
  const external = [];
  const nofollow = [];

  let match;
  while ((match = aRegex.exec(html)) !== null) {
    const href = match[1].trim();
    const tag = match[0];

    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }

    const isNofollow = nofollowRegex.test(tag);
    if (isNofollow) {
      nofollow.push(href);
    }

    if (isAbsoluteUrl(href)) {
      external.push(href);
    } else {
      internal.push(href);
    }
  }

  return { internal, external, nofollow };
}

function extractStructuredData(html) {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1].trim();
    try {
      const json = JSON.parse(raw);
      blocks.push(json);
    } catch {
      blocks.push({ raw, parseError: true });
    }
  }
  return blocks;
}

// -------------------------
// Robots.txt & sitemaps
// -------------------------

async function fetchRobotsAndSitemaps(finalUrl) {
  try {
    const url = new URL(finalUrl);
    const robotsUrl = `${url.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { redirect: "follow" });

    if (!res.ok) {
      return { robotsTxt: null, sitemaps: [] };
    }

    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const sitemaps = [];
    const allow = [];
    const disallow = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^sitemap:/i.test(trimmed)) {
        const sitemapUrl = trimmed.split(/sitemap:/i)[1].trim();
        sitemaps.push(sitemapUrl);
      } else if (/^allow:/i.test(trimmed)) {
        allow.push(trimmed.split(/allow:/i)[1].trim());
      } else if (/^disallow:/i.test(trimmed)) {
        disallow.push(trimmed.split(/disallow:/i)[1].trim());
      }
    }

    return {
      robotsTxt: { allow, disallow },
      sitemaps
    };
  } catch {
    return { robotsTxt: null, sitemaps: [] };
  }
}

// -------------------------
// PageSpeed Insights
// -------------------------

async function fetchPageSpeed(url, apiKey) {
  try {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(
      url
    )}&key=${encodeURIComponent(apiKey)}&strategy=mobile`;

    const res = await fetch(apiUrl);
    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const lighthouse = data.lighthouseResult || {};
    const audits = lighthouse.audits || {};
    const categories = lighthouse.categories || {};

    return {
      performanceScore: categories.performance?.score ?? null,
      lcp: audits["largest-contentful-paint"]?.numericValue ?? null,
      cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
      ttfb: audits["server-response-time"]?.numericValue ?? null
    };
  } catch {
    return null;
  }
}

// -------------------------
// Security / HTTPS signals
// -------------------------

function analyzeSecuritySignals(chain, finalUrl) {
  const startsHttp = chain[0]?.url?.startsWith("http://") || false;
  const endsHttps = finalUrl.startsWith("https://");
  const httpsRedirect = startsHttp && endsHttps;

  const mixedContent = false; // could be enhanced by scanning HTML for http:// resources

  return {
    httpsRedirect,
    mixedContent
  };
}

// -------------------------
// Utilities
// -------------------------

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(str) {
  return str.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(url);
}

function normalizeUrl(url) {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}
