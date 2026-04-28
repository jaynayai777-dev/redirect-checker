export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const target = searchParams.get("url");

    if (!target) {
      return new Response(JSON.stringify({ error: "Missing ?url=" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    let currentUrl = target;
    let chain = [];
    let maxHops = 10;

    for (let i = 0; i < maxHops; i++) {
      const res = await fetch(currentUrl, {
        redirect: "manual"
      });

      const status = res.status;
      const location = res.headers.get("Location");

      chain.push({
        url: currentUrl,
        status,
        location
      });

      if (!location || status < 300 || status > 399) {
        const body = await res.text();
        return new Response(
          JSON.stringify({
            finalUrl: currentUrl,
            redirected: chain.length > 1,
            chain,
            status,
            body
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      currentUrl = new URL(location, currentUrl).toString();
    }

    return new Response(
      JSON.stringify({
        error: "Max redirect hops exceeded",
        chain
      }),
      { status: 508, headers: { "Content-Type": "application/json" } }
    );
  }
};
