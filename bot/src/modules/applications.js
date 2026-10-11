// Анкеты RP-персонажей: игрок заполняет форму, модераторы принимают или отклоняют кнопками.
// При принятии — роли и вайтлист (по привязанному Steam).

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { banFields, checkAll, hasBans } from '../bancheck.js';
import { BotError } from '../core.js';
import { LEVEL, embed, ts } from '../util.js';
import { addToWhitelist, steamLabel } from './steam.js';

const QUESTIONS = [
  { id: 'name', label: 'Имя, фамилия, позывной персонажа', style: TextInputStyle.Short, min: 3, max: 80 },
  { id: 'age', label: 'Возраст и происхождение', style: TextInputStyle.Short, min: 2, max: 100 },
  { id: 'faction', label: 'Группировка / к кому тянется персонаж', style: TextInputStyle.Short, min: 2, max: 100 },
  { id: 'story', label: 'Биография: как и зачем попал в Зону', style: TextInputStyle.Paragraph, min: 300, max: 2000 },
  { id: 'exp', label: 'Опыт RP, что такое NonRP/MetaGaming', style: TextInputStyle.Paragraph, min: 50, max: 1000 },
];

export function applicationPanel() {
  return {
    embeds: [
      embed(
        'info',
        '📝 Анкета персонажа',
        'Чтобы попасть на сервер, заполни анкету персонажа.\n\n' +
          'Пиши от лица персонажа, без «я играю за…». Биография — не меньше 300 символов. Анкету рассмотрят модераторы, ответ придёт в личные сообщения.',
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('apps:open').setLabel('Подать анкету').setEmoji('📝').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

function reviewButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apps:accept:${id}`).setLabel('Принять').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`apps:reject:${id}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

export default {
  name: 'apps',

  async onComponent(i, ctx, [action, idStr]) {
    const cfg = ctx.cfg.applications;
    const q = {
      get: ctx.db.prepare('SELECT * FROM applications WHERE id = ?'),
      last: ctx.db.prepare('SELECT * FROM applications WHERE discord_id = ? ORDER BY id DESC LIMIT 1'),
    };

    if (action === 'open') {
      if (cfg.requireSteam && !ctx.links.get(i.user.id)) {
        return i.reply({
          embeds: [embed('warn', null, 'Сначала укажи свой Steam — нажми кнопку ниже, затем снова «Подать анкету».')],
          components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('steam:manual').setLabel('Вписать SteamID').setEmoji('✏️').setStyle(ButtonStyle.Primary))],
          flags: MessageFlags.Ephemeral,
        });
      }
      if (ctx.cfg.roles.whitelisted && i.member.roles.cache.has(ctx.cfg.roles.whitelisted)) throw new BotError('Ты уже в вайтлисте');
      const last = q.last.get(i.user.id);
      if (last?.status === 'pending') throw new BotError('Твоя анкета уже на рассмотрении');
      if (last?.status === 'rejected' && Date.now() - last.decided_at < cfg.cooldownHours * 3600e3) {
        throw new BotError(`Повторно подать анкету можно ${ts(last.decided_at + cfg.cooldownHours * 3600e3)}`);
      }
      const modal = new ModalBuilder().setCustomId('apps:submit').setTitle('Анкета персонажа');
      for (const qn of QUESTIONS) {
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(qn.id).setLabel(qn.label).setStyle(qn.style).setMinLength(qn.min).setMaxLength(qn.max).setRequired(true),
          ),
        );
      }
      return i.showModal(modal);
    }

    if (action === 'submit') {
      const answers = Object.fromEntries(QUESTIONS.map((qn) => [qn.id, i.fields.getTextInputValue(qn.id)]));
      const last = q.last.get(i.user.id);
      if (last?.status === 'pending') throw new BotError('Твоя анкета уже на рассмотрении');
      const { lastInsertRowid: id } = ctx.db
        .prepare('INSERT INTO applications (discord_id, answers, created_at) VALUES (?, ?, ?)')
        .run(i.user.id, JSON.stringify(answers), Date.now());

      const link = ctx.links.get(i.user.id);
      const e = embed('info', `Анкета #${id}`)
        .setAuthor({ name: i.user.tag, iconURL: i.user.displayAvatarURL() })
        .addFields(
          { name: 'Участник', value: `<@${i.user.id}>`, inline: true },
          { name: 'Аккаунт создан', value: ts(i.user.createdTimestamp), inline: true },
          { name: 'Steam', value: steamLabel(link), inline: true },
        );
      for (const qn of QUESTIONS) e.addFields({ name: qn.label, value: answers[qn.id].slice(0, 1024) });
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      // Проверка по базам банов — модератор видит её сразу в анкете (в отдельном блоке, чтобы не упереться в лимит полей).
      const embeds = [e];
      if (link) {
        const results = await checkAll(ctx.cfg, link.steam_id).catch(() => []);
        embeds.push(embed(hasBans(results) ? 'bad' : 'ok', hasBans(results) ? '🚩 Найдены баны' : 'Проверка банов').addFields(banFields(results)));
      }
      const msg = await ctx.post('applications', { embeds, components: [reviewButtons(id)] });
      if (msg) ctx.db.prepare('UPDATE applications SET message_id = ? WHERE id = ?').run(msg.id, id);
      return i.editReply({ embeds: [embed('ok', null, '✅ Анкета отправлена. Ответ придёт в личные сообщения.')] });
    }

    // Рассмотрение — модераторы.
    ctx.require(i, LEVEL.moderator);
    const id = Number(idStr);
    const app = q.get.get(id);
    if (!app) throw new BotError('Анкета не найдена');
    if (app.status !== 'pending') {
      // Кнопки «зависли» (Discord не дождался ответа) — приводим сообщение в порядок.
      const state = app.status === 'accepted' ? embed('ok', null, `✅ Принята <@${app.reviewer_id}>`) : embed('bad', null, `❌ Отклонена <@${app.reviewer_id}>${app.reason ? `: ${app.reason}` : ''}`);
      if (i.isMessageComponent()) return i.update({ embeds: [...i.message.embeds, state], components: [reviewButtons(id, true)] });
      throw new BotError('Анкета уже рассмотрена');
    }

    if (action === 'reject') {
      const modal = new ModalBuilder()
        .setCustomId(`apps:rejectReason:${id}`)
        .setTitle(`Отклонить анкету #${id}`)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('reason').setLabel('Причина (увидит игрок)').setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true),
          ),
        );
      return i.showModal(modal);
    }

    const decide = ctx.db.prepare(
      "UPDATE applications SET status = ?, reviewer_id = ?, reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
    );
    // Сразу подтверждаем нажатие: дальше роли, вайтлист и сообщения — это несколько запросов к Discord.
    await i.deferUpdate();
    const member = await i.guild.members.fetch(app.discord_id).catch(() => null);

    if (action === 'accept') {
      if (decide.run('accepted', i.user.id, null, Date.now(), id).changes === 0) throw new BotError('Анкета уже рассмотрена');
      let note = '';
      if (member) {
        for (const r of cfg.acceptRoles) await member.roles.add(r, `Анкета #${id}`).catch(() => {});
        for (const r of cfg.removeRoles) await member.roles.remove(r, `Анкета #${id}`).catch(() => {});
        if (cfg.addToWhitelist) {
          try {
            const applied = await addToWhitelist(ctx, member, i.user.tag);
            note = applied ? '' : ' · вайтлист применится, когда агент будет в сети';
          } catch (e) {
            note = ` · ⚠️ вайтлист: ${e.message}`;
          }
        }
        member
          .send({ embeds: [embed('ok', '✅ Анкета принята', 'Добро пожаловать в Зону, сталкер. Данные для подключения — в канале статуса сервера.')] })
          .catch(() => {});
      } else {
        note = ' · участник покинул Discord';
      }
      const e = embed('ok', null, `✅ Принята <@${i.user.id}>${note}`);
      await i.update({ embeds: [...i.message.embeds, e], components: [reviewButtons(id, true)] });
      return ctx.audit('📝 Анкета принята', { Анкета: `#${id}`, Участник: `<@${app.discord_id}>`, Кто: `<@${i.user.id}>` }, 'ok');
    }

    if (action === 'rejectReason') {
      const reason = i.fields.getTextInputValue('reason');
      if (decide.run('rejected', i.user.id, reason, Date.now(), id).changes === 0) throw new BotError('Анкета уже рассмотрена');
      member
        ?.send({
          embeds: [
            embed('bad', '❌ Анкета отклонена', `Причина: ${reason}\n\nИсправь анкету и подай снова через ${ctx.cfg.applications.cooldownHours} ч.`),
          ],
        })
        .catch(() => {});
      const e = embed('bad', null, `❌ Отклонена <@${i.user.id}>: ${reason}`);
      await i.update({ embeds: [...i.message.embeds, e], components: [reviewButtons(id, true)] });
      return ctx.audit('📝 Анкета отклонена', { Анкета: `#${id}`, Участник: `<@${app.discord_id}>`, Кто: `<@${i.user.id}>`, Причина: reason }, 'warn');
    }
  },
};
