export const dynamic = 'force-static';

/**
 * API reference, rendered by Scalar from `/api/v1/openapi.json`. Scalar is
 * loaded from jsDelivr at a pinned version; the document itself is ours and
 * generated from the Zod schemas.
 */
const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>papermarket API</title>
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1"></script>
  </body>
</html>`;

export function GET() {
  return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
