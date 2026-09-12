import type { SongResult } from '../../types';
import type { AudioQualityPreference, ProviderAudioSource } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { toSafePlaybackUrl } from '../../utils/appPlaybackHelpers';

// src/services/onlineMusic/linglanAdapter.ts

export async function discoverLinglan(): Promise<boolean> {
    if (typeof window === 'undefined' || window.electron) return false;
    return fetch('/api/linglan/status', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) })
        .then(async response => response.ok && (await response.json())?.configured === true).catch(() => false);
}

export async function getLinglanAudio(song: SongResult, quality: AudioQualityPreference, signal?: AbortSignal): Promise<ProviderAudioSource | null> {
    const ref = getPlaybackSourceRef(song);
    if (ref.kind !== 'online' || !['netease', 'kugou', 'qq'].includes(ref.providerId)) return null;
    // QQ's numeric catalog ID is not a songmid; never substitute it for a missing mid.
    const id = ref.providerId === 'qq' ? String(ref.providerData?.songMid || song.qqMid || ref.mediaId)
        : ref.providerId === 'kugou' ? String(ref.providerData?.hash || ref.mediaId).toUpperCase() : ref.mediaId;
    if (!id || ref.providerId === 'qq' && !/[a-z]/i.test(id)) return null;
    const query = new URLSearchParams({ provider: ref.providerId, id, quality });
    const response = await fetch(`/api/linglan/audio?${query}`, { credentials: 'omit', signal });
    if (!response.ok) throw new OnlineProviderError('unavailable', `Linglan request failed (${response.status})`, ref.providerId);
    const body = await response.json();
    const url = typeof body?.data?.url === 'string' ? toSafePlaybackUrl(body.data.url.replace(/^http:/i, 'https:')) : null;
    if (body?.code !== 200 || !url) return null;
    return { url, fetchedAt: Date.now(), quality };
}
