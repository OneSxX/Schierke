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

// Log kanalına mesaj at
async function sendTicketLog(guild, logChannelId, payload) {
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
      })
      .catch(() => {});
  }
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
          const panelCh = interaction.options.getChannel("panel", true);
          const logCh = interaction.options.getChannel("log", true); // zorunlu
          const kategori = interaction.options.getChannel("kategori", false);
          const yetkiliRol = interaction.options.getRole("yetkili_rol", false);

          if (panelCh.type !== ChannelType.GuildText) {
            return safeReply(interaction, { content: "Panel kanalı bir **yazı kanalı** olmalı.", ephemeral: true });
          }
          if (logCh.type !== ChannelType.GuildText) {
            return safeReply(interaction, { content: "Log kanalı bir **yazı kanalı** olmalı.", ephemeral: true });
          }
          if (kategori && kategori.type !== ChannelType.GuildCategory) {
            return safeReply(interaction, { content: "Kategori seçersen **kategori** olmalı.", ephemeral: true });
          }

          await ensurePanelPerms(interaction.guild, panelCh);
          await ensureLogPerms(interaction.guild, logCh, yetkiliRol?.id || null);

          await db.set(TCFG(interaction.guildId), {
            panelChannelId: panelCh.id,
            categoryId: kategori?.id || null,
            staffRoleId: yetkiliRol?.id || null,
            logChannelId: logCh.id,
          });

          return safeReply(interaction, {
            content:
              `✅ Ticket sistemi kuruldu.\n` +
              `• Panel: <#${panelCh.id}>\n` +
              `• Log: <#${logCh.id}>\n` +
              `• Kategori: ${kategori ? `<#${kategori.id}>` : "Yok"}\n` +
              `• Yetkili rol: ${yetkiliRol ? `<@&${yetkiliRol.id}>` : "Yok"}\n\n` +
              `ℹ️ Panel kanalı herkes görebilir. Log kanalı sadece yetkililer görebilir.`,
            ephemeral: true,
          });
        }

        // /ticket panel
        if (sub === "panel") {
          const cfg = await db.get(TCFG(interaction.guildId));
          if (!cfg?.panelChannelId) {
            return safeReply(interaction, { content: "Önce `/ticket setup` yap.", ephemeral: true });
          }

          const panelCh = await interaction.guild.channels.fetch(cfg.panelChannelId).catch(() => null);
          if (!panelCh?.isTextBased?.()) {
            return safeReply(interaction, { content: "Panel kanalı bulunamadı. `/ticket setup` tekrar yap.", ephemeral: true });
          }

          await ensurePanelPerms(interaction.guild, panelCh);

          await panelCh.send({ embeds: [panelEmbed()], components: panelComponents() });
          return safeReply(interaction, { content: "✅ Ticket panel basıldı.", ephemeral: true });
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

          return safeReply(interaction, { content: `✅ Ticket açıldı: <#${ch.id}>`, ephemeral: true });
        }

        // Modal: ticket kapat + LOG
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