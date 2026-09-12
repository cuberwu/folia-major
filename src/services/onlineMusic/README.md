# Omni 在线音乐层

`src/services/onlineMusic/omni.ts` 是普通在线歌曲数据的唯一公开入口。组件、hook、store 和普通 app service 不得直接调用具体 provider、registry、transport 或 raw API；只有明确的跨 provider 编排，或 provider adapter/transport 自身，才可以使用 provider-explicit 层。

## Layer map

```text
UI / hooks / stores / app services
  -> omni.ts
       -> providerRegistry.ts
            -> neteaseProvider.ts
            -> kugouProvider.ts
                 -> kugouTransport.ts（酷狗请求/IPC 边界）
            -> qqProvider.ts
                 -> qqTransport.ts（QQ 音乐请求边界）
       -> providerAccountCache.ts / providerStorage.ts
  -> src/types/onlineMusic.ts（共享合同）
```

当前 registry 注册 `netease`、`kugou` 和 `qq`。Navidrome 是独立的 Subsonic 服务，入口是 `src/services/navidromeService.ts`，不属于 Omni provider。

## Public contract

调用前先看 `omni.ts` 的方法和 `src/types/onlineMusic.ts` 的类型。常用入口按能力分组：

| 能力 | Omni 方法/区域 | 结果/边界 |
| --- | --- | --- |
| provider 状态 | `getProviderSummaries`、`getActiveProviderSummary`、`getProviderCapabilities`、`getProviderAvailability` | `useOnlineProviderAccountStore` 提供 active provider 与账号快照 |
| 账号/二维码 | `getLoginStatus`、`logout`、`createQrLogin`、`checkQrLogin` | provider auth adapter；不要在 UI 直接保留 raw session |
| 搜索 | `searchSourceSongs`、`searchSongs`、`searchProviderSongs` | 搜索工作区用 source-aware 入口；普通匹配按 active provider；显式 provider 或跨 provider 用最后一个方法 |
| 用户库 | `getUserPlaylists`、`getProviderUserPlaylists`、`getUserAlbums`、`getLikedSongIds`、`getCloudCollection` | 统一 `OmniCollection` / page 类型，账号快照可先展示再静默刷新 |
| 推荐 | `getHomeFeed`、`getPersonalFm`、`getDailySongs`、`getRecommendationHistory*`、`dislikeSong` | 首页推荐与历史推荐仍由 Omni 路由 |
| 播放/歌词 | `getSongDetail`、`canPlaySong`、`getAudioSource`、`getLyrics`、`getChorusRanges` | 输出 `OmniAudioSource` / `OmniLyricsResult`；Navidrome 歌词走独立 service |
| 听歌上报 | `canReportPlayback`、`reportPlayback` | 只有声明 `playbackReports` 的 provider 支持（当前仅网易云）；时长必须是真实累计播放秒数，频控在 `playbackReportGate.ts` |
| 可用性 | `getSongAvailability`、`getSongReplacement` | 保留 unsupported / unavailable / auth 等 `OmniError` 语义 |
| 集合详情 | `getCollectionTracks`、`getCollectionDetail`、`getAlbumDetail`、`getArtistDetail`、`getArtistSongs`、`getArtistAlbums` | 按 collection 的 `providerId` 路由 |
| 修改 | `likeSong`、`toggleSongLike`、`getSubscriptionStatus`、`subscribe`、`updateCollectionTracks` | mutation 按歌曲/集合所属 provider 执行并更新 account cache |
| 外链与引用 | `canResolveCatalogRef`、`resolveCatalogRefs`、`getSongPageUrl` | 共享 `catalogRefs.ts` 的 provider-aware 引用 |

共享类型包括 `UnifiedSong`、`OmniCollection`、`OmniPage`、`OmniLyricsResult`、`OmniAudioSource`、`OmniUser`、`OmniError`、`OmniProviderCapabilities`。调用方不能依赖 provider 的 raw field、numeric id 单独比较或 raw response envelope。

