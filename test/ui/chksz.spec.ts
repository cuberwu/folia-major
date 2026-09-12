import { expect, test, type Page } from '@playwright/test';
import { installBaseState, mockNeteaseApi, openApp } from './helpers/appFixtures';

// test/ui/chksz.spec.ts
// Independent catalogs and real audio-element fallback share the existing browser fixtures.
test.use({ serviceWorkers: 'block' });
// A valid PCM file exercises the browser audio element, decoding, playback clock and seeking.
const wav = () => {
    const samples = 8000 * 30;
    const data = Buffer.alloc(44 + samples * 2);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
    data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
    data.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 4000) * 1000), 44 + i * 2);
    return data;
};


async function setup(page: Page, live = false) {
    await installBaseState(page);
    await page.addInitScript(() => {
        Reflect.deleteProperty(window, 'electron');
        localStorage.setItem('auto_use_best_lyric', 'false');
        localStorage.setItem('folia_enable_media_cache', 'false');
        localStorage.setItem('player_loop_mode', 'off');
    });
    await mockNeteaseApi(page, 'guest');
    const calls: string[] = [];
    await page.route('**/__mock_netease__/**', async route => {
        const incoming = new URL(route.request().url());
        const path = incoming.pathname.replace('/__mock_netease__', '');
        if (live && path === '/cloudsearch') {
            const response = await page.request.get(process.env.LINGLAN_LIVE_BACKEND + path + incoming.search);
            return route.fulfill({ response });
        }
        const replies: Record<string, unknown> = {
            '/cloudsearch': { code: 200, result: { songs: [{ id: 42, name: 'NetEase result', ar: [{ id: 1, name: 'Artist' }], al: { id: 1, name: 'Album' }, dt: 30000 }], songCount: 1 } },
            '/song/url/v1': { code: 200, data: [{ id: 42, url: null }] },
            '/lyric/new': { code: 200, lrc: { lyric: '[00:00.00]Test lyrics' } },
            '/register/anonimous': { code: 200, cookie: 'guest-cookie' },
        };
        if (!(path in replies)) return route.fallback();
        calls.push(path); await route.fulfill({ json: replies[path] });
    });
    if (!live) await page.route('**/api/lyric-proxy?**', async route => {
        const target = new URL(route.request().url()).searchParams.get('url') || '';
        if (target.includes('complexsearch.kugou.com')) return route.fulfill({ json: { error_code: 0, data: { total: 1, lists: [{ FileHash: '0123456789ABCDEF0123456789ABCDEF', SongName: 'KuGou result', SingerName: 'Artist', AlbumName: 'Album', Duration: 30 }] } } });
        if (target.includes('u.y.qq.com')) return route.fulfill({ json: { code: 0, request: { code: 0, data: { body: { item_song: [{ id: 42, mid: '004Th6td4LaoZs', title: 'QQ result', singer: [{ id: 1, name: 'Artist' }], album: { id: 1, name: 'Album' }, interval: 30 }] } } } } });
        return route.fallback();
    });
    await page.route('https://audio.folia.test/**', route => {
        const audio = wav();
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
        const start = Number(range?.[1] || 0), end = Math.min(Number(range?.[2] || audio.length - 1), audio.length - 1);
        return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: audio.subarray(start, end + 1),
            headers: { 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + audio.length } : {}) } });
    });
    await page.route('**/api/chksz/**', async route => {
        const path = new URL(route.request().url()).pathname;
        calls.push(path);
        await route.fulfill(path.endsWith('/status') ? { json: { configured: true } } : { status: 503, json: { error: 'unavailable' } });
    });
    await page.route('**/api/linglan/**', async route => {
        const incoming = new URL(route.request().url()); calls.push(incoming.pathname);
        if (live) {
            const response = await page.request.get(process.env.LINGLAN_LIVE_BACKEND + incoming.pathname + incoming.search);
            return route.fulfill({ response });
        }
        await route.fulfill({ json: incoming.pathname.endsWith('/status') ? { configured: true } : { code: 200, data: { url: 'https://audio.folia.test/track.wav' } } });
    });
    return calls;
}
async function search(page: Page, query = 'Test') {
    const input = page.getByPlaceholder('SEARCH DATABASE...'); await input.fill(query); await input.press('Enter');
}
const audioState = (page: Page) => page.locator('audio').evaluateAll(elements => (elements as HTMLAudioElement[]).map(el => ({ time: el.currentTime, duration: el.duration, paused: el.paused, url: el.currentSrc })));

