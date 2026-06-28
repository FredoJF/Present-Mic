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

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), {
    body: [musicSetupCommand.toJSON(), musicStatusCommand.toJSON()]
  });

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
