import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const PLAYER_BUTTON_IDS = {
  pauseResume: 'player:pause-resume',
  next: 'player:next',
  previous: 'player:previous',
  stop: 'player:stop',
  shuffle: 'player:shuffle',
  clear: 'player:clear',
  loop: 'player:loop'
} as const;

function createButton(
  customId: (typeof PLAYER_BUTTON_IDS)[keyof typeof PLAYER_BUTTON_IDS],
  label: string,
  style: ButtonStyle
): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function createPauseResumeButton(): ButtonBuilder {
  return createButton(PLAYER_BUTTON_IDS.pauseResume, 'Play / Pause', ButtonStyle.Primary);
}

export function createPlayerControlsRows(): ActionRowBuilder<ButtonBuilder>[] {
  const playbackRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    createPauseResumeButton(),
    createButton(PLAYER_BUTTON_IDS.previous, 'Previous', ButtonStyle.Secondary),
    createButton(PLAYER_BUTTON_IDS.next, 'Next', ButtonStyle.Secondary),
    createButton(PLAYER_BUTTON_IDS.stop, 'Stop', ButtonStyle.Danger)
  );

  const utilityRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    createButton(PLAYER_BUTTON_IDS.shuffle, 'Shuffle', ButtonStyle.Secondary),
    createButton(PLAYER_BUTTON_IDS.loop, 'Loop', ButtonStyle.Secondary),
    createButton(PLAYER_BUTTON_IDS.clear, 'Clear', ButtonStyle.Secondary)
  );

  return [playbackRow, utilityRow];
}