for (const accountProvider of ['netease', 'qq']) {
    test(`guest QQ playback and restore preserve the ${accountProvider} account selection`, async ({ page }) => {
        await setup(page);
        await page.addInitScript(provider => {
            localStorage.setItem('active_online_provider_id', provider);
        }, accountProvider);
        await openApp(page);
        const switcher = page.getByTestId('online-provider-switcher');
        const radio = page.getByRole('button').filter({ hasText: /^Radio$/ });
        await expect(switcher.getByRole('img', { name: 'Guest Mode' })).toBeVisible();
        await expect(radio).toBeDisabled();
        await expect(radio).toHaveAttribute('aria-label', 'Please login to access your library');

        await search(page);
        await page.getByRole('button', { name: 'QQ音乐', exact: true }).click();
        await page.getByRole('button', { name: 'QQ result', exact: true }).click();
        await expect.poll(async () => (await audioState(page)).some(el => el.time > 0.2 && !el.paused)).toBe(true);
        const accountState = () => page.evaluate(async () => {
            const path = '/src/stores/useOnlineProviderAccountStore.ts';
            const state = (await import(path)).useOnlineProviderAccountStore.getState();
            return { provider: state.activeProviderId, users: Object.values(state.accounts).filter((account: any) => account.user).length };
        });
        expect(await accountState()).toEqual({ provider: accountProvider, users: 0 });
        await expect.poll(() => page.evaluate(async () => {
            const path = '/src/services/db.ts';
            return (await (await import(path)).getFromCache('last_song'))?.sourceRef?.providerId;
        })).toBe('qq');
        await page.reload();
        await expect.poll(() => page.evaluate(async () => {
            const path = '/src/stores/usePlaybackStore.ts';
            return (await import(path)).usePlaybackStore.getState().currentSong?.sourceRef?.providerId;
        })).toBe('qq');
        expect(await accountState()).toEqual({ provider: accountProvider, users: 0 });
        await expect(switcher.getByRole('img', { name: 'Guest Mode' })).toBeVisible();
        await expect(radio).toBeDisabled();
        await expect(radio).toHaveAttribute('aria-label', 'Please login to access your library');
    });
}

test('radio and album capabilities are checked after login and return to guest on logout', async ({ page }) => {
    await setup(page);
    await openApp(page);
    // Let startup account validation finish before simulating login state changes.
    await expect.poll(() => page.evaluate(async () => {
        const path = '/src/stores/useOnlineProviderAccountStore.ts';
        const accounts = (await import(path)).useOnlineProviderAccountStore.getState().accounts;
        return ['netease', 'qq'].every(provider => accounts[provider]?.hydration === 'ready');
    })).toBe(true);
    const switcher = page.getByTestId('online-provider-switcher');
    const radio = page.getByRole('button').filter({ hasText: /^Radio$/ });
    const albums = page.getByRole('button').filter({ hasText: /^Albums$/ });
    await expect(albums).toBeDisabled();
    await expect(albums).toHaveAttribute('aria-label', 'Please login to access your library');
    for (const provider of ['netease', 'qq']) {
        await page.evaluate(async providerId => {
            const path = '/src/stores/useOnlineProviderAccountStore.ts';
            const store = (await import(path)).useOnlineProviderAccountStore.getState();
            store.updateAccount(providerId, {
                status: 'authenticated', hydration: 'ready', freshness: 'fresh',
                user: { providerId, id: 'fixture-user', nickname: 'Fixture User', avatarUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' },
            });
            store.setActiveProviderId(providerId);
        }, provider);
        await expect(switcher.getByRole('img', { name: 'Fixture User' }).first()).toBeVisible();
        await expect(albums).toBeEnabled();
        if (provider === 'netease') await expect(radio).toBeEnabled();
        else {
            await expect(radio).toBeDisabled();
            await expect(radio).toHaveAttribute('aria-label', /does not provide recommendation content/);
        }
    }
    await page.evaluate(async () => {
        const path = '/src/stores/useOnlineProviderAccountStore.ts';
        (await import(path)).useOnlineProviderAccountStore.getState().clearAccount('qq');
    });
    await expect(switcher.getByRole('img', { name: 'Guest Mode' })).toBeVisible();
    await expect(radio).toHaveAttribute('aria-label', 'Please login to access your library');
    await expect(albums).toBeDisabled();
    await expect(albums).toHaveAttribute('aria-label', 'Please login to access your library');
    await page.screenshot({ path: 'test-results/guest-account-radio.png', animations: 'disabled' });
});

test('guest aggregate search exposes each catalog and plays directly through ChKSz, Linglan', async ({ page }) => {
    const calls = await setup(page); await openApp(page); await search(page);
    await expect(page.getByRole('button', { name: 'All platforms', exact: true })).toHaveAttribute('aria-pressed', 'true');
    for (const name of ['NetEase result', 'KuGou result', 'QQ result']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add to Queue', exact: true }).first().click();
    const queueBefore = await page.evaluate(async () => { const path = '/src/stores/usePlaybackStore.ts'; return (await import(path)).usePlaybackStore.getState().playQueue; });
    await page.getByRole('button', { name: '酷狗', exact: true }).click();
    await expect(page.getByRole('button', { name: 'KuGou result', exact: true })).toBeVisible();
    expect(await page.evaluate(async () => { const path = '/src/stores/useOnlineProviderAccountStore.ts'; return (await import(path)).useOnlineProviderAccountStore.getState().activeProviderId; })).toBe('netease');
    expect(await page.evaluate(() => localStorage.getItem('folia_online_search_source'))).toBe('kugou');
    expect(await page.evaluate(async () => { const path = '/src/stores/usePlaybackStore.ts'; return (await import(path)).usePlaybackStore.getState().playQueue; })).toEqual(queueBefore);
    await page.getByRole('button', { name: '网易云', exact: true }).click();
    await page.getByRole('button', { name: 'NetEase result', exact: true }).click();
    await expect.poll(async () => (await audioState(page)).some(el => el.time > 0.2 && !el.paused)).toBe(true);
    expect(calls).not.toContain('/song/url/v1'); expect(calls).toContain('/api/chksz/audio'); expect(calls).toContain('/api/linglan/audio');
    expect(calls).not.toContain('/api/chksz/search');
    await page.locator('audio').evaluateAll(elements => { for (const audio of elements as HTMLAudioElement[]) if (!audio.paused) audio.currentTime = 12; });
    await expect.poll(async () => (await audioState(page)).some(el => el.time > 12)).toBe(true);
});

test('partial search failure has a platform retry and keeps successful results on mobile', async ({ page }) => {
    await setup(page); await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/lyric-proxy?**', async route => {
        if (new URL(route.request().url()).searchParams.get('url')?.includes('u.y.qq.com')) return route.fulfill({ status: 503, body: 'offline' });
        return route.fallback();
    });
    await openApp(page); await search(page);
    await expect(page.getByRole('button', { name: 'NetEase result', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /QQ.*search failed/ })).toBeVisible();
    await expect(page.locator('section').filter({ has: page.getByRole('button', { name: 'All platforms', exact: true }) })).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'test-results/aggregate-mobile.png', animations: 'disabled' });
});

