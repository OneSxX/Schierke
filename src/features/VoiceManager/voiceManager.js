/**
 * voiceManager.js — MULTI-SUNUCU (GUILD) DESTEKLİ
 * - /setcreate ile join-to-create kanalını DB'ye kaydeder
 * - Join-to-create kanalına giren kullanıcıya temp oda açar, kullanıcıyı taşır
 * - Panel/izin/limit/lock/rename/clear yönetimi (voice kanal chat'inde)
 * - Ticket butonlarıyla çakışmayı engeller (t_ prefix)
 *
 * FIX ✅:
 * - Panelden yapılan tüm işlemler artık interaction.member.voice.channel yerine
 *   panelin bulunduğu voice channel (interaction.channelId) üzerinden yapılır.
 * - customId'lere kanalId gömülür (btn_/sel_/m_ ... :<channelId>) (ek güvenlik)
 */

const {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

// -------------------- DB Keys --------------------
const VC_KEY = (id) => `vc_${id}`; // voice kanal state (panelChannel.id = voice.id)
const TEMP_TEMPLATE_KEY = (gid) => `temp_template_${gid}`;
const USER_TPL_KEY = (gid, userId) => `user_tpl_${gid}_${userId}`;
const GUILD_CFG_KEY = (gid) => `guild_cfg_${gid}`;

// -------------------- Helpers --------------------
const uniq = (arr) => Array.from(new Set(arr || []));

function isServerOwnerOrAdmin(member) {
  if (!member?.guild) return false;
  if (member.id === member.guild.ownerId) return true;
  return member.permissions.has(PermissionFlagsBits.Administrator);
}
function isRoomOwner(memberId, data) {
  return data?.ownerId === memberId;
}
function isRoomMod(memberId, data) {
  return (data?.mods || []).includes(memberId);
}
function canManageRoom(member, data) {
  return isServerOwnerOrAdmin(member) || isRoomOwner(member.id, data);
}
function canEditAllowDeny(member, data) {
  return isServerOwnerOrAdmin(member) || isRoomOwner(member.id, data) || isRoomMod(member.id, data);
}

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) return await interaction.editReply(payload);
    return await interaction.reply(payload);
  } catch (e) {
    if (e?.code === 10062) return; // Unknown interaction
    if (e?.code === 40060) return; // already acknowledged
    console.error("safeReply error:", e);
  }
}
async function safeFollowUp(interaction, payload) {
  try {
    return await interaction.followUp(payload);
  } catch (e) {
    if (e?.code === 10062) return;
    if (e?.code === 40060) return;
    console.error("safeFollowUp error:", e);
  }
}

// -------------------- Voice perms --------------------
async function applyVoicePerms(guild, voice, data) {
  // @everyone connect
  await voice.permissionOverwrites
    .edit(guild.roles.everyone, { Connect: data.locked ? false : true })
    .catch(() => {});

  // deny list
  for (const id of data.deny || []) {
    await voice.permissionOverwrites.edit(id, { Connect: false }).catch(() => {});
  }

  // allow list
  for (const id of data.allow || []) {
    await voice.permissionOverwrites.edit(id, { Connect: true }).catch(() => {});
  }

  // owner + mods always connect
  await voice.permissionOverwrites.edit(data.ownerId, { Connect: true }).catch(() => {});
  for (const id of data.mods || []) {
    await voice.permissionOverwrites.edit(id, { Connect: true }).catch(() => {});
  }
}

