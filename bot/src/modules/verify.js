// Верификация новичков: принять правила + простая проверка «нажми нужную кнопку» против ботов.
// Слишком новые аккаунты Discord не проходят автоматически — о них сообщается модераторам.

import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, MessageFlags } from 'discord.js';
import { BotError } from '../core.js';
import { linkManual, steamModal } from './steam.js';
import { embed, ts } from '../util.js';

const CHOICES = [
  ['☢️', 'знак радиации'],
  ['🔦', 'фонарик'],
  ['🎒', 'рюкзак'],
  ['🧭', 'компас'],
  ['🔫', 'оружие'],
  ['🍞', 'хлеб'],
];
const challenges = new Map(); // token -> { userId, answer, expires }

export function verifyPanel() {
  return {
    embeds: [
      embed(
        'info',
        '☢️ Вход в Зону',
        'Прочитай правила сервера. Нажимая кнопку, ты подтверждаешь, что согласен с ними. Затем впиши свой Steam — и получишь доступ к каналам.',
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('verify:start').setLabel('Я прочитал правила').setEmoji('✅').setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function finish(i, ctx) {
  const { verified, unverified } = ctx.cfg.roles;
  await i.member.roles.add(verified, 'Верификация');
  if (unverified) await i.member.roles.remove(unverified, 'Верификация').catch(() => {});
}

export default {
  name: 'verify',

  init(ctx) {
    const { unverified } = ctx.cfg.roles;
    if (unverified) {
      ctx.client.on(Events.GuildMemberAdd, (m) => {
        if (m.guild.id === ctx.cfg.guildId && !m.user.bot) m.roles.add(unverified, 'Новый участник').catch(() => {});
      });
    }
  },

  async onComponent(i, ctx, [action, token, choice]) {
    const { verified } = ctx.cfg.roles;
    if (!verified) throw new BotError('Роль verified не настроена');

    if (action === 'start') {
      if (i.member.roles.cache.has(verified)) throw new BotError('Ты уже прошёл верификацию');
      const minAge = ctx.cfg.verify.minAccountAgeDays * 86400e3;
      if (Date.now() - i.user.createdTimestamp < minAge) {
        ctx.audit('🕵️ Новый аккаунт не прошёл верификацию', { Участник: `<@${i.user.id}>`, 'Аккаунт создан': ts(i.user.createdTimestamp) }, 'warn');
        throw new BotError('Твой аккаунт Discord слишком новый. Создай тикет — администрация проверит вручную.');
      }
      const options = shuffle([...CHOICES]).slice(0, 4);
      const answer = options[crypto.randomInt(options.length)];
      const t = crypto.randomBytes(6).toString('hex');
      challenges.set(t, { userId: i.user.id, answer: answer[0], expires: Date.now() + 120_000 });
      setTimeout(() => challenges.delete(t), 120_000);
      const row = new ActionRowBuilder().addComponents(
        options.map(([emoji], n) => new ButtonBuilder().setCustomId(`verify:answer:${t}:${n}`).setEmoji(emoji).setStyle(ButtonStyle.Secondary)),
      );
      // Варианты запоминаем по порядку, чтобы не передавать ответ в customId.
      challenges.get(t).options = options.map(([e]) => e);
      return i.reply({ embeds: [embed('info', null, `Нажми на **${answer[1]}**`)], components: [row], flags: MessageFlags.Ephemeral });
    }

    if (action === 'answer') {
      const c = challenges.get(token);
      challenges.delete(token);
      if (!c || c.userId !== i.user.id || c.expires < Date.now()) {
        return i.update({ embeds: [embed('neutral', null, 'Проверка устарела — нажми кнопку ещё раз')], components: [] });
      }
      if (c.options[Number(choice)] !== c.answer) {
        return i.update({ embeds: [embed('bad', null, 'Неверно. Нажми кнопку на панели ещё раз.')], components: [] });
      }
      // Дальше — вписать свой Steam (если включено), потом роль.
      if (ctx.cfg.verify.askSteam !== false && !ctx.links.get(i.user.id)) return i.showModal(steamModal('verify:steam'));
      await finish(i, ctx);
      return i.update({ embeds: [embed('ok', null, '✅ Добро пожаловать! Теперь можно подать анкету.')], components: [] });
    }

    if (action === 'steam') {
      const r = await linkManual(ctx, i.member, i.fields.getTextInputValue('steam'));
      if (!r.ok) {
        // Окно можно открыть снова — кнопкой «Я прочитал правила».
        throw new BotError(`${r.message}\nНажми «Я прочитал правила» ещё раз.`);
      }
      await finish(i, ctx);
      const done = embed('ok', null, `✅ Добро пожаловать! Steam сохранён: \`${r.steamId}\`. Теперь можно подать анкету.`);
      return i.isFromMessage() ? i.update({ embeds: [done], components: [] }) : i.reply({ embeds: [done], flags: MessageFlags.Ephemeral });
    }
  },
};
