import { create } from 'zustand';
import { getNavidromeConfig, navidromeApi } from '../services/navidromeService';
import type { HomeViewTab, LocalSong, SongResult, UnifiedSong } from '../types';
import type { OnlineProviderId, OnlineSearchRouting } from '../types/onlineMusic';
import { useOnlineProviderAccountStore } from './useOnlineProviderAccountStore';
import {
    applyLocalLibraryEntityDisplay,
    buildUnifiedLocalSong,
    type LocalLibraryDisplayCatalog,
} from '../services/playbackAdapters';
import { uniqueSearchSongs } from '../services/onlineMusic/aggregateSearch';
import { omni } from '../services/onlineMusic/omni';
import { isLocalPlaybackSong, isNavidromePlaybackSong } from '../utils/appPlaybackGuards';

const LAST_HOME_VIEW_TAB_KEY = 'last_home_view_tab';
const DEFAULT_SEARCH_LIMIT = 30;
const ONLINE_SEARCH_KEY = 'folia_online_search_source';
const normalizeSource = (source: string): SearchSource => source === 'chksz:netease' ? 'netease' : source;
const initialOnlineSource = (): SearchSource => {
    const saved = typeof localStorage !== 'undefined' && localStorage.getItem(ONLINE_SEARCH_KEY);
    return saved && ['aggregate', 'netease', 'kugou', 'qq'].includes(saved) ? saved : 'aggregate';
};
const allSearchProvidersFailed = (routing?: OnlineSearchRouting) => Boolean(routing
    && Object.values(routing.providers).every(cursor => cursor.failed));
export type SearchSource = OnlineProviderId | 'local' | 'navidrome';
export type SearchReturnView = 'home' | 'player';

type SearchExecutorDeps = {
    localSongs: LocalSong[];
    localLibraryCatalog?: LocalLibraryDisplayCatalog;
    t: (key: string, fallback?: string) => string;
};

type SearchExecutionResult = {
    routing?: OnlineSearchRouting;
    results: UnifiedSong[];
    hasMore: boolean;
    nextOffset: number;
};

type SearchCacheEntry = {
    routing?: OnlineSearchRouting;
    results: UnifiedSong[];
    offset: number;
    hasMore: boolean;
    scrollTop: number;
};

interface SearchNavigationState {
    routing?: OnlineSearchRouting;
    lastOnlineSearchSource: SearchSource;
    homeViewTab: HomeViewTab;
    searchQuery: string;
    searchSourceTab: SearchSource;
    searchResults: UnifiedSong[] | null;
    searchReturnView: SearchReturnView;
    isSearchOpen: boolean;
    isSearching: boolean;
    isLoadingMore: boolean;
    searchError: string | null;
    requestId: number;
    offset: number;
    limit: number;
    hasMore: boolean;
    scrollTop: number;
    searchCache: Record<string, SearchCacheEntry>;
    setHomeViewTab: (tab: HomeViewTab) => void;
    setSearchQuery: (query: string) => void;
    setSearchScrollTop: (scrollTop: number) => void;
    restoreSearch: (payload: { query: string; sourceTab: SearchSource; returnView?: SearchReturnView; }) => void;
    hideSearchOverlay: () => void;
    resetRuntime: (onlineProviderId?: OnlineProviderId) => void;
    submitSearch: (payload: { query?: string; sourceTab: SearchSource; deps: SearchExecutorDeps; returnView?: SearchReturnView; }) => Promise<boolean>;
    loadMoreSearchResults: (payload: { deps: SearchExecutorDeps; retryProvider?: OnlineProviderId; }) => Promise<void>;
}

const getSearchCacheKey = (query: string, sourceTab: SearchSource) => (
    `${sourceTab}:${query.trim().toLowerCase()}`
);

export const resolveSearchSource = (tab: HomeViewTab | SearchSource): SearchSource => {
    if (tab === 'local' || tab === 'navidrome') {
        return tab;
    }
    if (tab !== 'playlist' && tab !== 'albums' && tab !== 'radio') return tab as OnlineProviderId;
    return useSearchNavigationStore.getState().lastOnlineSearchSource;
};

export const resolveCommandPaletteSearchSource = (
    currentSong: SongResult | null,
    searchSourceTab: SearchSource,
    _activeOnlineProviderId: OnlineProviderId,
): SearchSource => {
    if (useSearchNavigationStore.getState().isSearchOpen) return searchSourceTab;
    if (currentSong && isLocalPlaybackSong(currentSong)) return 'local';
    if (currentSong && isNavidromePlaybackSong(currentSong)) return 'navidrome';
    return useSearchNavigationStore.getState().lastOnlineSearchSource;
};

const mapLocalSongToUnifiedSong = (
    song: LocalSong,
    catalog?: LocalLibraryDisplayCatalog,
): UnifiedSong => applyLocalLibraryEntityDisplay(buildUnifiedLocalSong({
        localSong: song,
        matchedSong: null,
        coverUrl: song.useOnlineCover ? song.onlineMetadata?.coverUrl || null : null,
        preferOnlineMetadata: false,
    }), catalog);

