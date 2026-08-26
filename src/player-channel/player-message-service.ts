import type { GuildTextBasedChannel, Message } from 'discord.js';

import {
  PLAYER_BUTTON_IDS,
  createPlayerControlsRows
} from '../discord/components/player-buttons.js';
import { clonePlayerState, createIdleState, type GuildPlayerState } from '../music/player-state.js';
import { logger } from '../utils/logger.js';
import { PlayerMessageBuilder } from './player-message-builder.js';

const IMMEDIATE_UPDATE_TTL_MS = 1500;

type ImmediateRenderTask = {
  message: Message;
  state: GuildPlayerState;
};

type PendingRefresh = {
  channel: GuildTextBasedChannel;
  messageId: string;
  state: GuildPlayerState;
  resolvers: ((messageId: string) => void)[];
  rejecters: ((error: unknown) => void)[];
};

export class PlayerMessageService {
  private readonly builder = new PlayerMessageBuilder();
  private readonly playerButtonIds = new Set<string>(Object.values(PLAYER_BUTTON_IDS));
  private readonly channelUpdateChains = new Map<string, Promise<unknown>>();
  private readonly recentImmediateUpdates = new Map<string, number>();
  private readonly pendingImmediateRenders = new Map<string, ImmediateRenderTask>();
  private readonly runningImmediateRenders = new Set<string>();
  private readonly pendingRefreshes = new Map<string, PendingRefresh>();
  private readonly runningRefreshes = new Set<string>();

  public async ensureMessage(
    channel: GuildTextBasedChannel,
    existingMessageId?: string | null,
    state?: GuildPlayerState
  ): Promise<Message<true>> {
    const stateSnapshot = state ? clonePlayerState(state) : undefined;
    return this.enqueueChannelUpdate(channel.id, () =>
      this.ensureMessageInternal(channel, existingMessageId, stateSnapshot)
    );
  }

  public async update(
    channel: GuildTextBasedChannel,
    messageId: string,
    state: GuildPlayerState
  ): Promise<void> {
    const stateSnapshot = clonePlayerState(state);
    await this.enqueueChannelUpdate(channel.id, async () => {
      const message = await channel.messages.fetch(messageId);
      await this.renderMessage(message, stateSnapshot);
    });
  }

  public async updateMessage(message: Message, state: GuildPlayerState): Promise<void> {
    const stateSnapshot = clonePlayerState(state);
    await this.enqueueChannelUpdate(message.channelId, async () => {
      await this.renderMessage(message, stateSnapshot);
    });
  }

  public async updateMessageImmediate(message: Message, state: GuildPlayerState): Promise<void> {
    this.recentImmediateUpdates.set(message.id, Date.now());
    await this.enqueueImmediateRender(message, clonePlayerState(state));
  }

  public shouldSkipBackgroundRefresh(messageId: string): boolean {
    const updatedAt = this.recentImmediateUpdates.get(messageId);
    if (!updatedAt) {
      return false;
    }

    if (Date.now() - updatedAt > IMMEDIATE_UPDATE_TTL_MS) {
      this.recentImmediateUpdates.delete(messageId);
      return false;
    }

    this.recentImmediateUpdates.delete(messageId);
    return true;
  }

  private async enqueueImmediateRender(message: Message, state: GuildPlayerState): Promise<void> {
    const channelId = message.channelId;
    this.pendingImmediateRenders.set(channelId, {
      message,
      state
    });

    if (this.runningImmediateRenders.has(channelId)) {
      return;
    }

    this.runningImmediateRenders.add(channelId);
    try {
      for (;;) {
        const nextRender = this.pendingImmediateRenders.get(channelId);
        if (!nextRender) {
          return;
        }

        this.pendingImmediateRenders.delete(channelId);
        await this.renderMessage(nextRender.message, nextRender.state);
      }
    } finally {
      this.runningImmediateRenders.delete(channelId);
    }
  }

  /**
   * Background refresh for the persistent player message.
   *
   * State changes arrive in bursts — queueing a playlist, or a track transition
   * that flips isPlaying and then advances the queue, each emit a change. Only
   * the final state is worth rendering, so a burst that lands while an edit is
   * in flight collapses into one follow-up edit instead of one edit per event.
   * Every caller in the burst resolves with the message id that was rendered,
   * which may be a new one if the old message had been deleted.
   */
  public updateOrRecreate(
    channel: GuildTextBasedChannel,
    messageId: string,
    state: GuildPlayerState
  ): Promise<string> {
    const stateSnapshot = clonePlayerState(state);

    return new Promise<string>((resolve, reject) => {
      const queued = this.pendingRefreshes.get(channel.id);
      if (queued) {
        // Newer state supersedes the queued one; both callers share the result.
        queued.channel = channel;
        queued.messageId = messageId;
        queued.state = stateSnapshot;
        queued.resolvers.push(resolve);
        queued.rejecters.push(reject);
      } else {
        this.pendingRefreshes.set(channel.id, {
          channel,
          messageId,
          state: stateSnapshot,
          resolvers: [resolve],
          rejecters: [reject]
        });
      }

      void this.drainRefreshQueue(channel.id);
    });
  }

  private async drainRefreshQueue(channelId: string): Promise<void> {
    if (this.runningRefreshes.has(channelId)) {
      return;
    }

    this.runningRefreshes.add(channelId);
    try {
      for (;;) {
        const task = this.pendingRefreshes.get(channelId);
        if (!task) {
          return;
        }

        this.pendingRefreshes.delete(channelId);

        try {
          const renderedId = await this.renderOrRecreate(task.channel, task.messageId, task.state);
          for (const resolve of task.resolvers) {
            resolve(renderedId);
          }
        } catch (error) {
          for (const rejectTask of task.rejecters) {
            rejectTask(error);
          }
        }
      }
    } finally {
      this.runningRefreshes.delete(channelId);
    }
  }

