const {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

// DB keys
const TCFG = (gid) => `ticket_cfg_${gid}`;
const TDATA = (channelId) => `ticket_data_${channelId}`;
const TCOUNT = (gid) => `ticket_counter_${gid}`;

// Helpers
function pad(num, len = 4) {
  return String(num).padStart(len, "0");
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (_) {}
}

// ===== Panel UI =====
function panelEmbed() {
  return new EmbedBuilder()
    .setTitle("Ticket")
    .setDescription("Ticket açmak için aşağıdaki butona tıklayabilirsiniz.");
}

function panelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("t_open_complaint")
        .setLabel("Şikayet ve bildirileriniz için")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function closeComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("t_close").setLabel("Ticket Kapat").setStyle(ButtonStyle.Danger)
    ),
  ];
}

// Log kanalına mesaj at (log opsiyonel)
async function sendTicketLog(guild, logChannelId, payload) {
  if (!logChannelId) return;
  const logCh = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!logCh?.isTextBased?.()) return;
  await logCh.send(payload).catch(() => {});
}

// Panel kanalı izinleri: everyone görebilsin
async function ensurePanelPerms(guild, panelCh) {
  await panelCh.permissionOverwrites
    .edit(guild.roles.everyone.id, {
      ViewChannel: true,
      ReadMessageHistory: true,
    })
    .catch(() => {});
}

// Log kanalı izinleri: everyone göremesin, sadece yetkili rol + bot görebilsin
async function ensureLogPerms(guild, logCh, staffRoleId) {
  if (!logCh) return;

  await logCh.permissionOverwrites
    .edit(guild.roles.everyone.id, {
      ViewChannel: false,
    })
    .catch(() => {});

  // Bot görsün + yazsın
  const me = guild.members.me;
  if (me) {
    await logCh.permissionOverwrites
      .edit(me.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        EmbedLinks: true,
        AttachFiles: true,
      })
      .catch(() => {});
  }

  // Yetkili rol görsün
  if (staffRoleId) {
    await logCh.permissionOverwrites
      .edit(staffRoleId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
      })
      .catch(() => {});
  }
}

// ✅ Bir mesaj "ticket panel" mi? (embed title + buton customId ile)
function isTicketPanelMessage(msg) {
  // embed başlığı Ticket mi?
  const hasTicketEmbed =
    Array.isArray(msg.embeds) &&
    msg.embeds.some((e) => (e?.title || "").toLowerCase().trim() === "ticket");

  if (!hasTicketEmbed) return false;

  // içinde t_open_complaint butonu var mı?
  const hasOpenButton =
    Array.isArray(msg.components) &&
    msg.components.some((row) =>
      row.components?.some((c) => c?.customId === "t_open_complaint")
    );

  return hasOpenButton;
}

// ✅ Panel kanalda eski panel mesajlarını yakalayıp temizle (son N mesajdan)
async function cleanupOldTicketPanels(panelCh, maxScan = 75) {
  if (!panelCh?.isTextBased?.()) return 0;

  const me = panelCh.guild.members.me;
  if (!me) return 0;

  // ManageMessages yoksa toplu temizlik yapamayız (sessiz geç)
  const perms = panelCh.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ManageMessages)) {
    return 0;
  }

  const msgs = await panelCh.messages.fetch({ limit: Math.min(maxScan, 100) }).catch(() => null);
  if (!msgs) return 0;

  let deleted = 0;

  // Sadece botun kendi attığı panel mesajlarını sil
  const myId = me.id;

  for (const msg of msgs.values()) {
    // bot mesajı değilse dokunma
    if (msg.author?.id !== myId) continue;

    if (isTicketPanelMessage(msg)) {
      await msg.delete().catch(() => {});
      deleted += 1;
    }
  }

  return deleted;
}

// ✅ Panel mesajını “tek” tut: varsa eskileri temizle, yenisini at, pinle
async function replaceTicketPanelMessage(guild, cfg, db) {
  const panelCh = await guild.channels.fetch(cfg.panelChannelId).catch(() => null);
  if (!panelCh?.isTextBased?.()) return { ok: false, error: "Panel kanalı bulunamadı." };

  await ensurePanelPerms(guild, panelCh);

  // 1) DB’de kayıtlı panel mesajı varsa silmeyi dene
  if (cfg.panelMessageId) {
    const old = await panelCh.messages.fetch(cfg.panelMessageId).catch(() => null);
    if (old) await old.delete().catch(() => {});
  }

  // 2) ✅ Kanaldaki “eski panel” mesajlarını yakala & temizle (botun attıkları)
  await cleanupOldTicketPanels(panelCh, 75);

  // 3) Yeni panel bas
  const msg = await panelCh.send({ embeds: [panelEmbed()], components: panelComponents() });

  // 4) Pinle (izin yoksa sessiz geç)
  try {
    if (!msg.pinned) await msg.pin();
  } catch (_) {}

  // 5) cfg içine panelMessageId yaz
  cfg.panelMessageId = msg.id;
  await db.set(TCFG(guild.id), cfg);

  return { ok: true, panelChannel: panelCh, message: msg };
}

