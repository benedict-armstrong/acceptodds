'use client';

import { useEffect } from 'react';
import { analyticsUrl } from '@/lib/analytics';

const BEFORE_SEND = 'acceptoddsBeforeSend';

type Payload = { url?: string; referrer?: string; [key: string]: unknown };

/**
 * The Umami tracker (shared ops instance, `analytics.<zone>`), which counts
 * page views, client-side navigations included, and their load performance. Cookieless; it never learns
 * who the viewer is.
 *
 * Every hit passes through `analyticsUrl` first (`lib/analytics.ts`). The
 * hook has to exist before the tracker's first page view or that one goes out
 * raw, so it is installed here, and only then is the script added — never as
 * a plain <script> tag in the layout, which could run first.
 */
export function Analytics({ src, websiteId, domain }: { src: string; websiteId: string; domain: string }) {
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w[BEFORE_SEND] = (_type: string, payload: Payload) => {
      const origin = window.location.origin;
      return {
        ...payload,
        url: payload.url && analyticsUrl(payload.url, origin),
        referrer: payload.referrer && analyticsUrl(payload.referrer, origin),
      };
    };
    if (document.querySelector('script[data-website-id]')) return;
    const script = document.createElement('script');
    script.defer = true;
    script.src = src;
    script.dataset.websiteId = websiteId;
    script.dataset.beforeSend = BEFORE_SEND;
    // Only the production host counts: a dev or staging build with the same
    // settings loads the script and records nothing.
    script.dataset.domains = domain;
    script.dataset.excludeHash = 'true';
    // Core Web Vitals (LCP, INP, CLS, FCP, TTFB), one hit per page view. They
    // go out as type 'performance' through the same before-send hook, so their
    // URLs are filtered like a page view's. Needs Umami 3.1 or later.
    script.dataset.performance = 'true';
    document.head.appendChild(script);
  }, [src, websiteId, domain]);
  return null;
}
