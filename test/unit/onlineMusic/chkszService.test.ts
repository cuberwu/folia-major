import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleChksz } from '../../../shared/chkszService.mjs';
import { handleLinglan } from '../../../shared/linglanService.mjs';

// test/unit/onlineMusic/chkszService.test.ts
const fetchMock = vi.fn();
const request = (source: string, path: string, method = 'GET') => new Request('http://folia.test/api/' + source + '/' + path, {
    method, headers: { Cookie: 'user-session', Authorization: 'Bearer user-token' },
});
describe('server-only audio suppliers', () => {
    beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); vi.stubEnv('CHKSZ_API_KEY', 'private-key'); vi.stubEnv('LINGLAN_API_KEY', 'private-key'); });
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
    it.each([['chksz', handleChksz], ['linglan', handleLinglan]] as const)('%s exposes status and audio only', async (name, handle) => {
        expect(await (await handle(request(name, 'status'))).json()).toMatchObject({ configured: true });
        expect((await handle(request(name, 'search?query=Song'))).status).toBe(404);
        expect((await handle(request(name, 'audio', 'POST'))).status).toBe(405);
        vi.stubEnv(name === 'chksz' ? 'CHKSZ_API_KEY' : 'LINGLAN_API_KEY', '');
        expect((await handle(request(name, 'audio'))).status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([['netease', '42', 'wy'], ['kugou', '0123456789ABCDEF0123456789ABCDEF', 'kg'], ['qq', '004Th6td4LaoZs', 'tx']])('maps %s identifiers without forwarding caller credentials', async (provider, id, source) => {
        fetchMock.mockResolvedValue(Response.json({ code: 0, url: 'https://audio.test/a.flac', debug: 'private-key' }));
        const response = await handleLinglan(request('linglan', 'audio?provider=' + provider + '&id=' + id + '&quality=lossless&url=https://evil.test'));
        const [target, options] = fetchMock.mock.calls[0];
        expect(new URL(target).origin + new URL(target).pathname).toBe('https://source.shiqianjiang.cn/api/music/url');
        expect(Object.fromEntries(new URL(target).searchParams)).toEqual({ source, songId: id, quality: 'flac' });
        expect(options.headers['X-API-Key']).toBe('private-key');
        expect(options.headers.Cookie).toBeUndefined(); expect(options.headers.Authorization).toBeUndefined();
        expect(options.redirect).toBe('error');
        expect(await response.text()).not.toContain('private-key');
    });
    it.each(['provider=qq&id=1234', 'provider=kw&id=12', 'provider=kugou&id=bad', 'provider=netease&id=-1', 'provider=netease&id=1&quality=__proto__'])('rejects invalid Linglan input: %s', async query => {
        expect((await handleLinglan(request('linglan', 'audio?' + query))).status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([['standard', '128k'], ['high', '320k'], ['lossless', 'flac'], ['hires', 'hires']])('maps quality %s', async (quality, upstream) => {
        fetchMock.mockResolvedValue(Response.json({ code: 200, url: 'https://audio.test/a' }));
        expect((await handleLinglan(request('linglan', 'audio?provider=netease&id=42&quality=' + quality))).status).toBe(200);
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('quality')).toBe(upstream);
    });
    it.each([403, 429])('preserves %s for HTTP and business errors', async code => {
        fetchMock.mockResolvedValueOnce(new Response('private-key', { status: code }))
            .mockResolvedValueOnce(Response.json({ code, message: 'private-key' }));
        for (let i = 0; i < 2; i++) {
            const response = await handleLinglan(request('linglan', 'audio?provider=netease&id=42'));
            expect(response.status).toBe(code); expect(await response.text()).not.toContain('private-key');
        }
    });
    it.each([null, '', 'javascript:alert(1)', 'https://audio.test/?key=private-key'])('rejects invalid success URLs', async url => {
        fetchMock.mockResolvedValue(Response.json({ code: 200, url }));
        expect((await handleLinglan(request('linglan', 'audio?provider=netease&id=42'))).status).toBe(502);
    });
    it('keeps ChKSz audio mapping and hides transport errors', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ code: 200, data: { id: 42, url: 'https://audio.test/a', level: 'exhigh' } }));
        expect((await handleChksz(request('chksz', 'audio?id=42&quality=high'))).status).toBe(200);
        expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe('/api/163_music');
        fetchMock.mockRejectedValueOnce(new Error('private-key'));
        const response = await handleChksz(request('chksz', 'audio?id=42'));
        expect(response.status).toBe(502); expect(await response.text()).not.toContain('private-key');
    });
});
