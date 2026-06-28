import type { Client } from 'discord.js';

import type { MessageInputHandler } from '../../player-channel/message-input-handler.js';
import { logger } from '../../utils/logger.js';

export function bindMessageCreateEvent(client: Client, inputHandler: MessageInputHandler): void {
  client.on('messageCreate', async (message) => {
    try {
      await inputHandler.handle(message);
    } catch (error) {
      logger.error({ error }, 'Failed to process message input');
    }
  });
}
