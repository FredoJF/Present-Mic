# Present-Mic Discord Music Bot (V1)

Private and free Discord music bot with text-channel-first UX.

## What is implemented in V1

- TypeScript strict-mode bot architecture
- SQLite + Prisma guild settings persistence
- Admin setup slash command flow
- Persistent player message with control buttons
- Message-based input in configured player channel
- Queue management in memory (add, next, previous, stop, shuffle, clear)
- Idle reset behavior for player state after restart
- Docker Compose with Lavalink service

## Requirements

- Node.js 22 LTS (recommended)
- Discord bot token and app client ID
- Spotify developer client ID and secret for Spotify URLs/playlists
- Deezer `arl` cookie and decryption key for direct Deezer playback
- A YouTube `poToken` and `visitorData` pair for YouTube playback
- Message Content intent enabled in Discord developer portal

## Setup

1. Copy `.env.example` to `.env` and fill values.
2. Generate Prisma client:

```bash
npm run prisma:generate
```

3. Create database schema migration:

```bash
npx prisma migrate dev --name init
```

4. Start in development:

```bash
npm run dev
```

## Production startup checklist

If you deploy manually (outside Docker Compose), apply migrations before launching the bot:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
npm run start
```

If you skip `prisma:migrate:deploy`, Prisma will throw `P2021` (`GuildSettings` table missing).

## Player channel hygiene

The player channel is meant to contain exactly one message: the player. Four mechanisms keep it that
way, in order of how quickly they act.

1. Input messages are deleted as soon as they are processed.
2. Slow requests post a progress notice ("Loading playlist…", "Searching for …") after 1.5 seconds,
   removed as soon as resolution finishes. Anything that resolves faster than that posts nothing, so a
   plain YouTube link stays silent. The delay exists because a large Spotify playlist can take ten
   seconds or more to load.
3. Feedback about a failed request (for example `I couldn't queue that input: ...`) is posted as a
   self-deleting notice that removes itself after 12 seconds, rather than as a reply that would outlive
   the message it pointed at.
4. A sweep every 5 minutes removes anything still left in the channel except the player message. This
   is the backstop for notices whose delete timer was lost to a restart, messages posted while the bot
   was offline, and failed deletions.

The sweep needs the **Manage Messages** permission to remove other users' messages, and uses Discord's
bulk delete endpoint. Discord will not bulk delete messages older than 14 days, so those are removed
one at a time.

## Admin commands

- `/music setup channel:#music`
- `/music reset-player`
- `/music set-dj-role role:@DJ`
- `/music unset-dj-role`
- `/music cleanup enabled:true`
- `/music status`
- `/music-status`

## User workflow

1. Users post a YouTube URL, Spotify (`open.spotify.com`) URL, Deezer (`deezer.com` or `deezer.page.link`) URL, or search text in the configured player channel. Spotify and Deezer tracks, albums, artists, and playlists are supported.
2. Bot verifies voice channel presence.
3. Bot queues result and updates the persistent player message.
4. Users control playback via buttons in player message.

## Notes

- YouTube is the primary playback source, for both search text and for mirroring Spotify/Deezer URLs.
- Spotify URLs are resolved by the LavaSrc Lavalink plugin and mirrored to YouTube first, then Deezer. Spotify audio is not streamed directly.
- Add `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` to `.env` before starting Docker Compose. These are required for normal Spotify tracks, albums, and playlists. `SPOTIFY_SP_DC` is only used for lyrics.

Spotify **playlists** need more than the client ID and secret. Spotify answers
`GET /v1/playlists/{id}/items` with `401 Valid user authentication required` when the caller presents an
app-only client-credentials token, while `/v1/tracks/{id}` still accepts it — so single Spotify tracks
resolve fine and every playlist fails. Two things are therefore required:

- **LavaSrc 4.8.3 or newer.** Spotify retired the playlist `/tracks` endpoint for apps registered after
  the change; older LavaSrc still calls it.
- **An anonymous token source.** `docker-compose.yml` runs `spotify-tokener`, and LavaSrc is pointed at
  it via `customTokenEndpoint` with `preferPartnerApi: true`, which routes playlist loads through
  Spotify's partner API. If LavaSrc logs `Partner API failed for playlist {}, falling back to Spotify v1
API`, the token service is unreachable or returning nothing usable — check the `spotify-tokener`
  container first. Deezer playback requires both `DEEZER_ARL` and `DEEZER_MASTER_DECRYPTION_KEY`.

## Keeping YouTube playback working

YouTube actively breaks unauthenticated playback, so this needs occasional maintenance. The remedy is
almost always a plugin update, not extra credentials.

`lavalink/application.yml` pins `youtube-plugin` to a **snapshot commit build** rather than a release.
Upstream publishes an artifact per commit, so a working build normally exists well before the next
tagged release — release 1.18.2 could not parse YouTube's current player script, and commit
`f45bbb7` (2026-08-19) fixed it.

When playback starts failing again, bump the pinned commit first:

```bash
curl -s https://maven.lavalink.dev/snapshots/dev/lavalink/youtube/youtube-plugin/maven-metadata.xml
```

Search the full output — the versions are commit SHAs in no useful order, and `<lastUpdated>` lags
behind the newest artifact, so do not tail the list or trust that field. Confirm a candidate's date
against the upstream `lavalink-devs/youtube-source` commit, set it as the `dependency` version, delete
the old jar from `lavalink/plugins/`, and restart.

Symptoms that mean "the pinned build is stale", all of which resolve with a newer commit:

- `Must find sig function from script: /s/player/<id>/base.js` — the plugin cannot parse the player
  script. This one is total: `resolveFormatUrl` needs that script for both the `s` and `n` parameter
  transforms, so no client can produce a playable URL.
- `No supported audio streams available` — YouTube returned SABR-only formats, whose entries carry a
  `serverAbrStreamingUrl` but no `url` and no `signatureCipher`.
- `This video requires login` / `Sign in to confirm you're not a bot`.
- HTTP 400 from the `ANDROID` or `IOS` clients.

Only if a current snapshot build still fails are `plugins.youtube.pot` (poToken plus visitorData),
`plugins.youtube.remoteCipher`, or `plugins.youtube.oauth` worth configuring. Reach for them last;
they add credentials to rotate or a service to host.

Snapshot pinning has one cost worth tracking: snapshot artifacts carry no release notes and can be
pruned. Watch for a tagged release newer than the pinned commit and move back to a released
coordinate when one ships.

Lavalink loads every `.jar` in `lavalink/plugins/`, so delete old plugin jars after bumping a version
in `application.yml` — leaving two versions of the same plugin puts duplicate classes on the
classpath.