module.exports = function registerTicket(client, db, config) {
  client.on("interactionCreate", async (interaction) => {
    try {
      // -------- SLASH --------
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName !== "ticket") return;

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const sub = interaction.options.getSubcommand();

        // /ticket setup
        if (sub === "setup") {
          // ✅ sıra: kategori -> log -> panel
          const kategori = interaction.options.getChannel("kategori", true);
          const logCh = interaction.options.getChannel("log", false); // opsiyonel
          const panelCh = interaction.options.getChannel("panel", true);
          const yetkiliRol = interaction.options.getRole("yetkili_rol", false);

          // Validations
          if (kategori.type !== ChannelType.GuildCategory) {
            return safeReply(interaction, { content: "Ticket kategorisi bir **kategori** olmalı.", ephemeral: true });
          }

          if (panelCh.type !== ChannelType.GuildText && panelCh.type !== ChannelType.GuildAnnouncement) {
            return safeReply(interaction, { content: "Panel kanalı bir **yazı kanalı** olmalı.", ephemeral: true });
          }

          if (logCh && logCh.type !== ChannelType.GuildText && logCh.type !== ChannelType.GuildAnnouncement) {
            return safeReply(interaction, { content: "Log kanalı bir **yazı kanalı** olmalı.", ephemeral: true });
          }

          await ensurePanelPerms(interaction.guild, panelCh);
          if (logCh) await ensureLogPerms(interaction.guild, logCh, yetkiliRol?.id || null);

          // ✅ cfg kaydet (panelMessageId de dahil)
          const cfg = {
            panelChannelId: panelCh.id,
            categoryId: kategori.id,
            staffRoleId: yetkiliRol?.id || null,
            logChannelId: logCh?.id || null, // opsiyonel
            panelMessageId: null,
          };
          await db.set(TCFG(interaction.guildId), cfg);

          return safeReply(interaction, {
            content:
              `✅ Ticket sistemi kuruldu.\n` +
              `• Kategori: <#${kategori.id}>\n` +
              `• Log: ${logCh ? `<#${logCh.id}>` : "**Kapalı (seçilmedi)**"}\n` +
              `• Panel: <#${panelCh.id}>\n` +
              `• Yetkili rol: ${yetkiliRol ? `<@&${yetkiliRol.id}>` : "Yok"}\n\n` +
              `ℹ️ Paneli yenilemek için: **/ticket panel** (kanaldaki eski panelleri de temizler).`,
            ephemeral: true,
          });
        }

        // /ticket panel
        if (sub === "panel") {
          const cfg = await db.get(TCFG(interaction.guildId));
          if (!cfg?.panelChannelId || !cfg?.categoryId) {
            return safeReply(interaction, { content: "Önce `/ticket setup` yap.", ephemeral: true });
          }

          const res = await replaceTicketPanelMessage(interaction.guild, cfg, db);
          if (!res.ok) {
            return safeReply(interaction, {
              content: "Panel basılamadı: " + (res.error || "Bilinmeyen hata"),
              ephemeral: true,
            });
          }

          return safeReply(interaction, { content: "✅ Ticket panel yenilendi (eski paneller temizlendi).", ephemeral: true });
        }

        // /ticket off
        if (sub === "off") {
          await db.delete(TCFG(interaction.guildId));
          return safeReply(interaction, { content: "🛑 Ticket sistemi kapatıldı.", ephemeral: true });
        }
      }

      // -------- BUTTONS --------
      if (interaction.isButton()) {
        if (!interaction.customId?.startsWith("t_")) return;

        const cfg = await db.get(TCFG(interaction.guildId));
        if (!cfg) {
          return safeReply(interaction, { content: "Ticket sistemi kurulu değil. `/ticket setup` yap.", ephemeral: true });
        }

        // Açma butonu -> modal
        if (interaction.customId === "t_open_complaint") {
          const modal = new ModalBuilder().setCustomId("t_modal_open").setTitle("Lütfen sorununuzu detaylı anlatın");

          const input = new TextInputBuilder()
            .setCustomId("complaint")
            .setLabel("Şikayet / Bildiri")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        // Kapat butonu -> modal
        if (interaction.customId === "t_close") {
          const modal = new ModalBuilder().setCustomId("t_modal_close").setTitle("Ticket Kapat");

          const input = new TextInputBuilder()
            .setCustomId("close_reason")
            .setLabel("Kapatma nedeni")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(800);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }
      }

      // -------- MODALS --------
      if (interaction.isModalSubmit()) {
        if (!interaction.customId?.startsWith("t_modal_")) return;

        const cfg = await db.get(TCFG(interaction.guildId));
        if (!cfg) {
          return safeReply(interaction, { content: "Ticket sistemi kurulu değil. `/ticket setup` yap.", ephemeral: true });
        }

        // Modal: ticket aç
        if (interaction.customId === "t_modal_open") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          const complaint = (interaction.fields.getTextInputValue("complaint") || "").trim();
          if (!complaint) return safeReply(interaction, { content: "Şikayet boş olamaz.", ephemeral: true });

          let n = (await db.get(TCOUNT(interaction.guildId))) || 0;
          n += 1;
          await db.set(TCOUNT(interaction.guildId), n);

          const name = `ticket-${pad(n)}`;

          const overwrites = [
            {
              id: interaction.guild.roles.everyone.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: interaction.user.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ];

          if (cfg.staffRoleId) {
            overwrites.push({
              id: cfg.staffRoleId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            });
          }

          const ch = await interaction.guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: cfg.categoryId || null,
            permissionOverwrites: overwrites,
            topic: `Ticket • Açan: ${interaction.user.tag} (${interaction.user.id})`,
          });

          await db.set(TDATA(ch.id), {
            id: pad(n),
            openedById: interaction.user.id,
            openedByTag: interaction.user.tag,
            complaint,
            openedAt: Date.now(),
          });

          const embed = new EmbedBuilder()
            .setTitle("🎫 Ticket Açıldı")
            .setDescription(
              `**Açan:** <@${interaction.user.id}>\n` +
                `**Ticket ID:** ${pad(n)}\n\n` +
                `**Şikayet / Bildiri:**\n${complaint}`
            );

          await ch.send({ embeds: [embed], components: closeComponents() });

          // Açılış logu (opsiyonel)
          await sendTicketLog(interaction.guild, cfg.logChannelId, {
            embeds: [
              new EmbedBuilder()
                .setTitle("🎫 Ticket Açıldı")
                .setDescription(
                  `**Ticket ID:** ${pad(n)}\n` +
                    `**Kategori:** Şikayet ve bildirileriniz için\n` +
                    `**Açan:** <@${interaction.user.id}> (${interaction.user.tag})\n` +
                    `**Kanal:** <#${ch.id}>\n` +
                    `**Açılış:** <t:${Math.floor(Date.now() / 1000)}:f>\n\n` +
                    `**Şikayet / Bildiri:**\n${complaint}`
                ),
            ],
          });

          return safeReply(interaction, { content: `✅ Ticket açıldı: <#${ch.id}>`, ephemeral: true });
        }

        // Modal: ticket kapat + LOG (opsiyonel)
        if (interaction.customId === "t_modal_close") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});

          const closeReason = (interaction.fields.getTextInputValue("close_reason") || "").trim();
          if (!closeReason) return safeReply(interaction, { content: "Kapatma nedeni boş olamaz.", ephemeral: true });

          const data = await db.get(TDATA(interaction.channelId));
          if (!data) {
            return safeReply(interaction, { content: "Bu kanal ticket gibi görünmüyor (DB kaydı yok).", ephemeral: true });
          }

          const openedAtText = `<t:${Math.floor(data.openedAt / 1000)}:f>`;
          const closedAt = Date.now();
          const closedAtText = `<t:${Math.floor(closedAt / 1000)}:f>`;

          const logEmbed = new EmbedBuilder()
            .setTitle("✅ Ticket Kapatıldı")
            .setDescription(
              `**Ticket ID:** ${data.id}\n` +
                `**Kategori:** Şikayet ve bildirileriniz için\n` +
                `**Açan:** <@${data.openedById}> (${data.openedByTag})\n` +
                `**Kapatan:** <@${interaction.user.id}> (${interaction.user.tag})\n` +
                `**Açılış:** ${openedAtText}\n` +
                `**Kapanış:** ${closedAtText}\n\n` +
                `**Şikayet / Bildiri:**\n${data.complaint}\n\n` +
                `**Kapatma Nedeni:**\n${closeReason}`
            );

          await sendTicketLog(interaction.guild, cfg.logChannelId, { embeds: [logEmbed] });

          await db.delete(TDATA(interaction.channelId));
          await safeReply(interaction, { content: "✅ Ticket kapatılıyor…", ephemeral: true });

          await interaction.channel.delete().catch(() => {});
        }
      }
    } catch (e) {
      console.error("TICKET ERROR:", e);
      if (interaction?.isRepliable?.()) {
        await safeReply(interaction, { content: "Hata oldu (konsola bak).", ephemeral: true });
      }
    }
  });
};