// -------------------- Panel UI --------------------
function buildPanelComponents(data, targetChannelId) {
  const ownerSel = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`sel_owner:${targetChannelId}`)
      .setPlaceholder("👑 Oda sahibi seç")
      .setMinValues(1)
      .setMaxValues(1)
      .addDefaultUsers(data.ownerId)
  );

  const modsSel = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`sel_mods:${targetChannelId}`)
      .setPlaceholder("🛠️ Oda yetkilileri seç")
      .setMinValues(0)
      .setMaxValues(10)
      .addDefaultUsers(...(data.mods || []).slice(0, 10))
  );

  const allowSel = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`sel_allow:${targetChannelId}`)
      .setPlaceholder("✅ Odaya girebilecek kullanıcılar")
      .setMinValues(0)
      .setMaxValues(25)
      .addDefaultUsers(...(data.allow || []).slice(0, 25))
  );

  const denySel = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`sel_deny:${targetChannelId}`)
      .setPlaceholder("⛔ Reddedilecek kullanıcılar")
      .setMinValues(0)
      .setMaxValues(25)
      .addDefaultUsers(...(data.deny || []).slice(0, 25))
  );

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_lock:${targetChannelId}`).setEmoji("🔒").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`btn_unlock:${targetChannelId}`).setEmoji("🔓").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_limit:${targetChannelId}`).setEmoji("👥").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`btn_rename:${targetChannelId}`).setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_clear:${targetChannelId}`).setEmoji("🧹").setStyle(ButtonStyle.Secondary)
  );

  return [ownerSel, modsSel, allowSel, denySel, buttons];
}

const panelTimers = new Map();
async function upsertPanel(panelChannel, data, db) {
  // Voice channel chat desteklenmiyorsa sessizce çık
  if (!panelChannel?.isTextBased?.()) return;

  const doEdit = async () => {
    const content = `**Voice Manager** • ${data.locked ? "🔒 Kilitli" : "🔓 Açık"} • Limit: **${data.userLimit ?? 0}**`;
    const components = buildPanelComponents(data, panelChannel.id);

    let msg = null;
    if (data.panelMessageId) {
      try {
        msg = await panelChannel.messages.fetch(data.panelMessageId);
      } catch (e) {
        msg = null;
      }
    }

    if (!msg) {
      msg = await panelChannel.send({ content, components });
      data.panelMessageId = msg.id;
      await db.set(VC_KEY(panelChannel.id), data);
      try {
        await msg.pin();
      } catch (e) {
        // ignore
      }
    } else {
      await msg.edit({ content, components }).catch(() => {});
      try {
        if (!msg.pinned) await msg.pin();
      } catch (e) {
        // ignore
      }
    }
  };

  clearTimeout(panelTimers.get(panelChannel.id));
  return new Promise((resolve) => {
    const t = setTimeout(async () => {
      panelTimers.delete(panelChannel.id);
      await doEdit();
      resolve();
    }, 500);
    panelTimers.set(panelChannel.id, t);
  });
}

async function autoUpdateTempTemplateFromChannel(db, guildId, voice, data) {
  if (!data || data.persistent) return;
  await db.set(TEMP_TEMPLATE_KEY(guildId), {
    mods: uniq(data.mods || []),
    allow: uniq(data.allow || []),
    deny: uniq(data.deny || []),
    locked: !!data.locked,
    userLimit: Number.isInteger(data.userLimit) ? data.userLimit : voice.userLimit ?? 0,
  });
}

async function afterChange(db, guild, voice, data, panelChannel) {
  await db.set(VC_KEY(panelChannel.id), data);
  await applyVoicePerms(guild, voice, data);
  await upsertPanel(panelChannel, data, db);
  await autoUpdateTempTemplateFromChannel(db, guild.id, voice, data);
}

// -------------------- Interaction helpers --------------------
function extractTargetChannelIdFromCustomId(customId) {
  if (!customId || typeof customId !== "string") return null;
  const parts = customId.split(":");
  if (parts.length < 2) return null;
  const maybeId = parts[1];
  return /^\d{15,25}$/.test(maybeId) ? maybeId : null;
}

/**
 * ✅ FINAL FIX:
 * Panel voice channel chat'inde çalıştığı için hedef kanal her zaman interaction.channelId'dir.
 * customId'deki id sadece "ek güvenlik" olarak tutulur.
 */
async function getManaged(db, interaction) {
  // 1) Panelin bulunduğu kanal (voice chat)
  const panelChannel = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  if (!panelChannel || panelChannel.type !== ChannelType.GuildVoice) {
    return { error: "Panel sadece voice kanal chat'inde kullanılabilir." };
  }

  // 2) Ek doğrulama: customId'deki kanalId farklıysa bile panelChannel'i esas al
  const customId = interaction.customId || "";
  const hintedId = extractTargetChannelIdFromCustomId(customId);
  if (hintedId && hintedId !== panelChannel.id) {
    // Eski mesaj / kopyalanmış panel gibi durumlarda güvenlik için ignore ediyoruz.
    // İstersen burada log basabilirsin.
  }

  const voice = panelChannel;

  // 3) Bu voice yönetiliyor mu?
  const data = await db.get(VC_KEY(panelChannel.id));
  if (!data) return { error: "Bu voice kanal bot tarafından yönetilmiyor." };

  return { voice, panelChannel, data };
}

// ==================== EXPORT: REGISTER ====================
module.exports = function registerVoiceManager(client, db) {
  // -------------------- VOICE STATE --------------------
  client.on("voiceStateUpdate", async (oldState, newState) => {
    try {
      if (!newState.guild || !newState.member) return;

      // 1) Join-to-create: kullanıcı create kanalına girdi mi?
      const gcfg = await db.get(GUILD_CFG_KEY(newState.guild.id));
      const createId = gcfg?.createChannelId;
      if (createId && newState.channelId === createId) {
        const guild = newState.guild;
        const parentId = newState.channel?.parentId ?? null;

        // sunucuya özel template
        let baseTpl = await db.get(TEMP_TEMPLATE_KEY(guild.id));
        if (!baseTpl) {
          baseTpl = { mods: [], allow: [], deny: [], locked: false, userLimit: 0 };
          await db.set(TEMP_TEMPLATE_KEY(guild.id), baseTpl);
        }

        const displayName = newState.member.displayName || newState.member.user.username;
        const userTpl = await db.get(USER_TPL_KEY(guild.id, newState.member.id));
        const channelName =
          userTpl?.name && String(userTpl.name).trim().length > 0
            ? String(userTpl.name).trim()
            : `📍・${displayName} Odası`;

        const voice = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildVoice,
          parent: parentId,
        });

        // kullanıcıyı hemen taşı
        await newState.member.voice.setChannel(voice).catch(() => {});

        // limit uygula
        const limit = Number.isInteger(baseTpl?.userLimit) ? baseTpl.userLimit : 0;
        await voice.setUserLimit(limit).catch(() => {});

        const panelChannel = voice;

        const data = {
          ownerId: newState.member.id,
          mods: uniq(baseTpl?.mods || []),
          allow: uniq(baseTpl?.allow || []),
          deny: uniq(baseTpl?.deny || []),
          locked: !!baseTpl?.locked,
          userLimit: limit,
          persistent: false,
          panelMessageId: null,
        };

        await db.set(VC_KEY(panelChannel.id), data);

        // perms & panel arkadan
        applyVoicePerms(guild, voice, data).catch(() => {});
        upsertPanel(panelChannel, data, db).catch(() => {});
      }

      // 2) temp oda boşsa sil
      if (oldState.channel) {
        const data = await db.get(VC_KEY(oldState.channel.id));
        if (data && !data.persistent && oldState.channel.members.size === 0) {
          await db.delete(VC_KEY(oldState.channel.id));
          await oldState.channel.delete().catch(() => {});
        }
      }
    } catch (e) {
      console.error("[VoiceManager voiceStateUpdate]", e);
    }
  });

  // -------------------- INTERACTIONS (VOICE) --------------------
  client.on("interactionCreate", async (interaction) => {
    try {
      // Ticket butonlarını komple es geç (t_open_complaint, t_close, vs)
      if (interaction.isButton()) {
        const id = interaction.customId || "";
        if (id.startsWith("t_")) return;
      }

      // -------- SLASH --------
      if (interaction.isChatInputCommand()) {
        const allowed = new Set(["setcreate", "setup", "panel", "kapat"]);
        if (!allowed.has(interaction.commandName)) return;

        // /setcreate (voice gerekmez)
        if (interaction.commandName === "setcreate") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          if (!isServerOwnerOrAdmin(interaction.member)) {
            return safeReply(interaction, { content: "Bu komutu sadece admin/sunucu sahibi kullanabilir.", ephemeral: true });
          }

          const ch = interaction.options.getChannel("kanal", true);
          if (ch.type !== ChannelType.GuildVoice) {
            return safeReply(interaction, { content: "Lütfen bir **VOICE kanal** seç.", ephemeral: true });
          }

          await db.set(GUILD_CFG_KEY(interaction.guildId), { createChannelId: ch.id });

          const tpl = await db.get(TEMP_TEMPLATE_KEY(interaction.guildId));
          if (!tpl) {
            await db.set(TEMP_TEMPLATE_KEY(interaction.guildId), {
              mods: [],
              allow: [],
              deny: [],
              locked: false,
              userLimit: 0,
            });
          }

          return safeReply(interaction, { content: `✅ Join-to-create ayarlandı: **${ch.name}**`, ephemeral: true });
        }

        // diğer slashlar voice ister (kalıcı panel kuracağın kanalın içinde olman yeter)
        const voice = interaction.member?.voice?.channel;
        if (!voice) {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          return safeReply(interaction, { content: "Voice kanalda değilsin.", ephemeral: true });
        }

        const panelChannel = voice;

        if (interaction.commandName === "setup") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          if (!isServerOwnerOrAdmin(interaction.member)) {
            return safeReply(interaction, { content: "Bu komutu sadece admin/sunucu sahibi kullanabilir.", ephemeral: true });
          }

          const data = {
            ownerId: interaction.member.id,
            mods: [],
            allow: [],
            deny: [],
            locked: false,
            userLimit: voice.userLimit ?? 0,
            persistent: true,
            panelMessageId: null,
          };

          await db.set(VC_KEY(panelChannel.id), data);
          await applyVoicePerms(interaction.guild, voice, data);
          await upsertPanel(panelChannel, data, db);

          return safeReply(interaction, { content: "✅ Kalıcı panel kuruldu.", ephemeral: true });
        }

        if (interaction.commandName === "panel") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          const data = await db.get(VC_KEY(panelChannel.id));
          if (!data) return safeReply(interaction, { content: "Bu kanal yönetilmiyor.", ephemeral: true });

          if (!canManageRoom(interaction.member, data)) {
            return safeReply(interaction, { content: "Paneli sadece oda sahibi veya admin güncelleyebilir.", ephemeral: true });
          }

          await upsertPanel(panelChannel, data, db);
          return safeReply(interaction, { content: "✅ Panel güncellendi.", ephemeral: true });
        }

        if (interaction.commandName === "kapat") {
          await interaction.deferReply({ ephemeral: true }).catch(() => {});
          if (!isServerOwnerOrAdmin(interaction.member)) {
            return safeReply(interaction, { content: "Bu komutu sadece admin/sunucu sahibi kullanabilir.", ephemeral: true });
          }
          const data = await db.get(VC_KEY(panelChannel.id));
          if (!data) return safeReply(interaction, { content: "Bu kanal yönetilmiyor.", ephemeral: true });

          await db.delete(VC_KEY(panelChannel.id));
          return safeReply(interaction, { content: "🛑 Yönetim kapatıldı.", ephemeral: true });
        }

        return;
      }

      // -------- SELECT MENUS --------
      if (interaction.isUserSelectMenu()) {
        if (!interaction.customId?.startsWith("sel_")) return;

        const pack = await getManaged(db, interaction);
        if (pack.error) return safeReply(interaction, { content: pack.error, ephemeral: true });

        const { voice, panelChannel, data } = pack;
        await interaction.deferUpdate().catch(() => {});

        const base = interaction.customId.split(":")[0];

        if (base === "sel_owner") {
          if (!canManageRoom(interaction.member, data)) {
            return safeFollowUp(interaction, { content: "Sahibi sadece owner veya admin değiştirebilir.", ephemeral: true });
          }
          data.ownerId = interaction.values[0];
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeFollowUp(interaction, { content: "👑 Sahip güncellendi.", ephemeral: true });
        }

        if (base === "sel_mods") {
          if (!canManageRoom(interaction.member, data)) {
            return safeFollowUp(interaction, { content: "Yetkilileri sadece owner veya admin değiştirebilir.", ephemeral: true });
          }
          data.mods = uniq(interaction.values).slice(0, 10);
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeFollowUp(interaction, { content: "🛠️ Yetkililer güncellendi.", ephemeral: true });
        }

        if (base === "sel_allow") {
          if (!canEditAllowDeny(interaction.member, data)) {
            return safeFollowUp(interaction, { content: "Allow listesini sadece owner/yetkili veya admin değiştirebilir.", ephemeral: true });
          }
          data.allow = uniq(interaction.values).slice(0, 25);
          data.deny = (data.deny || []).filter((x) => !data.allow.includes(x));
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeFollowUp(interaction, { content: "✅ Girebilenler güncellendi.", ephemeral: true });
        }

        if (base === "sel_deny") {
          if (!canEditAllowDeny(interaction.member, data)) {
            return safeFollowUp(interaction, { content: "Deny listesini sadece owner/yetkili veya admin değiştirebilir.", ephemeral: true });
          }
          data.deny = uniq(interaction.values).slice(0, 25);
          data.allow = (data.allow || []).filter((x) => !data.deny.includes(x));

          for (const id of data.deny) {
            const m = await interaction.guild.members.fetch(id).catch(() => null);
            if (m && m.voice.channelId === voice.id) await m.voice.disconnect().catch(() => {});
          }

          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeFollowUp(interaction, { content: "⛔ Giremeyenler güncellendi.", ephemeral: true });
        }

        return;
      }

      // -------- BUTTONS --------
      if (interaction.isButton()) {
        const id = interaction.customId || "";
        if (id.startsWith("t_")) return;
        if (!id.startsWith("btn_")) return;

        const pack = await getManaged(db, interaction);
        if (pack.error) return safeReply(interaction, { content: pack.error, ephemeral: true });

        const { voice, panelChannel, data } = pack;
        const base = id.split(":")[0];

        if (base === "btn_limit") {
          if (!canManageRoom(interaction.member, data)) return safeReply(interaction, { content: "Sadece owner/admin.", ephemeral: true });

          const modal = new ModalBuilder().setCustomId(`m_limit:${voice.id}`).setTitle("Kullanıcı Limiti");
          const input = new TextInputBuilder()
            .setCustomId("limit")
            .setLabel("Limit (0 = sınırsız)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(2);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        if (base === "btn_rename") {
          if (!canManageRoom(interaction.member, data)) return safeReply(interaction, { content: "Sadece owner/admin.", ephemeral: true });

          const modal = new ModalBuilder().setCustomId(`m_rename:${voice.id}`).setTitle("Oda İsmi");
          const input = new TextInputBuilder()
            .setCustomId("name")
            .setLabel("Yeni oda ismi")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        if (!canManageRoom(interaction.member, data)) {
          return safeReply(interaction, { content: "Bu butonları sadece owner/admin kullanabilir.", ephemeral: true });
        }

        if (base === "btn_lock") {
          data.locked = true;
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeReply(interaction, { content: "🔒 Kilitlendi.", ephemeral: true });
        }

        if (base === "btn_unlock") {
          data.locked = false;
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeReply(interaction, { content: "🔓 Açıldı.", ephemeral: true });
        }

        if (base === "btn_clear") {
          data.mods = [];
          data.allow = [];
          data.deny = [];
          data.locked = false;
          data.userLimit = 0;
          await voice.setUserLimit(0).catch(() => {});
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeReply(interaction, { content: "🧹 Temizlendi.", ephemeral: true });
        }

        return;
      }

      // -------- MODALS --------
      if (interaction.isModalSubmit()) {
        const id = interaction.customId || "";
        if (!id.startsWith("m_")) return;

        await interaction.deferReply({ ephemeral: true }).catch(() => {});

        const pack = await getManaged(db, interaction);
        if (pack.error) return safeReply(interaction, { content: pack.error, ephemeral: true });

        const { voice, panelChannel, data } = pack;

        if (!canManageRoom(interaction.member, data)) {
          return safeReply(interaction, { content: "Sadece owner/admin.", ephemeral: true });
        }

        const base = id.split(":")[0];

        if (base === "m_limit") {
          const limit = parseInt((interaction.fields.getTextInputValue("limit") || "").trim(), 10);
          if (Number.isNaN(limit) || limit < 0 || limit > 99) return safeReply(interaction, { content: "0-99 arası sayı gir.", ephemeral: true });

          data.userLimit = limit;
          await voice.setUserLimit(limit).catch(() => {});
          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeReply(interaction, { content: `👥 Limit: ${limit}`, ephemeral: true });
        }

        if (base === "m_rename") {
          const name = (interaction.fields.getTextInputValue("name") || "").trim();
          if (!name) return safeReply(interaction, { content: "İsim boş olamaz.", ephemeral: true });

          await voice.setName(name).catch(() => {});
          await db.set(USER_TPL_KEY(interaction.guildId, data.ownerId), { name });

          await afterChange(db, interaction.guild, voice, data, panelChannel);
          return safeReply(interaction, { content: `✏️ İsim: ${name}`, ephemeral: true });
        }

        return;
      }
    } catch (e) {
      console.error("[VoiceManager interactionCreate fatal]", e);
      if (interaction?.isRepliable?.()) {
        await safeReply(interaction, { content: "Hata oldu (konsola bak).", ephemeral: true });
      }
    }
  });
};

// dışa açmak istersen:
module.exports.applyVoicePerms = applyVoicePerms;
module.exports.upsertPanel = upsertPanel;
module.exports.VC_KEY = VC_KEY;
module.exports.TEMP_TEMPLATE_KEY = TEMP_TEMPLATE_KEY;