## Provider and cache files

- `providerRegistry.ts`：注册、查找、按歌曲 `sourceRef` 选择 provider、能力检查。
- `neteaseProvider.ts`：网易云 adapter，归一化到 Omni contract。
- `kugouProvider.ts`：酷狗 adapter；请求细节在 `kugouTransport.ts`，具体接口需结合 `docs/ku-go-api-docs.md` 和 `skills/kugou-provider-alignment`。
- `qqProvider.ts`：QQ 音乐 adapter；请求与 opaque session 细节在 `qqTransport.ts`，归一化在 `qqNormalize.ts`。集合身份一律用 mid，数字 `albumid` / `singer.id` 会被上游拒收（返回 HTTP 200 但 `code` 非 0，只表现成空白页）。账号和原平台播放由 `VITE_QQ_API_BASE` 指向的私有 QQ API 提供；未配置时这些能力不可用，匿名搜索与歌词仍可通过歌词代理使用；填相对路径（`/api/qq`）时走的是本仓库内置的 serverless 入口（`worker/qq.ts` / `api-ts/qq.ts`）。扫码通道由后端 `/login/channels` 声明；打开登录时 UI 会等待能力发现并使用同一份结果决定流程，只宣告一个通道时直接进入单步流程。旧后端没有这条路由时回落到硬编码的 `qq` / `wechat` 两条，暂时性探测失败允许后续重试。
- `providerAccountCache.ts`：按 provider 保存用户、集合、点赞 ID、hydration/freshness 快照；刷新失败保留旧快照。
- `providerStorage.ts`：renderer 的 provider session/account 持久化边界。QQ 这里只保存 opaque `qqmusic_session`；真实 credential 始终由 QQ API 后端持有。Electron 通过主进程的 `safeStorage` 加密仓库跨重启恢复，独立 Node / Docker 后端可用 `QQ_AUTH_SESSION_PATH` 与 `QQ_SESSION_SECRET` 启用加密文件仓库；serverless 形态下 credential 加密在 token 里，服务端不存。送出方式按部署形态分岔：同源 base 用 `X-QQ-Session` header 送裸 token，外部 URL 与 Electron 维持 `?cookie=` 送整串 cookie，两者语义不同不可互换。酷狗 Web transport 仍在这里保存远端 API 请求所需的 session；Electron transport 只保留非敏感 `userid` 提示，`token`、cookie 与 `dfid` 由主进程加密持有，不得复制到 renderer。
- `resourceCache.ts` / `resourceKeys.ts`：在线资源缓存键和缓存层。当前 kind：`audio`、`lyric`、`cover`、`theme`、`replayGain`。**新增 kind 必须同时在 `src/services/repositories/cacheRepository.ts` 的 `getCacheTableName` 与 `matchesCategory` 里登记前缀**，否则条目会静默落进 `api_cache` 兜底表、不属于任何一个「清除缓存」分类，变成清不掉的孤儿；若该 kind 是按歌曲存一份，还要确认它没有被计进 `mediaCount`（那个数字的语义是「已缓存歌曲数」，会翻倍）。
- `playbackReportGate.ts`：听歌上报的频控与可用性判断。上报写的是用户真实账号，突发的不可能记录会触发风控，所以这里限制最小间隔与每小时上限、串行发送，并给设置面板和命令面板提供同一个 `isNeteaseScrobbleReady()`。真实播放秒数的计量在 `src/utils/playbackListenTracker.ts`，接线在 `src/hooks/useNeteaseScrobbleReporter.ts`。
- `songMetadata.ts` / `songAvailability.ts`：歌曲元数据、可播放性和替代歌曲相关共享逻辑。
- `catalogRefs.ts`：歌曲、歌单、专辑、歌手的 provider-aware catalog 引用。

