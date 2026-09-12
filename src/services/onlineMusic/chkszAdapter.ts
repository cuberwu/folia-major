import type { SongResult } from '../../types';
import type { AudioQualityPreference, ProviderAudioSource } from '../../types/onlineMusic';
import { toSafePlaybackUrl } from '../../utils/appPlaybackHelpers';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { requestChksz } from './chkszTransport';

// src/services/onlineMusic/chkszAdapter.ts

export const chkszAdapter = {
    async getAudioSource(song: SongResult, quality: AudioQualityPreference, signal?: AbortSignal): Promise<ProviderAudioSource | null> {
        const raw = await requestChksz('audio', { id: getPlaybackSourceRef(song).mediaId, quality }, signal);
        const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const url = typeof data.url === 'string' ? toSafePlaybackUrl(data.url.replace(/^http:/, 'https:')) : null;
        if (!url) return null;
        const levels: Record<string, AudioQualityPreference> = { standard: 'standard', exhigh: 'high', lossless: 'lossless', hires: 'hires' };
        return { url, fetchedAt: Date.now(), quality: levels[String(data.level)] ?? quality };
    },
};