const searchLocalSongs = (
    deps: SearchExecutorDeps,
    query: string,
): SearchExecutionResult => {
    const lowerQuery = query.toLowerCase();
    const results = deps.localSongs
        .filter(song => {
            const title = song.title.toLowerCase();
            const artist = [
                ...song.importedMetadata.artistNames,
                ...song.onlineMetadata?.artists.map(item => item.name) || [],
            ].join(' ').toLowerCase();
            const album = [song.importedMetadata.albumName, song.onlineMetadata?.album?.name]
                .filter(Boolean).join(' ').toLowerCase();
            return title.includes(lowerQuery) || artist.includes(lowerQuery) || album.includes(lowerQuery);
        })
        .map(song => mapLocalSongToUnifiedSong(song, deps.localLibraryCatalog));

    return {
        results,
        hasMore: false,
        nextOffset: results.length,
    };
};

const searchNavidromeSongs = async (query: string): Promise<SearchExecutionResult> => {
    const config = getNavidromeConfig();
    if (!config) {
        return { results: [], hasMore: false, nextOffset: 0 };
    }

    const response = await navidromeApi.search(config, query, 0, 0, DEFAULT_SEARCH_LIMIT);
    const results = (response.song || []).map(song => {
        const navidromeSong = navidromeApi.toNavidromeSong(config, song);
        return navidromeSong as UnifiedSong;
    });

    return {
        results,
        hasMore: false,
        nextOffset: results.length,
    };
};

const searchOnlineProviderSongs = async (
    providerId: OnlineProviderId,
    query: string,
    limit: number,
    offset: number,
    routing?: OnlineSearchRouting,
    retryProvider?: OnlineProviderId,
): Promise<SearchExecutionResult> => {
    const page = await omni.searchSourceSongs(providerId, query, { limit, offset }, routing, retryProvider);
    return { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset, routing: page.routing };
};

const executeSearch = async (
    query: string,
    sourceTab: SearchSource,
    offset: number,
    limit: number,
    deps: SearchExecutorDeps,
    routing?: OnlineSearchRouting,
    retryProvider?: OnlineProviderId,
): Promise<SearchExecutionResult> => {
    if (sourceTab === 'local') {
        return searchLocalSongs(deps, query);
    }

    if (sourceTab === 'navidrome') {
        return searchNavidromeSongs(query);
    }

    return searchOnlineProviderSongs(sourceTab, query, limit, offset, routing, retryProvider);
};

const getInitialHomeViewTab = (): HomeViewTab => {
    if (typeof window === 'undefined') {
        return 'playlist';
    }
    const savedTab = localStorage.getItem(LAST_HOME_VIEW_TAB_KEY);
    return savedTab === 'playlist' || savedTab === 'local' || savedTab === 'albums' || savedTab === 'navidrome' || savedTab === 'radio'
        ? savedTab
        : 'playlist';
};

