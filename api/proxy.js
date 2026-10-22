// HLS 转发:为没有 CORS 头的流补上跨域头和 User-Agent,并把清单里的分片地址改写成同样走本接口。
// 只允许白名单域名,避免被当成开放代理。
export const config = { runtime: 'edge' };

const ALLOWED_SUFFIXES = ['ch7.com', 'byteark.com'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

const allowed = (u) =>
  (u.protocol === 'http:' || u.protocol === 'https:') &&
  ALLOWED_SUFFIXES.some((s) => u.hostname === s || u.hostname.endsWith('.' + s));

const fail = (status, msg) => new Response(msg, { status, headers: { ...CORS, 'Content-Type': 'text/plain' } });

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const self = new URL(request.url);
  const target = self.searchParams.get('url');
  if (!target) return fail(400, 'missing url');

  let upstream;
  try { upstream = new URL(target); } catch { return fail(400, 'bad url'); }
  if (!allowed(upstream)) return fail(403, 'host not allowed');

  const proxied = (u) => `${self.origin}${self.pathname}?url=${encodeURIComponent(u)}`;

  let res;
  try {
    res = await fetch(upstream.href, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  } catch (e) {
    return fail(502, 'upstream fetch failed');
  }
  if (!res.ok) return fail(res.status, `upstream ${res.status}`);

  // 重定向后的最终地址要重新校验,并作为相对路径的基准
  const finalUrl = new URL(res.url || upstream.href);
  if (!allowed(finalUrl)) return fail(403, 'redirect host not allowed');

  const ctype = res.headers.get('content-type') || '';
  const isManifest = /mpegurl/i.test(ctype) || /\.m3u8?($|\?)/i.test(finalUrl.pathname + finalUrl.search);

  if (!isManifest) {
    const headers = { ...CORS, 'Content-Type': ctype || 'application/octet-stream', 'Cache-Control': 'public, max-age=30' };
    return new Response(res.body, { status: 200, headers });
  }

  const text = await res.text();
  const abs = (ref) => proxied(new URL(ref, finalUrl).href);
  const body = text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, ref) => `URI="${abs(ref)}"`);
      }
      return abs(t);
    })
    .join('\n');

  return new Response(body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' },
  });
}
