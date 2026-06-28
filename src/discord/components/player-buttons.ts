import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const PLAYER_BUTTON_IDS = {
  pauseResume: 'player:pause-resume',
  next: 'player:next',
  previous: 'player:previous',
  stop: 'player:stop',
  shuffle: 'player:shuffle',
  queue: 'player:queue',
  clear: 'player:clear',
  loop: 'player:loop'
} as const;

export function createPlayerControlsRows(): ActionRowBuilder<ButtonBuilder>[] {
  const rowOne = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PLAYER_BUTTON_IDS.pauseResume)
      .setLabel('Play / Pause')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(PLAYER_BUTTON_IDS.previous)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.next).setLabel('Next').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.stop).setLabel('Stop').setStyle(ButtonStyle.Danger)
  );

  const rowTwo = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PLAYER_BUTTON_IDS.shuffle)
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.clear).setLabel('Clear').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.queue).setLabel('Queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(PLAYER_BUTTON_IDS.loop).setLabel('Loop').setStyle(ButtonStyle.Secondary)
  );

  return [rowOne, rowTwo];
}
