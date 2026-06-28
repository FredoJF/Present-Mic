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

- Node.js 22+
- Discord bot token and app client ID
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

## Admin commands

- `/music setup channel:#music`
- `/music reset-player`
- `/music set-dj-role role:@DJ`
- `/music unset-dj-role`
- `/music cleanup enabled:true`
- `/music status`
- `/music-status`

## User workflow

1. Users post a YouTube video URL, playlist URL, or search text in configured player channel.
2. Bot verifies voice channel presence.
3. Bot queues result and updates the persistent player message.
4. Users control playback via buttons in player message.

## Notes

- The current V1 contains a Lavalink service wrapper placeholder, logging play/pause/stop operations.
- Integrating full Lavalink playback events and track resolution is the primary next increment.
