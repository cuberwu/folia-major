import type { OnlineProviderId } from '../../types/onlineMusic';
import { getFromCache, saveToCache } from '../db';

// src/services/onlineMusic/providerStorage.ts

const sessionRevisions = new Map<OnlineProviderId, number>();
export const getProviderSessionRevision = (providerId: OnlineProviderId): number => sessionRevisions.get(providerId) ?? 0;
const reviseSession = (providerId: OnlineProviderId, key: string) => {
    // Creating the anonymous NetEase cookie is part of the first request, not an account change.
    if (key !== 'anonymous_cookie') sessionRevisions.set(providerId, getProviderSessionRevision(providerId) + 1);
};

export const getProviderCacheKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider_${providerId}_${key}`
);

export const getProviderSessionKey = (providerId: OnlineProviderId, key: string): string => (
    `online_provider:${providerId}:${key}`
);

// Reads an old unscoped cache once, then stores the value in the provider namespace.
export const getProviderCacheWithLegacyMigration = async <T>(
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): Promise<T | null> => {
    const namespacedKey = getProviderCacheKey(providerId, key);
    const current = await getFromCache<T>(namespacedKey);
    if (current != null) return current;

    for (const legacyKey of legacyKeys) {
        const legacy = await getFromCache<T>(legacyKey);
        if (legacy == null) continue;
        await saveToCache(namespacedKey, legacy);
        return legacy;
    }
    return null;
};

export const readProviderSessionValue = (
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): string | null => {
    if (typeof localStorage === 'undefined') return null;
    const namespacedKey = getProviderSessionKey(providerId, key);
    const current = localStorage.getItem(namespacedKey);
    if (current != null) return current;

    for (const legacyKey of legacyKeys) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy == null) continue;
        localStorage.setItem(namespacedKey, legacy);
        return legacy;
    }
    return null;
};

export const writeProviderSessionValue = (providerId: OnlineProviderId, key: string, value: string): void => {
    if (typeof localStorage !== 'undefined') {
        if (localStorage.getItem(getProviderSessionKey(providerId, key)) !== value) reviseSession(providerId, key);
        localStorage.setItem(getProviderSessionKey(providerId, key), value);
    }
};

export const removeProviderSessionValue = (
    providerId: OnlineProviderId,
    key: string,
    legacyKeys: string[] = [],
): void => {
    if (typeof localStorage === 'undefined') return;
    if (readProviderSessionValue(providerId, key, legacyKeys) !== null) reviseSession(providerId, key);
    localStorage.removeItem(getProviderSessionKey(providerId, key));
    legacyKeys.forEach(legacyKey => localStorage.removeItem(legacyKey));
};