test('a media loading error excludes the failed supplier and continues playback', async ({ page }) => {
    const calls = await setup(page);
    let chkszAudioCalls = 0;
    await page.route('**/api/chksz/audio?**', route => {
        chkszAudioCalls++;
        return route.fulfill({ json: { code: 200, data: { url: 'https://audio.folia.test/broken.mp3' } } });
    });
    await page.route('https://audio.folia.test/broken.mp3', route => route.fulfill({ status: 404, body: '' }));
    await openApp(page); await search(page);
    await page.getByRole('button', { name: '网易云', exact: true }).click();
    await page.getByRole('button', { name: 'NetEase result', exact: true }).click();
    await expect.poll(async () => (await audioState(page)).some(el => el.time > 0.2 && !el.paused && el.url.endsWith('track.wav')), { timeout: 20000 }).toBe(true);
    expect(chkszAudioCalls).toBe(1);
    expect(calls.filter(path => path === '/api/linglan/audio')).toHaveLength(1);
});

for (const [provider, label] of [['netease', '网易云'], ['kugou', '酷狗'], ['qq', 'QQ音乐']]) {
    test('live catalog ' + provider + ' resolves to HTTPS audio that plays and seeks', async ({ page }) => {
        test.skip(!process.env.LINGLAN_LIVE_BACKEND, 'Requires the local credential-backed verification server');
        test.setTimeout(90000);
        await setup(page, true); await openApp(page); await search(page, '周杰伦 稻香');
        await page.getByRole('button', { name: label, exact: true }).click({ timeout: 20000 });
        await expect(page.getByRole('button', { name: 'Play track', exact: true }).first()).toBeVisible({ timeout: 30000 });
        await page.getByRole('button', { name: 'Play track', exact: true }).first().click();
        await expect.poll(async () => (await audioState(page)).some(el => el.time > 0.2 && !el.paused), { timeout: 45000 }).toBe(true);
        console.log('Live media origin: ' + JSON.stringify((await audioState(page)).filter(el => !el.paused && el.url).map(el => new URL(el.url).origin)));
        await expect.poll(async () => (await audioState(page)).some(el => el.time > 0.2 && el.duration > 10 && !el.paused && el.url.startsWith('https:') && !el.url.includes('audio.folia.test')), { timeout: 45000 }).toBe(true);
        await page.locator('audio').evaluateAll(elements => { for (const audio of elements as HTMLAudioElement[]) if (!audio.paused) audio.currentTime = 10; });
        await expect.poll(async () => (await audioState(page)).some(el => el.time > 10 && !el.paused)).toBe(true);
        console.log('Live playback and seek passed: ' + provider);
    });
}
