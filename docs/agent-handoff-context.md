# Present-Mic V1 Agent Handoff Context

## Project intent

Build a private, free Discord music bot where the configured text channel is the main player interface.

## Current implementation status

### Foundation complete

- Node + TypeScript strict project initialized.
- ESLint + Prettier configured.
- Prisma schema with `GuildSettings` model created.
- Docker Compose with bot + Lavalink services created.

### Discord layer complete

- Gateway intents include Guilds, GuildMessages, MessageContent, GuildVoiceStates.
- Commands registered globally:
  - `/music` with setup/status/reset/dj-role/cleanup subcommands
  - `/music-status`
- Event handlers implemented for ready, message input, and button interactions.

### Music/player domain complete (v1 level)

- In-memory per-guild state management.
- Queue logic: add/pop next/pop previous/shuffle/clear/remove.
- Player controls mapped to button IDs.
- Persistent player embed update flow implemented.

### Persistence complete

- Guild settings repository supports get/getOrCreate/upsert.
- Stores player channel ID, player message ID, DJ role ID, cleanup toggle.

## Important constraints from spec

- Normal music use should be text-channel-first, slash commands mainly admin/setup.
- Private and fully free, no monetization systems.
- Restart behavior: player UI returns to idle; no resume of old queue/track.

## Known gaps and next priorities

1. Replace placeholder YouTube resolver with real Lavalink-backed resolution.
2. Attach voice and handle real audio events/end-of-track transitions.
3. Add unit tests for queue and permission logic.
4. Add queue pagination and optional select menu UX.
5. Add graceful recreate flow when stored player message is deleted externally.

## Key files for fast reimport

- Entry point: `src/main.ts`
- Discord wiring: `src/discord/client.ts`
- Message input: `src/player-channel/message-input-handler.ts`
- Player message rendering: `src/player-channel/player-message-builder.ts`
- Queue/music orchestration: `src/music/music-service.ts`
- Persistence: `src/database/repositories/guild-settings.repository.ts`
- Project docs: `README.md`

## Reimport prompt suggestion

Use this message with another agent:

"Continue Present-Mic v1 from docs/agent-handoff-context.md and README.md. Prioritize replacing placeholder Lavalink behavior with real playback + track resolution while keeping current architecture and TypeScript strict mode."
