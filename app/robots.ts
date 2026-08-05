import type { MetadataRoute } from 'next'

/**
 * Crawl rules, and the pointer to the sitemap.
 *
 * The disallows are not about secrecy — /admin is reachable by anyone who knows the URL and
 * that is a separate problem — but about not spending a crawl budget on pages that should
 * never appear in results. /api returns JSON, /embed exists to be iframed by other sites and
 * would compete with the real pages for the same queries, and /fr24 is an internal warming
 * page. None of them is something a person should arrive at from a search.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/api/', '/embed', '/fr24'],
      },
    ],
    sitemap: 'https://www.flysyria.app/sitemap.xml',
    host: 'https://www.flysyria.app',
  }
}
