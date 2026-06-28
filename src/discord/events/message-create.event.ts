import type { Client } from 'discord.js';

import type { MessageInputHandler } from '../../player-channel/message-input-handler.js';
import { logger } from '../../utils/logger.js';

export function bindMessageCreateEvent(client: Client, inputHandler: MessageInputHandler): void {
  client.on('messageCreate', async (message) => {
    try {
      await inputHandler.handle(message);
    } catch (error) {
      logger.error(
        {
          error,
          guildId: message.guild?.id ?? null,
          channelId: message.channel.id,
          messageId: message.id,
          authorId: message.author.id,
          contentLength: message.content.length
        },
        'Failed to process message input'
      );
    }
  });
}