export const useSearchNavigationStore = create<SearchNavigationState>((set, get) => ({
    homeViewTab: getInitialHomeViewTab(),
    searchQuery: '',
    searchSourceTab: initialOnlineSource(),
    lastOnlineSearchSource: initialOnlineSource(),
    searchResults: null,
    searchReturnView: 'home',
    isSearchOpen: false,
    isSearching: false,
    isLoadingMore: false,
    searchError: null,
    requestId: 0,
    offset: 0,
    limit: DEFAULT_SEARCH_LIMIT,
    hasMore: false,
    scrollTop: 0,
    searchCache: {},
    setHomeViewTab: (tab) => {
        if (typeof window !== 'undefined') {
            localStorage.setItem(LAST_HOME_VIEW_TAB_KEY, tab);
        }
        set({ homeViewTab: tab });
    },
    setSearchQuery: (query) => set({ searchQuery: query }),
    setSearchScrollTop: (scrollTop) => set(state => {
        const cacheKey = getSearchCacheKey(state.searchQuery, state.searchSourceTab);
        const cached = state.searchCache[cacheKey];
        return {
            scrollTop,
            searchCache: cached
                ? {
                    ...state.searchCache,
                    [cacheKey]: { ...cached, scrollTop },
                }
                : state.searchCache,
        };
    }),
    restoreSearch: ({ query, sourceTab, returnView = 'home' }) => set(state => {
        sourceTab = normalizeSource(sourceTab);
        const cached = state.searchCache[getSearchCacheKey(query, sourceTab)];
        return {
            requestId: state.requestId + 1,
            routing: cached?.routing,
            searchQuery: query,
            searchSourceTab: sourceTab,
            searchReturnView: returnView,
            searchResults: cached?.results ?? null,
            offset: cached?.offset ?? 0,
            hasMore: cached?.hasMore ?? false,
            scrollTop: cached?.scrollTop ?? 0,
            searchError: null,
            isSearching: false,
            isLoadingMore: false,
            isSearchOpen: true,
        };
    }),
    hideSearchOverlay: () => set({ isSearchOpen: false, searchReturnView: 'home' }),
    resetRuntime: (_onlineProviderId) => set(state => ({
        routing: undefined,
        searchCache: {},
        searchQuery: '',
        searchSourceTab: state.searchSourceTab,
        searchResults: null,
        searchReturnView: 'home',
        isSearchOpen: false,
        isSearching: false,
        isLoadingMore: false,
        searchError: null,
        requestId: state.requestId + 1,
        offset: 0,
        hasMore: false,
        scrollTop: 0,
    })),
    submitSearch: async ({ query, sourceTab, deps, returnView = 'home' }) => {
        sourceTab = normalizeSource(sourceTab);
        const trimmedQuery = (query ?? get().searchQuery).trim();
        if (!trimmedQuery) {
            return false;
        }

        if (['aggregate', 'netease', 'kugou', 'qq'].includes(sourceTab)) {
            if (typeof localStorage !== 'undefined') localStorage.setItem(ONLINE_SEARCH_KEY, sourceTab);
            set({ lastOnlineSearchSource: sourceTab });
        }
        const requestId = get().requestId + 1;
        set({
            searchQuery: trimmedQuery,
            routing: undefined,
            searchSourceTab: sourceTab,
            searchReturnView: returnView,
            isSearchOpen: true,
            isSearching: true,
            isLoadingMore: false,
            searchError: null,
            requestId,
            searchResults: null,
            offset: 0,
            hasMore: false,
            scrollTop: 0,
        });

        try {
            const result = await executeSearch(trimmedQuery, sourceTab, 0, get().limit, deps);
            if (get().requestId !== requestId) {
                return false;
            }
            set(state => ({
                routing: result.routing,
                searchError: allSearchProvidersFailed(result.routing) ? 'search_failed' : null,
                searchResults: result.results,
                hasMore: result.hasMore,
                offset: result.nextOffset,
                isSearching: false,
                searchCache: {
                    ...state.searchCache,
                    [getSearchCacheKey(trimmedQuery, sourceTab)]: {
                        routing: result.routing,
                        results: result.results,
                        hasMore: result.hasMore,
                        offset: result.nextOffset,
                        scrollTop: 0,
                    },
                },
            }));
            return true;
        } catch (error) {
            console.error('[SearchStore] submitSearch failed:', error);
            if (get().requestId !== requestId) {
                return false;
            }
            set({
                searchResults: [],
                hasMore: false,
                offset: 0,
                isSearching: false,
                searchError: error instanceof Error ? error.message : 'search_failed',
            });
            return true;
        }
    },
    loadMoreSearchResults: async ({ deps, retryProvider }) => {
        const {
            searchQuery,
            searchSourceTab,
            searchResults,
            hasMore,
            isSearching,
            isLoadingMore,
            offset,
            limit,
            routing,
        } = get();

        if (
            searchSourceTab === 'local'
            || searchSourceTab === 'navidrome'
            || (!hasMore && !retryProvider)
            || isSearching
            || isLoadingMore
            || !searchQuery.trim()
        ) {
            return;
        }

        const requestId = get().requestId;
        set({ isLoadingMore: true, searchError: null });

        try {
            const result = await executeSearch(searchQuery, searchSourceTab, offset, limit, deps, routing, retryProvider);
            if (get().requestId !== requestId) {
                return;
            }
            set(state => {
                const results = uniqueSearchSongs([...(searchResults || []), ...result.results]);
                return {
                    routing: result.routing,
                    searchError: results.length === 0 && allSearchProvidersFailed(result.routing) ? 'search_failed' : null,
                    scrollTop: state.scrollTop,
                    searchResults: results,
                    hasMore: result.hasMore,
                    offset: result.nextOffset,
                    isLoadingMore: false,
                    searchCache: {
                        ...state.searchCache,
                        [getSearchCacheKey(searchQuery, searchSourceTab)]: {
                            routing: result.routing,
                            results,
                            hasMore: result.hasMore,
                            offset: result.nextOffset,
                            scrollTop: state.scrollTop,
                        },
                    },
                };
            });
        } catch (error) {
            console.error('[SearchStore] loadMoreSearchResults failed:', error);
            if (get().requestId === requestId) {
                set({
                    isLoadingMore: false,
                    searchError: error instanceof Error ? error.message : 'search_failed',
                });
            }
        }
    },
}));

// Keep displayed results stable, but invalidate account-bound pages and in-flight requests on login/logout.
useOnlineProviderAccountStore.subscribe((state, previous) => {
    const identities = (accounts: typeof state.accounts) => JSON.stringify(Object.entries(accounts)
        .filter(([, account]) => account.status === 'authenticated')
        .map(([id, account]) => [id, account.user?.id]));
    if (identities(state.accounts) === identities(previous.accounts)) return;
    useSearchNavigationStore.setState(search => ({
        searchCache: {}, requestId: search.requestId + 1, hasMore: false,
        isSearching: false, isLoadingMore: false, routing: undefined,
    }));
});
