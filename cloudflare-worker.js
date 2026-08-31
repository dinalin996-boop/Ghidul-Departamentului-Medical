export default {  async fetch(request, env, ctx) {
    const allowedOrigins = [
      'https://ghidul-departamentului-medical-eight.vercel.app',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];
    const requestOrigin = request.headers.get('Origin');
    const configuredOrigin = env.ALLOWED_ORIGIN;
    const allowedOrigin = allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : configuredOrigin && allowedOrigins.includes(configuredOrigin)
        ? configuredOrigin
        : allowedOrigins[0];
    const headers = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Vary': 'Origin'
    };
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    try {
      if (request.method === 'GET') {
        const stored = env.RP_KV ? await env.RP_KV.get('state_v3') : null;
        return jsonResponse(stored ? JSON.parse(stored) : emptyState());
      }

      if (request.method !== 'POST') return jsonResponse({ error: 'Metodă netratată' }, 405);
      let data;
      try { data = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { type, action, state, logData } = data;
      const WEBHOOK_REPARTIZARE = env.WEBHOOK_REPARTIZARE || '';
      const WEBHOOK_LOGURI = env.WEBHOOK_LOGURI || '';

      if (type === 'assign' && state !== undefined) {
        if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(state));
        if (WEBHOOK_REPARTIZARE) ctx.waitUntil(updateRepartizareEmbed(WEBHOOK_REPARTIZARE, state, env));
        return jsonResponse({ success: true, message: 'Starea a fost sincronizată.' });
      }

      const activeAction = action || logData;
      if (WEBHOOK_LOGURI && type === 'log_batch' && Array.isArray(data.logs)) {
        data.logs.forEach(log => ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, log)));
      } else if (WEBHOOK_LOGURI && activeAction) {
        ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, activeAction));
      }

      if (state !== undefined && env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(state));
      return jsonResponse({ success: true, message: 'Procesat cu succes.' });
    } catch (error) {
      return jsonResponse({ error: 'Eroare Worker: ' + error.message }, 500);
    }
  }
};

function emptyState() {
  return { 'Zona 1': [], 'Zona 2': [], 'Zona 3': [], 'Zona 4': [], Spital: [] };
}

async function sendSeparateLog(webhookUrl, act = {}) {
  const actionType = act.action || act.type;
  const config = {
    join: ['🟢 Intrare pe tură', 0x10B981, 'Un medic s-a arondat pe o zonă/spital.'],
    move: ['🔁 Schimbare Zonă', 0x7C3AED, 'Un medic și-a schimbat zona.'],
    admin_add: ['🔵 Adăugare în Repartizare', 0x2563EB, `Un medic a fost adăugat de către **${act.by || 'un superior'}**`],
    leave: ['🔴 Ieșire de pe tură', 0xEF4444, 'Un medic a părăsit zona.'],
    kick: ['⚠️ Kick de pe tură', 0xF59E0B, `Un medic a fost scos de către **${act.by || 'un superior'}**`],
    removed: ['⚠️ Kick de pe tură', 0xF59E0B, `Un medic a fost scos de către **${act.by || 'un superior'}**`],
    clear_all: ['🔄 Resetare Tură', 0xEF4444, `Toti medicii au fost scosi de către **${act.by || 'Admin'}**`],
    reset: ['🔄 Resetare Tură', 0xEF4444, `Toti medicii au fost scosi de către **${act.by || 'Admin'}**`]
  };
  const [title, color, description] = config[actionType] || ['📋 Acțiune Repartizare', 0x245AB1, 'A fost înregistrată o acțiune în repartizare.'];
  const fields = [];
  if (actionType !== 'clear_all' && actionType !== 'reset') {
    fields.push({ name: '🥼 Medic', value: `**${act.callSign || act.badge || 'M-???'}** (${act.name || 'Necunoscut'})`, inline: false });
    if (act.discordId) fields.push({ name: '🤖Discord', value: `<@${act.discordId}>`, inline: false });
    fields.push({ name: '📍 Zonă', value: `**${act.zone || 'Nespecificată'}**`, inline: false });
    if (actionType === 'move' && act.fromZone) fields.push({ name: '↔️ Zona anterioară', value: `**${act.fromZone}**`, inline: false });
    if (act.partner) fields.push({ name: '🤝 Partener', value: `\`${act.partner}\``, inline: false });
    if (act.by) fields.push({ name: '🛡️ Modificare facuta de', value: `**${act.by}**`, inline: false });
  } else fields.push({ name: '⚙️ Efectuat de', value: `**${act.by || 'Admin'}**`, inline: false });
  await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Loguri ZONE',
      avatar_url: 'https://imgur.com/a/JRWgtRs',
      content: act.discordId ? `<@${act.discordId}>` : undefined,
      allowed_mentions: { parse: [] },
      embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }]
    })
  });
}

async function updateRepartizareEmbed(webhookUrl, state, env) {
  const fields = [];
  let totalMedici = 0;
  Object.keys(state || {}).forEach(zone => {
    const members = Array.isArray(state[zone]) ? state[zone] : [];
    totalMedici += members.length;
    fields.push({ name: `📍 ${zone} (${members.length})`, value: members.length ? members.map(m => `• **${m.callSign || m.badge || 'M-???'}** ${m.name || 'Necunoscut'}${m.partner ? ` *(cu ${m.partner})*` : ''}`).join('\n') : '_Niciun medic arondat_', inline: false });
  });
  fields.push({ name: '🥼 Total medici pe teren', value: `**${totalMedici}** cadre medicale active`, inline: false });
  const payload = { username: 'Repartizare LIVE', avatar_url: 'https://imgur.com/a/JRWgtRs', embeds: [{ title: '🩺Medicii repartizați pe zone.', description: 'Mai jos este lista cu medicii pe tura.', color: 0x245AB1, fields, timestamp: new Date().toISOString() }] };
  const messageId = env.RP_KV ? await env.RP_KV.get('discord_live_msg_id') : null;
  if (messageId) {
    const editRes = await fetch(`${webhookUrl}/messages/${messageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (editRes.ok) return;
  }
  const sendRes = await fetch(`${webhookUrl}?wait=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (sendRes.ok && env.RP_KV) {
    const result = await sendRes.json();
    if (result.id) await env.RP_KV.put('discord_live_msg_id', result.id);
  }
}
