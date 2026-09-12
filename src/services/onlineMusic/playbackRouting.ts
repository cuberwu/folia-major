import type { SongResult } from '../../types';
import type { AudioQualityPreference, AudioSourceOptions, OnlinePlaybackRoute, ProviderAudioSource } from '../../types/onlineMusic';
import { useOnlineProviderAccountStore } from '../../stores/useOnlineProviderAccountStore';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { toSafePlaybackUrl } from '../../utils/appPlaybackHelpers';
import { chkszAdapter } from './chkszAdapter';
import { getLinglanAudio } from './linglanAdapter';
import { getProviderSessionRevision } from './providerStorage';

// src/services/onlineMusic/playbackRouting.ts

export const isPrivateOnlineSong = (song: SongResult): boolean => {
    const ref = getPlaybackSourceRef(song);
    return ref.kind === 'online' && (ref.variant === 'cloud' || song.sourceType === 'cloud' || song.t === 1 || song.t === 2);
};

export function getAudioRoutes(song: SongResult): OnlinePlaybackRoute[] {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online' || isPrivateOnlineSong(song)) return ['native'];
    const state = useOnlineProviderAccountStore.getState();
    // Anonymous NetEase URLs can be 30-second previews; public songs use external suppliers directly.
    const routes: OnlinePlaybackRoute[] = ref.providerId === 'netease' && state.accounts.netease?.status !== 'authenticated'
        ? [] : ['native'];
    if (ref.providerId === 'netease' && state.chkszConfigured) routes.push('chksz');
    if (state.linglanConfigured && ['netease', 'kugou', 'qq'].includes(ref.providerId)) routes.push('linglan');
    return routes;
}

export function getAudioRequestKey(song: SongResult): string | undefined {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online') return undefined;
    const account = useOnlineProviderAccountStore.getState().accounts[ref.providerId];
    return `${ref.providerId}:${getAudioRoutes(song).join(',')}:${account?.status}:${account?.user?.id ?? ''}:${getProviderSessionRevision(ref.providerId)}`;
}

// Bound even legacy native adapters that do not accept a signal; their late results are discarded.
export async function awaitAudioRequest<T>(run: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Audio source timed out', 'TimeoutError')), 15000);
    const signal = parent ? AbortSignal.any([parent, timeout.signal]) : timeout.signal;
    let onAbort: () => void = () => {};
    try {
        signal.throwIfAborted();
        const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
        });
        return await Promise.race([run(signal), aborted]);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
    }
}

// Fallback changes the audio supplier, never the song's catalog identity or lyric provider.
export async function resolveAudioWithFallback(
    song: SongResult, quality: AudioQualityPreference,
    nativeAudio: () => Promise<ProviderAudioSource | null>, options: AudioSourceOptions = {},
): Promise<ProviderAudioSource | null> {
    const requestKey = getAudioRequestKey(song);
    const failedRoutes = [...options.excludeRoutes ?? []];
    for (const route of getAudioRoutes(song)) {
        options.signal?.throwIfAborted();
        if (options.excludeRoutes?.includes(route)) continue;
        try {
            const source = await awaitAudioRequest(signal => route === 'native' ? nativeAudio()
                : route === 'chksz' ? chkszAdapter.getAudioSource(song, quality, signal)
                    : getLinglanAudio(song, quality, signal), options.signal);
            options.signal?.throwIfAborted();
            if (requestKey !== getAudioRequestKey(song)) throw new DOMException('Audio context changed', 'AbortError');
            const url = toSafePlaybackUrl(source?.url);
            if (url && ['http:', 'https:'].includes(new URL(url).protocol)
                && (source?.expiresAt === undefined || source.expiresAt > Date.now())) {
                return { ...source!, url, resolvedRoute: route, fallbackUsed: route !== 'native', failedRoutes };
            }
        } catch (error) {
            options.signal?.throwIfAborted();
            if (requestKey !== getAudioRequestKey(song)) throw error;
        }
        failedRoutes.push(route);
    }
    return null;
}
