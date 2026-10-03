/** What the first-trade page's share buttons post, before the link: an invitation to try it. */
export function shareMessage(s: { name: string; venue: string }): string {
  return `Want to know if your paper will get into ${s.venue}? I just made my first trade on ${s.name}, check it out!`;
}

/**
 * Where the first-trade page's share buttons go: each service's own share
 * page, prefilled with the message and `url` (the market just traded). Plain links, so no
 * third-party script is loaded and nothing is posted until the person does.
 */
export function siteShareLinks(s: { name: string; venue: string; url: string }): { x: string; whatsapp: string } {
  const text = shareMessage(s);
  return {
    x: `https://x.com/intent/post?${new URLSearchParams({ text, url: s.url })}`,
    whatsapp: `https://wa.me/?${new URLSearchParams({ text: `${text} ${s.url}` })}`,
  };
}
