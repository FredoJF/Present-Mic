import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { Client, GatewayIntentBits } from 'discord.js';

import { env } from '../config/env.js';
import type { GuildSettingsRepository } from '../database/repositories/guild-settings.repository.js';
import { musicSetupCommand } from './commands/music-setup.command.js';
import { musicStatusCommand } from './commands/music-status.command.js';
import { bindInteractionCreateEvent } from './events/interaction-create.event.js';
import { bindMessageCreateEvent } from './events/message-create.event.js';
import { bindReadyEvent } from './events/ready.event.js';
import type { MusicService } from '../music/music-service.js';
import type { MessageInputHandler } from '../player-channel/message-input-handler.js';
import type { PlayerMessageService } from '../player-channel/player-message-service.js';
import { logger } from '../utils/logger.js';

// Global command registration counts against a daily create limit and costs a
// blocking round trip before login. The definitions only change when this file
// does, so the payload is hashed and the upload skipped while it matches. A
// missing or unreadable hash always re-registers, so the failure mode is a
// redundant upload rather than stale commands.
const COMMAND_HASH_PATH = '.present-mic/commands.hash';

async function readRegisteredCommandHash(): Promise<string | null> {
  try {
    return (await readFile(COMMAND_HASH_PATH, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function storeRegisteredCommandHash(hash: string): Promise<void> {
  try {
    await mkdir(dirname(COMMAND_HASH_PATH), { recursive: true });
    await writeFile(COMMAND_HASH_PATH, hash, 'utf8');
  } catch (error) {
    // A failed write only means the next boot re-registers.
    logger.warn({ error }, 'Could not persist slash command hash');
  }
}

export async function registerCommands(): Promise<void> {
  const body = [musicSetupCommand.toJSON(), musicStatusCommand.toJSON()];
  const hash = createHash('sha256')
    .update(`${env.DISCORD_CLIENT_ID}:${JSON.stringify(body)}`)
    .digest('hex');

  if ((await readRegisteredCommandHash()) === hash) {
    logger.info('Slash commands already registered, skipping upload');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
  await storeRegisteredCommandHash(hash);

  logger.info('Slash commands registered');
}

export function buildDiscordClient(
  settingsRepository: GuildSettingsRepository,
  musicService: MusicService,
  inputHandler: MessageInputHandler,
  playerMessageService: PlayerMessageService
): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  bindReadyEvent(client, settingsRepository, musicService, playerMessageService);
  bindMessageCreateEvent(client, inputHandler);
  bindInteractionCreateEvent(client, settingsRepository, musicService, playerMessageService);

  return client;
}
