import type { UnifiedSong } from '../../types';
import type { OnlineProviderId, OnlineSearchPage, OnlineSearchRouting, ProviderPage } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// src/services/onlineMusic/aggregateSearch.ts

export const SEARCH_PROVIDERS = ['netease', 'kugou', 'qq'] as const;

export const uniqueSearchSongs = (songs: UnifiedSong[]): UnifiedSong[] => (
    [...new Map(songs.map(song => [getPlaybackSongKey(song), song])).values()]
);

// Each catalog owns its cursor; failed pages can be retried without advancing successful catalogs.
export async function searchAggregate(
    search: (provider: OnlineProviderId, offset: number) => Promise<ProviderPage<UnifiedSong>>,
    previous?: OnlineSearchRouting,
    retryProvider?: OnlineProviderId,
): Promise<OnlineSearchPage> {
    const providers = { ...previous?.providers };
    const pages = await Promise.all(SEARCH_PROVIDERS.map(async provider => {
        const cursor = providers[provider] ?? { offset: 0, hasMore: true };
        if (retryProvider ? provider !== retryProvider : !cursor.hasMore || cursor.failed) return [];
        try {
            const page = await search(provider, cursor.offset);
            providers[provider] = { offset: page.nextOffset, hasMore: page.hasMore };
            return page.items;
        } catch {
            providers[provider] = { ...cursor, failed: true };
            return [];
        }
    }));
    const interleaved: UnifiedSong[] = [];
    for (let index = 0; index < Math.max(0, ...pages.map(page => page.length)); index++) {
        for (const page of pages) if (page[index]) interleaved.push(page[index]);
    }
    return {
        items: uniqueSearchSongs(interleaved), routing: { providers },
        hasMore: Object.values(providers).some(cursor => cursor.hasMore && !cursor.failed),
        nextOffset: Object.values(providers).reduce((total, cursor) => total + cursor.offset, 0),
    };
}
