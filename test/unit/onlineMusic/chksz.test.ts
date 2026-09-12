import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSong } from '@/types';
import { requestChksz } from '@/services/onlineMusic/chkszTransport';
import { getLinglanAudio } from '@/services/onlineMusic/linglanAdapter';
import { neteaseProvider } from '@/services/onlineMusic/neteaseProvider';
import { qqProvider } from '@/services/onlineMusic/qqProvider';
import { kugouProvider } from '@/services/onlineMusic/kugouProvider';
import { omni } from '@/services/onlineMusic/omni';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { clearPrefetchRuntime, getPrefetchedData, updatePrefetchedAudioUrl } from '@/services/prefetchService';
import { resolveAudioWithFallback } from '@/services/onlineMusic/playbackRouting';

// test/unit/onlineMusic/chksz.test.ts

vi.mock('@/services/onlineMusic/chkszTransport', () => ({ requestChksz: vi.fn(), discoverChksz: vi.fn() }));
vi.mock('@/services/onlineMusic/linglanAdapter', () => ({ getLinglanAudio: vi.fn(), discoverLinglan: vi.fn() }));
const song: UnifiedSong = { id: 42, name: 'Test', artists: [], album: { id: 1, name: '' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '42', playbackRoute: 'chksz' } };
const audio = { url: 'https://audio.test/track.mp3', fetchedAt: Date.now(), quality: 'high' as const };

