import type { Message, SendableChannels } from 'discord.js';

import { logger } from '../utils/logger.js';

/**
 * How long a feedback notice stays visible before deleting itself. Long enough
 * to read a failure reason, short enough that the player channel stays clean
 * without waiting for the periodic sweep.
 */
const NOTICE_LIFETIME_MS = 12_000;

/**
 * Posts a short-lived notice in the player channel.
 *
 * The player channel is meant to hold exactly one message — the player itself.
 * Feedback about a failed request still has to be visible, so it is posted and
 * then removed on a timer. The sweep in PlayerChannelCleaner is the backstop for
 * notices whose timer is lost to a restart.
 */
export async function sendTransientNotice(
  channel: SendableChannels,
  content: string
): Promise<void> {
  let notice: Message;
  try {
    notice = await channel.send({ content });
  } catch (error) {
    logger.warn({ error, channelId: channel.id }, 'Failed to post transient notice');
    return;
  }

  const timer = setTimeout(() => {
    void notice.delete().catch(() => undefined);
  }, NOTICE_LIFETIME_MS);

  // Never hold the process open for a cosmetic deletion.
  timer.unref();
}
