import type { GuildTextBasedChannel, Message } from 'discord.js';

import {
  PLAYER_BUTTON_IDS,
  createPlayerControlsRows
} from '../discord/components/player-buttons.js';
import { clonePlayerState, createIdleState, type GuildPlayerState } from '../music/player-state.js';
import { PlayerMessageBuilder } from './player-message-builder.js';

const IMMEDIATE_UPDATE_TTL_MS = 1500;

type ImmediateRenderTask = {
  message: Message;
  state: GuildPlayerState;
};

export class PlayerMessageService {
  private readonly builder = new PlayerMessageBuilder();
  private readonly playerButtonIds = new Set<string>(Object.values(PLAYER_BUTTON_IDS));
  private readonly channelUpdateChains = new Map<string, Promise<unknown>>();
  private readonly recentImmediateUpdates = new Map<string, number>();
  private readonly pendingImmediateRenders = new Map<string, ImmediateRenderTask>();
  private readonly runningImmediateRenders = new Set<string>();

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

  public async updateOrRecreate(
    channel: GuildTextBasedChannel,
    messageId: string,
    state: GuildPlayerState
  ): Promise<string> {
    const stateSnapshot = clonePlayerState(state);
    return this.enqueueChannelUpdate(channel.id, async () => {
      try {
        const message = await channel.messages.fetch(messageId);
        await this.renderMessage(message, stateSnapshot);
        return messageId;
      } catch {
        const recreated = await this.ensureMessageInternal(channel, null, stateSnapshot);
        return recreated.id;
      }
    });
  }

  public async cleanupChannel(
    channel: GuildTextBasedChannel,
    keepMessageId?: string | null
  ): Promise<void> {
    const botUserId = channel.client.user?.id;
    if (!botUserId) {
      return;
    }

    let before: string | undefined;

    for (;;) {
      const messages = before
        ? await channel.messages.fetch({ limit: 100, before })
        : await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) {
        return;
      }

      await Promise.all(
        messages
          .filter((message) => message.author.id === botUserId && message.id !== keepMessageId)
          .map((message) => message.delete().catch(() => undefined))
      );

      const oldest = messages.last();
      if (!oldest || messages.size < 100) {
        return;
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