describe('catalog-independent audio fallback', () => {
    beforeEach(() => {
        vi.mocked(requestChksz).mockReset(); vi.mocked(getLinglanAudio).mockReset();
        useOnlineProviderAccountStore.setState({ chkszConfigured: true, linglanConfigured: true, accounts: {}, activeProviderId: 'qq' });
        useOnlineProviderAccountStore.getState().updateAccount('netease', { status: 'authenticated', user: { id: 1, nickname: 'Owner' } });
        clearPrefetchRuntime();
    });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

    it.each([[true, true], [true, false], [false, true], [false, false]])('skips anonymous NetEase audio with supplier configuration %s/%s', async (chkszConfigured, linglanConfigured) => {
        const native = vi.spyOn(neteaseProvider.playback!, 'getAudioSource').mockResolvedValue(audio);
        vi.spyOn(neteaseProvider.playback!, 'getAvailability').mockReturnValue({ state: 'unavailable' });
        updatePrefetchedAudioUrl(song, audio.url, 'high', undefined, { resolvedRoute: 'native' });
        useOnlineProviderAccountStore.getState().clearAccount('netease');
        useOnlineProviderAccountStore.setState({ chkszConfigured, linglanConfigured });
        vi.mocked(requestChksz).mockResolvedValue({ url: audio.url });
        vi.mocked(getLinglanAudio).mockResolvedValue(audio);
        const result = await omni.getAudioSource(song, 'high');
        expect(result?.resolvedRoute ?? null).toBe(chkszConfigured ? 'chksz' : linglanConfigured ? 'linglan' : null);
        expect(native).not.toHaveBeenCalled();
        expect(omni.getSongAvailability(song).state).toBe(chkszConfigured || linglanConfigured ? 'unknown' : 'unavailable');
        expect(getPrefetchedData(song, 'high')?.audioUrl).toBeNull();
    });

    it('normalizes Linglan HTTP media to HTTPS for Web playback', async () => {
        const adapter = await vi.importActual<typeof import('@/services/onlineMusic/linglanAdapter')>('@/services/onlineMusic/linglanAdapter');
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 200, data: { url: 'http://fsdg360.hw.kugou.com/audio.mp3' } })));
        expect(await adapter.getLinglanAudio(song, 'high')).toMatchObject({ url: 'https://fsdg360.hw.kugou.com/audio.mp3' });
    });

    it('discards late account-bound audio without trying another supplier', async () => {
        let finish!: (value: typeof audio) => void;
        const pending = resolveAudioWithFallback(song, 'high', () => new Promise(resolve => { finish = resolve; }));
        useOnlineProviderAccountStore.getState().updateAccount('netease', { status: 'authenticated', user: { id: 9, nickname: 'Other' } });
        finish(audio);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(requestChksz).not.toHaveBeenCalled(); expect(getLinglanAudio).not.toHaveBeenCalled();
    });

    it('uses the song owner first even for old ChKSz queue entries, stopping on success', async () => {
        const native = vi.spyOn(neteaseProvider.playback!, 'getAudioSource').mockResolvedValue(audio);
        expect(await omni.getAudioSource(song, 'high')).toMatchObject({ resolvedRoute: 'native', fallbackUsed: false });
        expect(native).toHaveBeenCalledWith(song, 'high');
        expect(requestChksz).not.toHaveBeenCalled(); expect(getLinglanAudio).not.toHaveBeenCalled();
    });
    it('falls through native, ChKSz and Linglan in order', async () => {
        const order: string[] = [];
        vi.spyOn(neteaseProvider.playback!, 'getAudioSource').mockImplementation(async () => { order.push('native'); throw Error('403'); });
        vi.mocked(requestChksz).mockImplementation(async () => { order.push('chksz'); throw Error('429'); });
        vi.mocked(getLinglanAudio).mockImplementation(async () => { order.push('linglan'); return audio; });
        expect(await omni.getAudioSource(song, 'high')).toMatchObject({ resolvedRoute: 'linglan', fallbackUsed: true });
        expect(order).toEqual(['native', 'chksz', 'linglan']);
    });
    it.each([null, { ...audio, url: 'javascript:alert(1)' }])('falls back from an unusable native result', async result => {
        vi.spyOn(neteaseProvider.playback!, 'getAudioSource').mockResolvedValue(result);
        vi.mocked(requestChksz).mockResolvedValue({ url: audio.url, level: 'exhigh' });
        expect(await omni.getAudioSource(song, 'high')).toMatchObject({ resolvedRoute: 'chksz' });
        expect(getLinglanAudio).not.toHaveBeenCalled();
    });
    it.each([qqProvider, kugouProvider])('skips ChKSz for $id and permits external playback without the native backend', async provider => {
        vi.spyOn(provider, 'getAvailability').mockReturnValue({ configured: false });
        const native = vi.spyOn(provider.playback!, 'getAudioSource');
        vi.mocked(getLinglanAudio).mockResolvedValue(audio);
        expect(await omni.getAudioSource({ ...song, sourceRef: { kind: 'online', providerId: provider.id, mediaId: 'mid' } }, 'high'))
            .toMatchObject({ resolvedRoute: 'linglan' });
        expect(native).not.toHaveBeenCalled(); expect(requestChksz).not.toHaveBeenCalled();
    });
    it('does not expose private cloud songs to external suppliers or pre-filter public unavailable songs', async () => {
        vi.spyOn(neteaseProvider.playback!, 'getAudioSource').mockResolvedValue(null);
        vi.spyOn(neteaseProvider.playback!, 'getAvailability').mockReturnValue({ state: 'unavailable' });
        const cloud = { ...song, sourceRef: { kind: 'online' as const, providerId: 'netease', mediaId: '42', variant: 'cloud' } };
        expect(await omni.getAudioSource(cloud, 'high')).toBeNull();
        expect(requestChksz).not.toHaveBeenCalled(); expect(getLinglanAudio).not.toHaveBeenCalled();
        expect(omni.getSongAvailability(song).state).toBe('unknown');
        expect(omni.getSongAvailability(cloud).state).toBe('unavailable');
    });
    it('bounds timeouts and never falls back after cancellation', async () => {
        vi.useFakeTimers();
        const never = () => new Promise<null>(() => {});
        vi.mocked(requestChksz).mockResolvedValue({ url: audio.url });
        const pending = resolveAudioWithFallback(song, 'high', never);
        await vi.advanceTimersByTimeAsync(15001);
        expect(await pending).toMatchObject({ resolvedRoute: 'chksz' });
        vi.mocked(requestChksz).mockClear();
        const controller = new AbortController();
        const canceled = resolveAudioWithFallback(song, 'high', never, { signal: controller.signal });
        const rejection = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort(); await rejection;
        expect(requestChksz).not.toHaveBeenCalled();
    });
    it('excludes failed suppliers, exhausts once and invalidates URLs when context changes', async () => {
        const native = vi.fn(async () => audio);
        vi.mocked(getLinglanAudio).mockResolvedValue(null);
        expect(await resolveAudioWithFallback(song, 'high', native, { excludeRoutes: ['native', 'chksz'] })).toBeNull();
        expect(native).not.toHaveBeenCalled(); expect(getLinglanAudio).toHaveBeenCalledOnce();
        updatePrefetchedAudioUrl(song, audio.url, 'high');
        useOnlineProviderAccountStore.getState().setLinglanConfigured(false);
        expect(getPrefetchedData(song, 'high')?.audioUrl).toBeNull();
        updatePrefetchedAudioUrl(song, 'CACHED_IN_DB', 'high');
        useOnlineProviderAccountStore.getState().setChkszConfigured(false);
        expect(getPrefetchedData(song, 'high')?.audioUrl).toBe('CACHED_IN_DB');
    });
});
