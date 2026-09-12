import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/chkszTransport.ts

let statusRequest: Promise<boolean> | undefined;

export const discoverChksz = (): Promise<boolean> => {
    if (typeof window === 'undefined' || window.electron) return Promise.resolve(false);
    statusRequest ??= fetch('/api/chksz/status', {
        credentials: 'omit', signal: AbortSignal.timeout(5000), cache: 'no-store',
    }).then(async response => response.ok && (await response.json())?.configured === true)
        .catch(() => false).finally(() => { statusRequest = undefined; });
    return statusRequest;
};

export const requestChksz = async (operation: 'audio', params: Record<string, string | number>, signal?: AbortSignal): Promise<unknown> => {
    try {
        const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
        const response = await fetch(`/api/chksz/${operation}?${query}`, {
            credentials: 'omit', signal: signal ?? AbortSignal.timeout(15000),
        });
        if (!response.ok) {
            // This is the site's upstream credential, never the listener's NetEase login.
            throw new OnlineProviderError('unavailable', `ChKSz request failed (${response.status})`, 'netease');
        }
        const body = await response.json();
        if (body?.code !== 200) throw new OnlineProviderError('unavailable', 'Invalid ChKSz response', 'netease');
        return body.data;
    } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof OnlineProviderError) throw error;
        throw new OnlineProviderError('unavailable', 'ChKSz is temporarily unavailable', 'netease');
    }
};
