async function registerGlobalCommands(appId, token) {
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;

  const body = [
    // =========================
    // VOICE MANAGER KOMUTLARI
    // =========================
    {
      name: "setcreate",
      description: "Join-to-create (oda açma) voice kanalını ayarla",
      type: 1,
      options: [
        {
          name: "kanal",
          description: "Oda oluşturma voice kanalı",
          type: 7, // CHANNEL
          required: true,
          // ✅ Sadece voice seçilsin
          channel_types: [2], // 2 = GUILD_VOICE
        },
      ],
    },

    {
      name: "setup",
      description: "Seçilen voice kanalına panel ile yönetim kur (kalıcı).",
      type: 1,
      options: [
        {
          name: "kanal",
          description: "Hedef voice kanal (boşsa bulunduğun kanal)",
          type: 7, // CHANNEL
          required: false,
          channel_types: [2], // GUILD_VOICE
        },
      ],
    },

    {
      name: "panel",
      description: "Seçilen voice kanala paneli bas/güncelle.",
      type: 1,
      options: [
        {
          name: "kanal",
          description: "Hedef voice kanal (boşsa bulunduğun kanal)",
          type: 7,
          required: false,
          channel_types: [2],
        },
      ],
    },

    {
      name: "kapat",
      description: "Seçilen voice kanalın yönetimini kapat (admin).",
      type: 1,
      options: [
        {
          name: "kanal",
          description: "Hedef voice kanal (boşsa bulunduğun kanal)",
          type: 7,
          required: false,
          channel_types: [2],
        },
      ],
    },

    // =========================
    // TICKET KOMUTLARI (istersen)
    // =========================
    {
      name: "ticket",
      description: "Ticket sistemi",
      type: 1,
      options: [
        {
          type: 1,
          name: "setup",
          description: "Ticket panel ayarlarını kur",
          options: [
            { name: "panel", description: "Ticket panelin atılacağı kanal", type: 7, required: true },
            { name: "kategori", description: "Ticket kanallarının açılacağı kategori (opsiyonel)", type: 7, required: false },
            { name: "yetkili_rol", description: "Yetkili rol (opsiyonel)", type: 8, required: false },
          ],
        },
        { type: 1, name: "panel", description: "Ticket panelini bas/güncelle" },
        { type: 1, name: "off", description: "Ticket sistemini kapat" },
      ],
    },
  ];

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Global slash register failed (${res.status}): ${txt}`);
  }

  console.log("✅ Global slash komutları register.js ile kaydedildi.");
}

module.exports = { registerGlobalCommands };