`omni.ts` 的 active-provider 调用带 request generation 检查：`withActiveProvider` 会丢弃 provider 切换后返回的旧响应，切换事务需要 `invalidateActiveRequests()`。不要在调用方重新实现一套取消/晚到响应防护。

## Routing rules

### Independent catalog search and Docker Web audio fallback

搜索工作区固定提供聚合、网易云、酷狗、QQ、本地和 Navidrome，在线搜索选择独立保存，首次默认聚合。账号切换不改变搜索选择。

`searchSourceSongs()` 通过现有 provider 搜索；聚合每批每平台 10 条，按网易云、酷狗、QQ 交错排列，保留平台身份。`OnlineSearchRouting.providers` 保存各平台 offset、hasMore 和失败状态；失败平台单独重试，不推进其他平台。ChKSz 和聆澜不参与搜索。

`initializeSharedSources()` 探测同源 `/api/chksz/status` 与 `/api/linglan/status`；Electron 不启用这些 Web 后端。`playbackRouting.ts` 统一音频回退：网易云公开歌曲已登录时依次尝试原平台账号、ChKSz、聆澜；未登录时直接尝试 ChKSz、聆澜，避免匿名试听链接。酷狗和 QQ 跳过 ChKSz。私人云盘仅走原平台。

`getAudioSource()` 支持取消信号和失败来源排除；每个来源最多等待 15 秒。`resolvedRoute`、`failedRoutes` 和 `fallbackUsed` 描述实际音频解析结果，不改变歌曲的 provider/mediaId 身份。旧队列中的 `playbackRoute` 只为读取兼容，不再强制路由。歌词与账号操作仍归原 provider。

预取 URL 校验来源配置、账号／会话版本、音质与有效期；完整音频缓存仍按原歌曲身份复用。音频加载失败时使旧 URL 失效，继续尝试尚未失败的来源并恢复进度。

### Ordinary single-provider flow

```ts
import { omni } from '@/services/onlineMusic/omni';

const page = await omni.searchSongs(query, { limit: 30, offset: 0 });
const song = page.items[0];
if (song) {
    const lyrics = await omni.getLyrics(song);
    const audio = await omni.getAudioSource(song, 'high');
}
```

歌曲已经带有 provider identity 时，使用 song-aware 方法：

```ts
await omni.toggleSongLike(song);
await omni.getCollectionTracks(collection, { limit: 50, offset: 0 });
```

### Explicit cross-provider flow

歌词匹配、本地元数据匹配、联邦搜索、fallback、比较和迁移才是跨 provider。使用 `searchProviderSongs(providerId, ...)` 等显式方法，并保留每条结果的 `sourceRef.providerId`。不要为了“当前有两个 provider”就直接并发调用 raw adapter。

### Identity

在线歌曲身份是 `(sourceRef.kind='online', sourceRef.providerId, sourceRef.mediaId)`，不是 `song.id` 单值。比较、去重、替代、入队前优先使用：

- `src/utils/appPlaybackGuards.ts`：`getPlaybackSourceRef`、`getPlaybackSongKey`、`isSamePlaybackSong`
- `src/utils/appPlaybackHelpers.ts`：播放结构和来源相关派生

跨 provider 的 numeric id 不可直接去重；`online:netease:123` 与 `online:kugou:123` 默认是两个播放身份。

## Fast lookup

```powershell
rg -n "export const omni|searchSongs|getLyrics|getAudioSource|updateCollectionTracks" src/services/onlineMusic/omni.ts
rg -n "OnlineMusicProvider|OmniProvider|UnifiedSong|OmniLyricsResult|OmniAudioSource" src/types/onlineMusic.ts
rg -n "registerOnlineMusicProvider|neteaseProvider|kugouProvider|qqProvider|providerSupports" src/services/onlineMusic/providerRegistry.ts
```

先确认 Omni 是否已有能力；没有时扩展 `types/onlineMusic.ts`、`omni.ts` 和适用 adapter，不要新增第二条公开 bypass。
