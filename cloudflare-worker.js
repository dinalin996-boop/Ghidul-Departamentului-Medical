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
        const state = await readState(env);
        return jsonResponse(state);
      }

      if (request.method !== 'POST') return jsonResponse({ error: 'Metodă netratată' }, 405);
      let data;
      try { data = await request.json(); } catch (e) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

      const { type, action, state, logData } = data;
      const WEBHOOK_REPARTIZARE = env.WEBHOOK_REPARTIZARE || '';
      const WEBHOOK_LOGURI = env.WEBHOOK_LOGURI || '';

      // OPERAȚIE ATOMICĂ: modifică DOAR membrul vizat peste starea curentă din KV.
      // Astfel un client cu o stare locală veche nu mai poate „readuce” pe zonă
      // un medic care a fost scos de altcineva.
      if (type === 'op' && data.op) {
        const result = await applyOperation(env, data.op);
        if (!result.ok) return jsonResponse({ error: result.error }, result.status || 400);
        if (WEBHOOK_REPARTIZARE) ctx.waitUntil(updateRepartizareEmbed(WEBHOOK_REPARTIZARE, result.state, env));
        const opAction = data.op.log;
        // Trimite logul ÎNTÂI, ca ieșirea din zonă și notificarea pe Discord să fie mereu sincronizate.
        // Dacă WEBHOOK_LOGURI lipsește, logul nu se pierde — rămâne în coada clientului.
        if (opAction) ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, opAction));
        return jsonResponse({ success: true, state: result.state, message: 'Operațiune aplicată.' });
      }

      if (type === 'assign' && state !== undefined) {
        if (!isValidState(state)) {
          return jsonResponse({ error: 'Invalid state shape' }, 400);
        }
        // Protecție anti-suprascriere: dacă serverul are deja o stare MAI NOUĂ decât
        // cea pe care se bazează clientul, refuzăm scrierea integrală învechită.
        const current = await readState(env);
        const baseRev = Number(data.baseRev) || 0;
        if (baseRev && baseRev < current.rev) {
          return jsonResponse({ success: false, stale: true, state: current, message: 'Starea serverului este mai nouă.' });
        }
        const payload = stripMeta(state);
        payload.rev = current.rev + 1;
        payload.updatedAt = Date.now();
        if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(payload));
        if (WEBHOOK_REPARTIZARE) ctx.waitUntil(updateRepartizareEmbed(WEBHOOK_REPARTIZARE, payload, env));
        return jsonResponse({ success: true, rev: payload.rev, message: 'Starea a fost sincronizată.' });
      }

      const activeAction = action || logData;
      if (WEBHOOK_LOGURI && type === 'log_batch' && Array.isArray(data.logs)) {
        data.logs.forEach(log => ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, log)));
      } else if (WEBHOOK_LOGURI && activeAction) {
        ctx.waitUntil(sendSeparateLog(WEBHOOK_LOGURI, activeAction));
      }

      if (state !== undefined) {
        if (!isValidState(state)) {
          return jsonResponse({ error: 'Invalid state shape' }, 400);
        }
        const payload = stripMeta(state);
        const current = await readState(env);
        payload.rev = current.rev + 1;
        payload.updatedAt = Date.now();
        if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(payload));
      }
      return jsonResponse({ success: true, message: 'Procesat cu succes.' });
    } catch (error) {
      return jsonResponse({ error: 'Eroare Worker: ' + error.message }, 500);
    }
  }
};

const SUPPORTED_ZONES = ['Zona 1', 'Zona 2', 'Zona 3', 'Zona 4', 'Spital'];

function emptyState() {
  return { 'Zona 1': [], 'Zona 2': [], 'Zona 3': [], 'Zona 4': [], Spital: [], rev: 0, updatedAt: 0 };
}

