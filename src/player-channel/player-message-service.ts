import type { GuildTextBasedChannel, Message } from 'discord.js';

import {
  PLAYER_BUTTON_IDS,
  createPlayerControlsRows
} from '../discord/components/player-buttons.js';
import { createIdleState, type GuildPlayerState } from '../music/player-state.js';
import { PlayerMessageBuilder } from './player-message-builder.js';

export class PlayerMessageService {
  private readonly builder = new PlayerMessageBuilder();
  private readonly playerButtonIds = new Set<string>(Object.values(PLAYER_BUTTON_IDS));

  public async ensureMessage(
    channel: GuildTextBasedChannel,
    existingMessageId?: string | null,
    state?: GuildPlayerState
  ): Promise<Message<true>> {
    const renderState = this.resolveState(channel, state);
    const knownMessage = await this.fetchKnownMessage(channel, existingMessageId);

    if (knownMessage) {
      await this.renderMessage(knownMessage, renderState);
      await this.cleanupChannel(channel, knownMessage.id);
      return knownMessage;
    }

    const reusableMessage = await this.findReusablePlayerMessage(channel);
    if (reusableMessage) {
      await this.renderMessage(reusableMessage, renderState);
      await this.cleanupChannel(channel, reusableMessage.id);
      return reusableMessage;
    }

    const created = await channel.send({
      embeds: [this.builder.build(renderState)],
      components: createPlayerControlsRows()
    });

    await this.cleanupChannel(channel, created.id);
    return created;
  }

  public async update(
    channel: GuildTextBasedChannel,
    messageId: string,
    state: GuildPlayerState
  ): Promise<void> {
    const message = await channel.messages.fetch(messageId);
    await this.renderMessage(message, state);
  }

  public async updateOrRecreate(
    channel: GuildTextBasedChannel,
    messageId: string,
    state: GuildPlayerState
  ): Promise<string> {
    try {
      await this.update(channel, messageId, state);
      return messageId;
    } catch {
      const recreated = await this.ensureMessage(channel, null, state);
      return recreated.id;
    }
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

  private async renderMessage(message: Message<true>, state: GuildPlayerState): Promise<void> {
    await message.edit({
      embeds: [this.builder.build(state)],
      components: createPlayerControlsRows()
    });
  }

  private resolveState(channel: GuildTextBasedChannel, state?: GuildPlayerState): GuildPlayerState {
    if (state) {
      return state;
    }

    return {
      ...createIdleState(channel.guild.id),
      textChannelId: channel.id
    };
  }
}
