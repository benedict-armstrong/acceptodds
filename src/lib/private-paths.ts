/**
 * Pages that are personal or part of the auth flow: disallowed in
 * `app/robots.ts` and sent with `X-Robots-Tag: noindex` (`next.config.ts`),
 * since robots.txt stops a crawl but not an index entry. Add a page here,
 * never to one of the two alone. Imported by `next.config.ts`, so relative
 * imports only.
 */
export const PRIVATE_PAGES = [
  '/profile',
  '/portfolio',
  '/signin',
  '/welcome',
  '/verify-email',
  '/set-password',
  '/first-trade',
  '/groups/join',
];
