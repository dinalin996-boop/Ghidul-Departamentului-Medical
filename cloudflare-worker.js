// Cloudflare Worker - Webhook Relay (Optional)
// Dacă vrei să trimiti webhook-uri prin Cloudflare Worker

export default {
  async fetch(request, env, ctx) {
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://ghidul-departamentului-medical-eight.vercel.app';
    const headers = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json'
    };
    const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });

    if (request.method === 'OPTIONS') return new Response(null, { headers });

    const authHeader = request.headers.get('Authorization');
    const expectedToken = env.WORKER_AUTH_TOKEN;
    if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    try {
      if (request.method === 'GET') {
        const stored = env.RP_KV ? await env.RP_KV.get('state_v3') : null;
        return jsonResponse(stored ? JSON.parse(stored) : emptyState());
      }

      if (request.method !== 'POST') return jsonResponse({ error: 'Metodă netratată' }, 405);
      let data;
      try { data = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { type, data: webhookData, action, state, logData } = data;
      const WEBHOOK_REPARTIZARE = env.WEBHOOK_REPARTIZARE || '';
      const WEBHOOK_LOGURI = env.WEBHOOK_LOGURI || env.DISCORD_WEBHOOK_LOGS || '';

      // Fluxurile HR/debug/msg/request rămân exact pe webhookurile lor dedicate.
      const untouchedWebhook = type === 'request' ? env.DISCORD_WEBHOOK_REQUEST
        : type === 'msg' ? env.DISCORD_WEBHOOK_MSG
        : type === 'hr' ? env.DISCORD_WEBHOOK_HR
        : type === 'debug' ? env.DISCORD_WEBHOOK_DEBUG : '';
      if (untouchedWebhook && webhookData) {
        const relay = await fetch(untouchedWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhookData) });
        return jsonResponse({ success: relay.ok }, relay.ok ? 200 : 400);
      }

      // Webhookurile HR/debug/msg/request nu sunt atinse de acest Worker.
      if (type === 'assign' && state !== undefined) {
        if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(state));
        if (WEBHOOK_REPARTIZARE) ctx.waitUntil(updateRepartizareEmbed(WEBHOOK_REPARTIZARE, state, env));
        return jsonResponse({ success: true, message: 'Starea a fost sincronizată.' });
      }

      const activeAction = action || logData;
      if ((type === 'log_batch' || activeAction) && WEBHOOK_LOGURI) {
        if (type === 'log_batch' && Array.isArray(data.logs)) {
          data.logs.forEach(log => ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, log)));
        } else {
          ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, activeAction));
        }
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

/* Codul vechi de construire a unui webhook batch nu mai este folosit. */
/*
        if (type === 'log_batch') {
          // Logurile de arondare/ieșire/conducere merg exclusiv în canalul de loguri.
          const logs = Array.isArray(data.logs) ? data.logs : [];
          const actionNames = {
            join: 's-a arondat',
            leave: 'a părăsit zona',
            kick: 'a fost scos din zonă de conducere',
            clear_all: 'a resetat toată tura'
          };
          payload = {
            embeds: [{
              title: '📋 Log Arondare',
              description: logs.length
                ? logs.map(log => {
                    const actor = log.by ? ` (de ${log.by})` : '';
                    const zoneText = log.zone ? ` pe **${log.zone}**` : '';
                    const partnerText = log.partner ? ` — Patrulă cu **${log.partner}**` : '';
                    return `• **${log.callSign || 'N/A'}** — ${actionNames[log.action] || log.action || 'acțiune'}${zoneText}${partnerText}${actor}`;
                  }).join('\\n')
                : 'Nu există acțiuni de logat.',
              color: 3066993,
              footer: { text: `Actualizat la ${new Date().toLocaleString('ro-RO')}` }
            }]
          };
          webhookUrl = WEBHOOK_LOGURI;
        } else if (type === 'log') {
          // Compatibilitate pentru apelurile vechi; nu afectează webhook-ul de repartizare.
          payload = {
            embeds: [{
              title: '📋 Log Arondare',
              fields: [
                { name: 'Call-Sign', value: callSign || 'N/A', inline: true },
                { name: 'Nume', value: data.name || 'N/A', inline: true },
                { name: 'Discord ID', value: discordId || 'N/A', inline: true },
                { name: 'Zonă', value: zone || 'N/A', inline: false },
                { name: 'Patrulă', value: partner || 'N/A', inline: true },
                { name: 'Oră', value: new Date().toLocaleString('ro-RO'), inline: true }
              ],
              color: 3066993
            }]
          };
          webhookUrl = WEBHOOK_LOGURI;
        }

        if (!webhookUrl || webhookUrl.includes('YOUR_WEBHOOK_ID')) {
          return new Response(JSON.stringify({ success: false, error: 'Configurează URL-urile webhook în Cloudflare Worker.' }), { status: 503, headers });
        }

        // Trimite la Discord
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (response.ok) {
          return new Response(JSON.stringify({ success: true }), { headers });
        } else {
          return new Response(JSON.stringify({ error: 'Webhook failed' }), {
            status: 400,
            headers
          });
        }
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers
        });
      }
    }

    return new Response('Method not allowed', { status: 405, headers });
  }
};
*/

