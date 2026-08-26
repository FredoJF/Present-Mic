import type { Message, SendableChannels } from 'discord.js';

import { logger } from '../utils/logger.js';

/**
 * How long a feedback notice stays visible before deleting itself. Long enough
 * to read a failure reason, short enough that the player channel stays clean
 * without waiting for the periodic sweep.
 */
const NOTICE_LIFETIME_MS = 12_000;

/**
 * How long work must run before it is worth telling the user about. A YouTube
 * URL resolves well inside this, so the common case posts nothing at all; a
 * multi-page Spotify playlist takes far longer and does get a notice.
 */
const PROGRESS_NOTICE_DELAY_MS = 1500;

/** A notice that has been scheduled but may not have been posted yet. */
export type PendingNotice = {
  /** Cancels the notice if unsent, or deletes it if already posted. */
  dismiss: () => Promise<void>;
};

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

/**
 * Schedules a progress notice that only appears if the work is actually slow.
 *
 * The notice is posted after a short delay and removed by `dismiss()`. Work that
 * finishes before the delay elapses never posts anything, which keeps the
 * channel quiet for fast resolutions instead of flashing a message that is gone
 * before it can be read.
 */
export function startDeferredNotice(
  channel: SendableChannels,
  content: string,
  delayMs: number = PROGRESS_NOTICE_DELAY_MS
): PendingNotice {
  let dismissed = false;
  // Holds the in-flight send so a dismiss that lands mid-send still deletes it.
  let posting: Promise<Message | null> | null = null;
  // Makes dismiss idempotent: repeated calls await the first one rather than
  // issuing a second delete for a message that is already gone.
  let dismissing: Promise<void> | null = null;

  const timer = setTimeout(() => {
    if (dismissed) {
      return;
    }

    posting = channel.send({ content }).catch((error: unknown) => {
      logger.warn({ error, channelId: channel.id }, 'Failed to post progress notice');
      return null;
    });
  }, delayMs);

  timer.unref();

  const runDismiss = async (): Promise<void> => {
    if (!posting) {
      return;
    }

    const notice = await posting;
    await notice?.delete().catch(() => undefined);
  };

  return {
    dismiss(): Promise<void> {
      dismissed = true;
      clearTimeout(timer);
      dismissing ??= runDismiss();
      return dismissing;
    }
  };
}
