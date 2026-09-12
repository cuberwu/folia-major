// shared/linglanService.mjs
// The site's credential stays on the server; only fixed audio-resolution operations are exposed.

const SOURCES = { netease: 'wy', kugou: 'kg', qq: 'tx' };
const QUALITIES = { standard: '128k', high: '320k', lossless: 'flac', hires: 'hires' };
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (status, error) => json({ error }, status);

export async function handleLinglan(request) {
    if (request.method !== 'GET') return failure(405, 'method-not-allowed');
    const url = new URL(request.url);
    const operation = url.pathname.split('/').pop();
    if (!['status', 'audio'].includes(operation)) return failure(404, 'not-found');
    const key = (process.env.LINGLAN_API_KEY || '').trim();
    if (operation === 'status') return json({ configured: Boolean(key), providers: key ? Object.keys(SOURCES) : [] });
    if (!key) return failure(503, 'not-configured');
    const provider = url.searchParams.get('provider');
    const id = url.searchParams.get('id') || '';
    const quality = url.searchParams.get('quality') || 'high';
    const validId = provider === 'netease' ? /^[1-9]\d{0,19}$/.test(id)
        : provider === 'kugou' ? /^[a-f\d]{32}$/i.test(id)
            : provider === 'qq' && /^[a-z\d]{1,64}$/i.test(id) && /[a-z]/i.test(id);
    if (!Object.hasOwn(SOURCES, provider) || !Object.hasOwn(QUALITIES, quality) || !validId) {
        return failure(400, 'invalid-parameters');
    }
    const params = new URLSearchParams({ source: SOURCES[provider], songId: id, quality: QUALITIES[quality] });
    try {
        const response = await fetch(`https://source.shiqianjiang.cn/api/music/url?${params}`, {
            headers: { Accept: 'application/json', 'X-API-Key': key, 'X-Request-ID': crypto.randomUUID(), 'User-Agent': 'Folia/0.7' },
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]), redirect: 'error',
        });
        if ([401, 403, 429].includes(response.status)) return failure(response.status, 'upstream-unavailable');
        if (!response.ok) return failure(502, 'upstream-failed');
        const body = await response.json();
        const code = typeof body?.code === 'number' || typeof body?.code === 'string' && body.code.trim() !== ''
            ? Number(body.code) : NaN;
        if ([401, 403, 429].includes(code)) return failure(code, 'upstream-unavailable');
        if (![0, 200].includes(code) || typeof body.url !== 'string') return failure(502, 'invalid-response');
        const audio = new URL(body.url);
        if (!['http:', 'https:'].includes(audio.protocol) || audio.username || audio.password
            || body.url.includes(key) || decodeURIComponent(body.url).includes(key)) return failure(502, 'invalid-response');
        return json({ code: 200, data: { url: audio.href, quality } });
    } catch (error) {
        return failure(error?.name === 'TimeoutError' ? 504 : 502, 'upstream-failed');
    }
}
