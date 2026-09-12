import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadAudioSourceMock = vi.hoisted(() => vi.fn());

vi.mock('@/services/onlinePlayback', () => ({
    loadOnlineSongAudioSource: loadAudioSourceMock,
    getOnlineAudioRecoveryOptions: () => ({ excludeRoutes: ['native'] }),
    applyOnlineAudioSourceMetadata: (song: unknown) => song,
}));

import {
    createOnlineRecoveryController,
    getOnlineRecoveryKey,
} from '@/components/app/playback/createOnlineRecoveryController';
import { getPlaybackSongKey } from '@/utils/appPlaybackGuards';
import { setAudioSrc } from '@/stores/usePlaybackStore';
import type { SongResult } from '@/types';

// test/unit/playback/onlineRecoveryController.test.ts

const song: SongResult = {
    id: 'qq-song',
    name: 'Song',
    artists: [],
    album: { id: 'album', name: 'Album' },
    durationMs: 1000,
    qqMid: '004Th6td4LaoZs',
    sourceRef: { kind: 'online', providerId: 'qq', mediaId: '004Th6td4LaoZs' },
};

const ref = <T,>(value: T) => ({ current: value });

vi.mock('@/stores/usePlaybackStore', () => ({ setAudioSrc: vi.fn(), setCurrentSong: vi.fn(), setPlayQueue: vi.fn() }));

// QQ mints a fresh vkey/guid per request, so consecutive refreshes of one file differ only in query.
const streamUrl = (vkey: string) =>
    `http://isure.stream.qqmusic.qq.com/M800004Th6td4LaoZs004Th6td4LaoZs.mp3?guid=${vkey}&vkey=${vkey}&uin=1&fromtag=8`;

const createController = (audioSrc: string) => {
    const lastAudioRecoverySourceRef = ref<string | null>(null);
    const audioRef = ref<HTMLAudioElement | null>({ currentTime: 0, currentSrc: audioSrc } as HTMLAudioElement);
    const currentSongRef = ref<string | number | null>(getPlaybackSongKey(song));
    const pendingResumeTimeRef = ref<number | null>(null);

    const controller = createOnlineRecoveryController({
        audioQuality: 'high',
        currentSong: song,
        audioSrc,
        audioRef,
        currentSongRef,
        blobUrlRef: ref<string | null>(null),
        shouldAutoPlayRef: ref(false),
        pendingResumeTimeRef,
        onlinePlaybackRecoveryRef: ref<Promise<boolean> | null>(null),
        lastAudioRecoverySourceRef,
        currentOnlineAudioUrlFetchedAtRef: ref<number | null>(null),
        persistLastPlaybackCache: vi.fn(async () => undefined),
        playQueue: [song],
        onlineAudioUrlTtlMs: 60_000,
        onlineAudioUrlRefreshBufferMs: 5_000,
    });

    return { controller, lastAudioRecoverySourceRef, currentSongRef, audioRef, pendingResumeTimeRef };
};

describe('online playback recovery bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keys retries on the media path so a re-minted stream token cannot restart the loop', () => {
        expect(getOnlineRecoveryKey(streamUrl('one'))).toBe(getOnlineRecoveryKey(streamUrl('two')));
        expect(getOnlineRecoveryKey(streamUrl('one')))
            .toBe('http://isure.stream.qqmusic.qq.com/M800004Th6td4LaoZs004Th6td4LaoZs.mp3');
        expect(getOnlineRecoveryKey('blob:folia/abc')).toBe('blob:folia/abc');
        expect(getOnlineRecoveryKey(null)).toBeNull();
    });

    it('refuses a second recovery for the same media file after the refreshed URL also fails', async () => {
        const firstUrl = streamUrl('one');
        const { controller, audioRef } = createController(firstUrl);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: firstUrl, autoplay: true }))
            .resolves.toBe(true);
        // The refreshed URL fails too. Before this guard the differing vkey made it look brand new,
        // so the error -> refresh -> error cycle never reached skipAfterPlaybackFailure().
        Object.assign(audioRef.current!, { currentSrc: streamUrl('two') });
        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), autoplay: true }))
            .resolves.toBe(false);
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(1);
    });

    it('allows a refresh again once the source actually played', async () => {
        const firstUrl = streamUrl('one');
        const { controller, lastAudioRecoverySourceRef, audioRef, pendingResumeTimeRef } = createController(firstUrl);
        loadAudioSourceMock.mockResolvedValue({ kind: 'ok', audioSrc: streamUrl('two') });

        await controller.recoverOnlinePlaybackSource({ failedSrc: firstUrl, autoplay: true });
        // Stands in for the audio element's `playing` event clearing the guard.
        lastAudioRecoverySourceRef.current = null;
        Object.assign(audioRef.current!, { currentSrc: streamUrl('two') });

        await expect(controller.recoverOnlinePlaybackSource({ failedSrc: streamUrl('two'), resumeAt: 27, autoplay: true }))
            .resolves.toBe(true);
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(2);
        expect(pendingResumeTimeRef.current).toBe(27);
        expect(setAudioSrc).toHaveBeenCalledWith(streamUrl('two'));
    });

    it('coalesces duplicate errors and treats canceled recovery as handled without replacing or skipping the new song', async () => {
        const { controller, currentSongRef } = createController(streamUrl('one'));
        let reject!: (reason: unknown) => void;
        loadAudioSourceMock.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
        const first = controller.recoverOnlinePlaybackSource({ autoplay: true });
        const duplicate = controller.recoverOnlinePlaybackSource({ autoplay: true });
        currentSongRef.current = 'online:kugou:another';
        reject(new DOMException('Aborted', 'AbortError'));
        expect(await Promise.all([first, duplicate])).toEqual([true, true]);
        expect(loadAudioSourceMock).toHaveBeenCalledTimes(1);
        expect(setAudioSrc).not.toHaveBeenCalled();
    });
});
