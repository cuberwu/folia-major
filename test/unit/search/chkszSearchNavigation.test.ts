import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import { searchAggregate } from '@/services/onlineMusic/aggregateSearch';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { resolveCommandPaletteSearchSource, useSearchNavigationStore } from '@/stores/useSearchNavigationStore';
import type { OnlineSearchPage } from '@/types/onlineMusic';

// test/unit/search/chkszSearchNavigation.test.ts
// The removed ChKSz search history is migrated to independent platform search.
const deps = { localSongs: [], t: (_key: string, fallback?: string) => fallback || '' };
const page = (provider: string, offset = 0): OnlineSearchPage => ({ items: [0, 1].map(index => ({
    id: offset + index, name: 'Song', artists: [], album: { id: 0, name: '' }, durationMs: 1000,
    sourceRef: { kind: 'online', providerId: provider, mediaId: String(offset + index) },
})), hasMore: offset < 2, nextOffset: offset + 2 });

describe('independent and aggregate search', () => {
    beforeEach(() => {
        useOnlineProviderAccountStore.setState({ accounts: {}, activeProviderId: 'netease' });
        useSearchNavigationStore.getState().resetRuntime();
        useSearchNavigationStore.setState({ searchSourceTab: 'aggregate', lastOnlineSearchSource: 'aggregate' });
    });
    afterEach(() => vi.restoreAllMocks());
    it('interleaves platform rankings without merging identities', async () => {
        const result = await searchAggregate(async provider => page(provider));
        expect(result.items.map(song => song.sourceRef!.kind === 'online' && song.sourceRef.providerId))
            .toEqual(['netease', 'kugou', 'qq', 'netease', 'kugou', 'qq']);
        expect(result.items).toHaveLength(6);
    });
    it('retries only a failed catalog with its original offset', async () => {
        const search = vi.fn(async (provider: string, offset: number) => {
            if (provider === 'qq') throw Error('offline'); return page(provider, offset);
        });
        const first = await searchAggregate(search);
        expect(first.routing?.providers.qq).toEqual({ offset: 0, hasMore: true, failed: true });
        const second = await searchAggregate(search, first.routing);
        expect(second.items).toHaveLength(4);
        search.mockClear().mockImplementation(async (provider, offset) => page(provider, offset));
        const retried = await searchAggregate(search, second.routing, 'qq');
        expect(search).toHaveBeenCalledExactlyOnceWith('qq', 0);
        expect(retried.routing?.providers.netease.offset).toBe(4);
    });
    it('uses 10 items per platform and keeps search choice independent of account changes', async () => {
        const search = vi.spyOn(omni, 'searchProviderSongs').mockImplementation(async provider => page(provider));
        await useSearchNavigationStore.getState().submitSearch({ query: 'Song', sourceTab: 'aggregate', deps });
        expect(search).toHaveBeenCalledWith('qq', 'Song', { limit: 10, offset: 0 });
        useOnlineProviderAccountStore.getState().setActiveProviderId('kugou');
        expect(resolveCommandPaletteSearchSource(null, 'aggregate', 'kugou')).toBe('aggregate');
        useOnlineProviderAccountStore.getState().updateAccount('qq', { status: 'authenticated', user: { id: 'u', nickname: 'U' } });
        expect(useSearchNavigationStore.getState().searchResults).toHaveLength(6);
        expect(useSearchNavigationStore.getState().lastOnlineSearchSource).toBe('aggregate');
        expect(useSearchNavigationStore.getState().searchCache).toEqual({});
    });
    it('drops stale results and maps old history without any ChKSz request', async () => {
        let finish!: (value: OnlineSearchPage) => void;
        vi.spyOn(omni, 'searchSourceSongs').mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
            .mockResolvedValueOnce(page('qq'));
        const pending = useSearchNavigationStore.getState().submitSearch({ query: 'old', sourceTab: 'netease', deps });
        await useSearchNavigationStore.getState().submitSearch({ query: 'new', sourceTab: 'qq', deps });
        finish(page('netease'));
        expect(await pending).toBe(false);
        expect(useSearchNavigationStore.getState().searchSourceTab).toBe('qq');
        useSearchNavigationStore.getState().restoreSearch({ query: 'old', sourceTab: 'chksz:netease' });
        expect(useSearchNavigationStore.getState().searchSourceTab).toBe('netease');
    });
    it('drops in-flight search results on account change while retaining the selected catalog', async () => {
        let finish!: (value: OnlineSearchPage) => void;
        vi.spyOn(omni, 'searchSourceSongs').mockReturnValue(new Promise(resolve => { finish = resolve; }));
        const pending = useSearchNavigationStore.getState().submitSearch({ query: 'Song', sourceTab: 'qq', deps });
        useOnlineProviderAccountStore.getState().updateAccount('qq', { status: 'authenticated', user: { id: 'u', nickname: 'U' } });
        finish(page('qq'));
        expect(await pending).toBe(false);
        expect(useSearchNavigationStore.getState().searchResults).toBeNull();
        expect(useSearchNavigationStore.getState().lastOnlineSearchSource).toBe('qq');
    });
});