  private renderOrRecreate(
    channel: GuildTextBasedChannel,
    messageId: string,
    state: GuildPlayerState
  ): Promise<string> {
    // Still funnelled through the per-channel chain so it cannot interleave with
    // ensureMessage or the immediate button-response renders.
    return this.enqueueChannelUpdate(channel.id, async () => {
      try {
        const message = await channel.messages.fetch(messageId);
        await this.renderMessage(message, state);
        return messageId;
      } catch {
        const recreated = await this.ensureMessageInternal(channel, null, state);
        return recreated.id;
      }
    });
  }

  /**
   * Removes every message in the player channel except the player itself.
   *
   * The single-channel UX treats the player message as the only thing that
   * belongs here, so this sweeps user messages and stray bot output alike.
   * Deletion goes through bulkDelete, which handles up to 100 messages in one
   * request instead of one request each — the previous per-message loop hit
   * rate limits on a channel with any real backlog. Discord refuses to bulk
   * delete anything older than 14 days, so those fall back to single deletes.
   */
  public async cleanupChannel(
    channel: GuildTextBasedChannel,
    keepMessageId?: string | null
  ): Promise<number> {
    let before: string | undefined;
    let deleted = 0;

    for (;;) {
      const messages = before
        ? await channel.messages.fetch({ limit: 100, before })
        : await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) {
        return deleted;
      }

      const oldest = messages.last();
      const removable = messages.filter(
        (message) => message.id !== keepMessageId && message.deletable
      );

      if (removable.size > 0) {
        // filterOld drops the >14d messages instead of rejecting the whole call.
        const bulkDeleted = await channel.bulkDelete(removable, true).catch((error: unknown) => {
          logger.warn(
            { error, channelId: channel.id },
            'Bulk delete failed in player channel, falling back to single deletes'
          );
          return null;
        });

        if (bulkDeleted) {
          deleted += bulkDeleted.size;
        }

        // Anything bulkDelete would not take (too old, or the call failed).
        const leftover = bulkDeleted
          ? removable.filter((message) => !bulkDeleted.has(message.id))
          : removable;

        for (const message of leftover.values()) {
          const removed = await message
            .delete()
            .then(() => true)
            .catch(() => false);
          if (removed) {
            deleted += 1;
          }
        }
      }

      if (!oldest || messages.size < 100) {
        return deleted;
      }

      before = oldest.id;
    }
  }

  private async fetchKnownMessage(
    channel: GuildTextBasedChannel,
    messageId?: string | null
  ): Promise<Message<true> | null> {
    if (!messageId) {
      return null;
    }

    try {
      return await channel.messages.fetch(messageId);
    } catch {
      return null;
    }
  }

  private async findReusablePlayerMessage(
    channel: GuildTextBasedChannel
  ): Promise<Message<true> | null> {
    const botUserId = channel.client.user?.id;
    if (!botUserId) {
      return null;
    }

    // Reuse an existing bot-authored control message when possible to avoid
    // stacking duplicate persistent players after restarts or partial cleanup.
    const messages = await channel.messages.fetch({ limit: 100 });
    return messages.find((message) => this.isReusablePlayerMessage(message, botUserId)) ?? null;
  }

  private isReusablePlayerMessage(message: Message<true>, botUserId: string): boolean {
    if (message.author.id !== botUserId) {
      return false;
    }

    const customIds = message.components.flatMap((row) => {
      if (!('components' in row)) {
        return [] as string[];
      }

      return row.components.flatMap((component) =>
        'customId' in component && typeof component.customId === 'string'
          ? [component.customId]
          : []
      );
    });

    return customIds.some((customId) => this.playerButtonIds.has(customId));
  }

  private async renderMessage(message: Message, state: GuildPlayerState): Promise<void> {
    await message.edit(this.buildMessagePayload(state));
  }

  private async ensureMessageInternal(
    channel: GuildTextBasedChannel,
    existingMessageId?: string | null,
    state?: GuildPlayerState
  ): Promise<Message<true>> {
    const renderState = state ?? this.buildIdleRenderState(channel);
    const knownMessage =
      (await this.fetchKnownMessage(channel, existingMessageId)) ??
      (await this.findReusablePlayerMessage(channel));
    if (knownMessage) {
      await this.renderMessage(knownMessage, renderState);
      await this.cleanupChannel(channel, knownMessage.id);
      return knownMessage;
    }

    const created = await channel.send({
      ...this.buildMessagePayload(renderState)
    });

    await this.cleanupChannel(channel, created.id);
    return created;
  }

  private buildMessagePayload(state: GuildPlayerState): {
    embeds: ReturnType<PlayerMessageBuilder['build']>;
    components: ReturnType<typeof createPlayerControlsRows>;
  } {
    return {
      embeds: this.builder.build(state),
      components: createPlayerControlsRows()
    };
  }

  private enqueueChannelUpdate<T>(channelId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.channelUpdateChains.get(channelId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);

    this.channelUpdateChains.set(channelId, next);

    return next.finally(() => {
      if (this.channelUpdateChains.get(channelId) === next) {
        this.channelUpdateChains.delete(channelId);
      }
    });
  }

  private buildIdleRenderState(channel: GuildTextBasedChannel): GuildPlayerState {
    return {
      ...createIdleState(channel.guild.id),
      textChannelId: channel.id
    };
  }
}
