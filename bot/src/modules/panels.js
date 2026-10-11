// /panel — разместить панель (анкеты, тикеты, верификация, роли) в текущем канале.

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { LEVEL, embed } from '../util.js';
import { applicationPanel } from './applications.js';
import { rolesPanel } from './roles.js';
import { ticketPanel } from './tickets.js';
import { verifyPanel } from './verify.js';

const PANELS = {
  applications: () => applicationPanel(),
  tickets: (ctx) => ticketPanel(ctx),
  verify: () => verifyPanel(),
  roles: (ctx) => rolesPanel(ctx),
};

export default {
  name: 'panels',
  commands: [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Разместить панель с кнопками в этом канале')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Какая панель')
          .setRequired(true)
          .addChoices(
            { name: 'Анкеты', value: 'applications' },
            { name: 'Тикеты', value: 'tickets' },
            { name: 'Верификация', value: 'verify' },
            { name: 'Роли', value: 'roles' },
          ),
      ),
  ],

  async onCommand(i, ctx) {
    ctx.require(i, LEVEL.admin);
    const type = i.options.getString('type');
    await i.channel.send(PANELS[type](ctx));
    return i.reply({ embeds: [embed('ok', null, 'Панель размещена')], flags: MessageFlags.Ephemeral });
  },
};
