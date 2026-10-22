import type { MetadataRoute } from "next";

// Crawlers must not request free-text search pages (they could otherwise surface or, via the
// research trigger, spend on-demand research), staff pages or internal APIs.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/projects?*q=", "/admin", "/api/"],
    },
  };
}