function isValidState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  return Object.keys(state).every(zone => SUPPORTED_ZONES.includes(zone) || zone === 'rev' || zone === 'updatedAt')
    && SUPPORTED_ZONES.every(zone => Array.isArray(state[zone]));
}

// Elimină metadatele (rev/updatedAt) când trimitem starea către client/embed.
function stripMeta(state) {
  const out = {};
  SUPPORTED_ZONES.forEach(z => { out[z] = Array.isArray(state[z]) ? state[z] : []; });
  return out;
}

// Citește starea completă din KV, normalizată, cu metadate de versiune.
async function readState(env) {
  const fallback = emptyState();
  if (!env.RP_KV) return fallback;
  const stored = await env.RP_KV.get('state_v3');
  if (!stored) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (parseError) {
    console.error('Corrupted stored state:', parseError);
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const normalised = stripMeta(parsed);
  normalised.rev = Number(parsed.rev) || 0;
  normalised.updatedAt = Number(parsed.updatedAt) || 0;
  return normalised;
}

// Compară membrii după discordId (preferat) sau callsign, ca ieșirea să fie
// consistentă indiferent cum e identificat medicul.
function memberKey(member = {}) {
  const discordId = (member.discordId || '').toString().trim();
  if (discordId) return 'd:' + discordId;
  const callSign = (member.callSign || member.badge || '').toString().trim().toUpperCase();
  return 'c:' + callSign;
}

// Aplică o operațiune atomică peste starea din KV.
// op = { kind: 'remove'|'add', target: { discordId, callSign }, member, zone }
async function applyOperation(env, op = {}) {
  const current = await readState(env);
  const next = stripMeta(current);
  const kind = op.kind;

  if (kind === 'remove') {
    const target = op.target || {};
    const targetKey = memberKey(target);
    const targetCallsign = (target.callSign || '').toString().trim().toUpperCase();
    let removedZone = '';
    let removedMember = null;
    SUPPORTED_ZONES.forEach(zone => {
      next[zone] = next[zone].filter(member => {
        const matches = (op.matchByName && member.name && target.name
          && member.name.trim().toLowerCase() === target.name.trim().toLowerCase())
          || (targetKey && memberKey(member) === targetKey)
          || (targetCallsign && (member.callSign || '').toString().trim().toUpperCase() === targetCallsign);
        if (matches) {
          removedZone = zone;
          removedMember = member;
          return false;
        }
        return true;
      });
    });
    // Dacă nu am găsit niciun membru, refuzăm operația: altfel clientul ar șterge local
    // și ar crede că a reușit, iar poll-ul i-ar readuce din starea serverului.
    if (!removedMember) {
      return { ok: false, error: 'Membrul nu a fost găsit în repartizare', status: 404 };
    }
    next.rev = current.rev + 1;
    next.updatedAt = Date.now();
    if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(next));
    return { ok: true, state: next, removed: removedMember, removedZone };
  }

  if (kind === 'add') {
    const member = op.member;
    const zone = op.zone;
    if (!member || !SUPPORTED_ZONES.includes(zone)) {
      return { ok: false, error: 'Zonă sau membru invalid', status: 400 };
    }
    // Elimină membrul de oriunde altundeva (evită duplicate), apoi îl adaugă.
    const key = memberKey(member);
    SUPPORTED_ZONES.forEach(z => {
      next[z] = next[z].filter(m => memberKey(m) !== key);
    });
    next[zone].push(member);
    next.rev = current.rev + 1;
    next.updatedAt = Date.now();
    if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(next));
    return { ok: true, state: next };
  }

  if (kind === 'clear') {
    const cleared = emptyState();
    cleared.rev = current.rev + 1;
    cleared.updatedAt = Date.now();
    if (env.RP_KV) await env.RP_KV.put('state_v3', JSON.stringify(cleared));
    return { ok: true, state: cleared };
  }

  return { ok: false, error: 'Operațiune necunoscută', status: 400 };
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
  SUPPORTED_ZONES.forEach(zone => {
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
