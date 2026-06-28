import { env } from './config/env.js';
import { GuildSettingsRepository } from './database/repositories/guild-settings.repository.js';
import { prisma } from './database/prisma.js';
import { buildDiscordClient, registerCommands } from './discord/client.js';
import { LavalinkService } from './music/lavalink/lavalink-client.js';
import { MusicService } from './music/music-service.js';
import { LavalinkSourceProvider } from './music/providers/lavalink-provider.js';
import { MessageInputHandler } from './player-channel/message-input-handler.js';
import { PlayerMessageService } from './player-channel/player-message-service.js';
import { logger } from './utils/logger.js';

async function bootstrap(): Promise<void> {
  const settingsRepository = new GuildSettingsRepository();
  const lavalinkService = new LavalinkService();
  const sourceProvider = new LavalinkSourceProvider(lavalinkService);
  const musicService = new MusicService(sourceProvider, lavalinkService);
  const playerMessageService = new PlayerMessageService();
  const messageInputHandler = new MessageInputHandler(settingsRepository, musicService);

  const client = buildDiscordClient(
    settingsRepository,
    musicService,
    messageInputHandler,
    playerMessageService
  );

  musicService.onStateChange(async (guildId, state) => {
    const settings = await settingsRepository.get(guildId);
    if (!settings?.playerChannelId || !settings.playerMessageId) {
      return;
    }

    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      return;
    }

    const channel = await guild.channels.fetch(settings.playerChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
      return;
    }

    await playerMessageService
      .updateOrRecreate(channel, settings.playerMessageId, state)
      .then(async (newMessageId) => {
        if (newMessageId !== settings.playerMessageId) {
          await settingsRepository.upsert(guildId, { playerMessageId: newMessageId });
          logger.info({ guildId, newMessageId }, 'Recreated missing player message during async state update');
        }
      })
      .catch((error) => {
        logger.warn({ error, guildId }, 'Failed to auto-update persistent player message');
      });
  });

  await lavalinkService.connect(client);
  await registerCommands();

  await client.login(env.DISCORD_TOKEN);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    await prisma.$disconnect();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap().catch((error) => {
  logger.error({ error }, 'Startup failed');
  process.exit(1);
});