// Funcțiile active pentru loguri și tabloul live sunt definite mai jos.

/*
SETUP CLOUDFLARE WORKER:

1. Mergi pe https://dash.cloudflare.com/
2. Workers & Pages → Create Application → Create Worker
3. Copiază codul de mai sus
4. Settings → Variables and Secrets → adaugă `WEBHOOK_REPARTIZARE` și `WEBHOOK_LOGURI`
5. Deploy

FOLOSIRE DIN FRONTEND:

const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev'; // setează aceeași adresă în RP_CONFIG.WORKER_URL din index.html

// Trimite repartizare
await fetch(WORKER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'assign',
    callSign: 'M-007',
    zone: 'Spital',
    partner: 'M-001'
  })
});

// Trimite log
await fetch(WORKER_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'log',
    discordId: '123456789',
    callSign: 'M-007',
    zone: 'Spital',
    partner: 'M-001'
  })
});
*/

async function sendSeparateLog(webhookUrl, act = {}) {
  const actionType = act.action || act.type;
  const config = {
    join: ['🟢 Intrare în Zonă', 0x10B981, 'Un cadru medical s-a arondat pe o zonă/spital.'],
    admin_add: ['🔵 Adăugare în Repartizare', 0x2563EB, `Un cadru medical a fost adăugat de către **${act.by || 'un superior'}**`],
    leave: ['🔴 Ieșire din Zonă', 0xEF4444, 'Un cadru medical a părăsit zona.'],
    kick: ['⚠️ Dat afară din Zonă', 0xF59E0B, `Un cadru medical a fost scos de către **${act.by || 'un superior'}**`],
    removed: ['⚠️ Dat afară din Zonă', 0xF59E0B, `Un cadru medical a fost scos de către **${act.by || 'un superior'}**`],
    clear_all: ['🔄 Resetare Generală Tură', 0xEF4444, `Toate turele au fost golite de către **${act.by || 'Admin'}**`],
    reset: ['🔄 Resetare Generală Tură', 0xEF4444, `Toate turele au fost golite de către **${act.by || 'Admin'}**`]
  };
  const [title, color, description] = config[actionType] || ['📋 Acțiune Repartizare', 0x245AB1, 'A fost înregistrată o acțiune în repartizare.'];
  const fields = [];
  if (actionType !== 'clear_all' && actionType !== 'reset') {
    fields.push({ name: '👤 Medic', value: `**${act.callSign || act.badge || 'M-???'}** (${act.name || 'Necunoscut'})`, inline: false });
    fields.push({ name: '📍 Zonă', value: `**${act.zone || 'Nespecificată'}**`, inline: false });
    if (act.partner) fields.push({ name: '🤝 Partener', value: `\`${act.partner}\``, inline: false });
    if (act.by) fields.push({ name: '🛡️ Acțiune efectuată de', value: `**${act.by}**`, inline: false });
  } else fields.push({ name: '⚙️ Efectuat de', value: `**${act.by || 'Admin'}**`, inline: false });
  await fetch(webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Sistem Loguri Medicale', avatar_url: 'https://cdn-icons-png.flaticon.com/512/1021/1021799.png', embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }] })
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
  fields.push({ name: '👥 Total medici (spital + teren)', value: `**${totalMedici}** cadre medicale active`, inline: false });
  const payload = { username: 'Tablou Live Repartizare', avatar_url: 'https://cdn-icons-png.flaticon.com/512/1021/1021799.png', embeds: [{ title: '🚑 Situație Repartizare Medicală pe Zone', description: 'Această listă afișează repartizarea curentă a cadrelor medicale pe teren și la spital.', color: 0x245AB1, fields, timestamp: new Date().toISOString() }] };
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
