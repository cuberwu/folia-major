// shared/chkszService.mjs
// Docker's server-side ChKSz boundary: only public NetEase audio resolution.

const QUALITY_LEVELS = { standard: 'standard', high: 'exhigh', lossless: 'lossless', hires: 'hires' };
const json = (body, status = 200) => Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
});
const failure = (status, error) => json({ error }, status);
const integer = (value, fallback, min, max) => {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
};

// Construct the upstream request ourselves; never forward headers, cookies, paths or arbitrary URLs.
export async function handleChksz(request) {
    if (request.method !== 'GET') return failure(405, 'method-not-allowed');
    const url = new URL(request.url);
    const operation = url.pathname.split('/').pop();
    if (!['status', 'audio'].includes(operation)) return failure(404, 'not-found');
    const apiKey = (process.env.CHKSZ_API_KEY || '').trim();
    if (operation === 'status') return json({ configured: Boolean(apiKey) });
    if (!apiKey) return failure(503, 'not-configured');

    const params = new URLSearchParams({ apikey: apiKey });
    {
        const id = url.searchParams.get('id') || '';
        const quality = url.searchParams.get('quality') || 'high';
        if (integer(id, null, 1, Number.MAX_SAFE_INTEGER) === null || !Object.hasOwn(QUALITY_LEVELS, quality)) {
            return failure(400, 'invalid-parameters');
        }
        params.set('id', id);
        params.set('level', QUALITY_LEVELS[quality]);
        params.set('type', 'json');
    }

    try {
        const endpoint = '163_music';
        const response = await fetch(`https://api.chksz.com/api/${endpoint}?${params}`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
            redirect: 'error',
        });
        if (response.status === 401 || response.status === 403) return failure(response.status, 'upstream-auth');
        if (response.status === 429) return failure(429, 'rate-limited');
        if (response.status === 504) return failure(504, 'upstream-failed');
        const body = await response.json();
        const code = response.ok ? Number(body?.code) : response.status;
        if (code === 401 || code === 403) return failure(code, 'upstream-auth');
        if (code === 429) return failure(429, 'rate-limited');
        if (!response.ok || code !== 200 || !body.data) return failure(502, 'upstream-failed');
        // Keep only the music fields the adapter needs; upstream diagnostics must not expose our key.
        const data = Object.fromEntries(['id', 'url', 'level', 'br'].map(key => [key, body.data[key]]));
        if (JSON.stringify(data).includes(apiKey)) return failure(502, 'invalid-response');
        return json({ code: 200, data });
    } catch (error) {
        return failure(error?.name === 'TimeoutError' ? 504 : 502, 'upstream-failed');
    }
}
