const SUPPORTED_ZONES = ['Zona 1', 'Zona 2', 'Zona 3', 'Zona 4', 'Spital'];
const STATE_KEY = 'state_v3';
const LIVE_MESSAGE_KEY = 'discord_live_msg_id';
const DEFAULT_ORIGINS = [
  'https://ghidul-departamentului-medical-eight.vercel.app',
  'https://ghid-smurd.vercel.app',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigins = [...DEFAULT_ORIGINS, env.ALLOWED_ORIGIN].filter(Boolean);
    const originAllowed = !origin || allowedOrigins.includes(origin);
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'Vary': 'Origin'
    };
    if (origin && originAllowed) headers['Access-Control-Allow-Origin'] = origin;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

    if (!originAllowed) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    try {
      if (request.method === 'GET') return json(await readState(env));
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

      let data;
      try { data = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
      const repartitionWebhook = env.WEBHOOK_LOGURI || '';
      const logsWebhook = env.WEBHOOK_REPARTIZARE || '';

      if (data.type === 'op' && data.op) {
        const result = await applyOperation(env, data.op);
        if (!result.ok) return json({ error: result.error }, result.status || 400);
        await updateLiveEmbed(env, repartitionWebhook, result.state);
        if (data.op.log) await sendSeparateLog(env, logsWebhook, data.op.log);
        return json({ success: true, state: result.state, message: 'Operațiune aplicată.' });
      }

      if (data.type === 'assign' && data.state !== undefined) {
        if (!isValidState(data.state)) return json({ error: 'Invalid state shape' }, 400);
        const current = await readState(env);
        const baseRev = Number(data.baseRev) || 0;
        if (baseRev && baseRev < current.rev) {
          return json({ success: false, stale: true, state: current, message: 'Starea Upstash este mai nouă.' });
        }
        const next = stripMeta(data.state);
        next.rev = current.rev + 1;
        next.updatedAt = Date.now();
        await writeState(env, next);
        await updateLiveEmbed(env, repartitionWebhook, next);
        return json({ success: true, rev: next.rev, message: 'Starea a fost sincronizată.' });
      }

      if (data.type === 'log_batch' && Array.isArray(data.logs)) {
        await Promise.all(data.logs.map(log => sendSeparateLog(env, logsWebhook, log)));
      } else {
        const action = data.action || data.logData;
        if (action) await sendSeparateLog(env, logsWebhook, action);
      }

      if (data.state !== undefined) {
        if (!isValidState(data.state)) return json({ error: 'Invalid state shape' }, 400);
        const current = await readState(env);
        const next = stripMeta(data.state);
        next.rev = current.rev + 1;
        next.updatedAt = Date.now();
        await writeState(env, next);
      }
      return json({ success: true, message: 'Processed successfully.' });
    } catch (error) {
      console.error('Repartizare API error:', error);
      const status = Number(error.status) || 500;
      return json({ error: status === 503 ? error.message : 'Serviciul repartizării este momentan indisponibil.' }, status);
    }
  }
};

function redisConfig(env) {
  const url = (env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
  const token = (env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (!url || !token) {
    const error = new Error('Configurează UPSTASH_REDIS_REST_URL și UPSTASH_REDIS_REST_TOKEN.');
    error.status = 503;
    throw error;
  }
  return { url, token };
}

async function redisCommand(env, command) {
  const { url, token } = redisConfig(env);
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command])
  });
  if (!response.ok) throw new Error(`Upstash a răspuns cu statusul ${response.status}.`);
  const results = await response.json();
  const result = Array.isArray(results) ? results[0] : null;
  if (!result || result.error) throw new Error(result?.error || 'Răspuns Upstash invalid.');
  return result.result ?? null;
}

async function readState(env) {
  const stored = await redisCommand(env, ['GET', STATE_KEY]);
  if (stored !== null && stored !== undefined) return normalizeState(stored);

  if (env.LEGACY_STATE_URL) {
    const response = await fetch(env.LEGACY_STATE_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Importul Worker-ului vechi a eșuat (${response.status}).`);
    const legacy = await response.json();
    if (!isValidState(legacy)) throw new Error('Worker-ul vechi a returnat o stare invalidă.');
    const imported = stripMeta(legacy);
    imported.rev = Number(legacy.rev) || 0;
    imported.updatedAt = Number(legacy.updatedAt) || Date.now();
    await writeState(env, imported);
    return imported;
  }
  return emptyState();
}

function normalizeState(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error('Starea Upstash nu este JSON valid.'); }
  if (!isValidState(parsed)) throw new Error('Starea Upstash are o structură invalidă.');
  const normalized = stripMeta(parsed);
  normalized.rev = Number(parsed.rev) || 0;
  normalized.updatedAt = Number(parsed.updatedAt) || 0;
  return normalized;
}

async function writeState(env, state) {
  await redisCommand(env, ['SET', STATE_KEY, JSON.stringify(state)]);
}

function emptyState() {
  return { 'Zona 1': [], 'Zona 2': [], 'Zona 3': [], 'Zona 4': [], Spital: [], rev: 0, updatedAt: 0 };
}

function isValidState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  return Object.keys(state).every(zone => SUPPORTED_ZONES.includes(zone) || zone === 'rev' || zone === 'updatedAt')
    && SUPPORTED_ZONES.every(zone => Array.isArray(state[zone]));
}

function stripMeta(state) {
  const result = {};
  SUPPORTED_ZONES.forEach(zone => { result[zone] = Array.isArray(state[zone]) ? state[zone] : []; });
  return result;
}

function memberKey(member = {}) {
  const discordId = (member.discordId || '').toString().trim();
  if (discordId) return `d:${discordId}`;
  const callSign = (member.callSign || member.badge || '').toString().trim().toUpperCase();
  return `c:${callSign}`;
}

async function applyOperation(env, op = {}) {
  const current = await readState(env);
  const next = stripMeta(current);

  if (op.kind === 'remove') {
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
        if (!matches) return true;
        removedZone = zone;
        removedMember = member;
        return false;
      });
    });
    if (!removedMember) return { ok: false, error: 'Membrul nu a fost găsit în repartizare', status: 404 };
    next.rev = current.rev + 1;
    next.updatedAt = Date.now();
    await writeState(env, next);
    return { ok: true, state: next, removed: removedMember, removedZone };
  }

  if (op.kind === 'add') {
    if (!op.member || !SUPPORTED_ZONES.includes(op.zone)) return { ok: false, error: 'Zonă sau membru invalid', status: 400 };
    const key = memberKey(op.member);
    SUPPORTED_ZONES.forEach(zone => { next[zone] = next[zone].filter(member => memberKey(member) !== key); });
    next[op.zone].push(op.member);
    next.rev = current.rev + 1;
    next.updatedAt = Date.now();
    await writeState(env, next);
    return { ok: true, state: next };
  }

  if (op.kind === 'clear') {
    const cleared = emptyState();
    cleared.rev = current.rev + 1;
    cleared.updatedAt = Date.now();
    await writeState(env, cleared);
    return { ok: true, state: cleared };
  }
  return { ok: false, error: 'Operațiune necunoscută', status: 400 };
}

async function sendSeparateLog(env, webhookUrl, action = {}) {
  if (!webhookUrl) return;
  const type = action.action || action.type;
  const configs = {
    join: ['🟢 Intrare pe tură', 0x10B981, 'Un medic s-a arondat pe o zonă/spital.'],
    move: ['🔁 Schimbare Zonă', 0x7C3AED, 'Un medic și-a schimbat zona.'],
    admin_add: ['🔵 Adăugare în Repartizare', 0x2563EB, `Un medic a fost adăugat de către **${action.by || 'un superior'}**`],
    leave: ['🔴 Ieșire de pe tură', 0xEF4444, 'Un medic a părăsit zona.'],
    kick: ['⚠️ Kick de pe tură', 0xF59E0B, `Un medic a fost scos de către **${action.by || 'un superior'}**`],
    removed: ['⚠️ Kick de pe tură', 0xF59E0B, `Un medic a fost scos de către **${action.by || 'un superior'}**`],
    clear_all: ['🔄 Resetare Tură', 0xEF4444, `Toti medicii au fost scosi de către **${action.by || 'Admin'}**`],
    reset: ['🔄 Resetare Tură', 0xEF4444, `Toti medicii au fost scosi de către **${action.by || 'Admin'}**`]
  };
  const [title, color, description] = configs[type] || ['📋 Acțiune Repartizare', 0x245AB1, 'A fost înregistrată o acțiune de repartizare.'];
  const fields = [];
  if (type !== 'clear_all' && type !== 'reset') {
    fields.push({ name: '🥼 Medic', value: `**${action.callSign || action.badge || 'M-???'}** (${action.name || 'Necunoscut'})`, inline: false });
    if (action.discordId) fields.push({ name: '🤖 Discord', value: `<@${action.discordId}>`, inline: false });
    fields.push({ name: '📍 Zonă', value: `**${action.zone || 'Nespecificată'}**`, inline: false });
    if (type === 'move' && action.fromZone) fields.push({ name: '↔️ Zona anterioară', value: `**${action.fromZone}**`, inline: false });
    if (action.partner) fields.push({ name: '🤝 Partener', value: `\`${action.partner}\``, inline: false });
    if (action.by) fields.push({ name: '🛡️ Modificare făcută de', value: `**${action.by}**`, inline: false });
  } else {
    fields.push({ name: '⚙️ Efectuat de', value: `**${action.by || 'Admin'}**`, inline: false });
  }
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Loguri ZONE',
        avatar_url: `${env.PUBLIC_APP_ORIGIN || 'https://ghidul-departamentului-medical-eight.vercel.app'}/hr.png`,
        content: action.discordId ? `<@${action.discordId}>` : undefined,
        allowed_mentions: { parse: [] },
        embeds: [{ title, description, color, fields, timestamp: new Date().toISOString() }]
      })
    });
    if (!response.ok) console.error('Discord log webhook failed:', response.status);
  } catch (error) {
    console.error('Discord log webhook request failed:', error);
  }
}

async function updateLiveEmbed(env, webhookUrl, state) {
  if (!webhookUrl) return;
  const fields = [];
  let total = 0;
  SUPPORTED_ZONES.forEach(zone => {
    const members = Array.isArray(state[zone]) ? state[zone] : [];
    total += members.length;
    fields.push({
      name: `📍 ${zone} (${members.length})`,
      value: members.length ? members.map(member => `• **${member.callSign || member.badge || 'M-???'}** ${member.name || 'Necunoscut'}${member.partner ? ` *(cu ${member.partner})*` : ''}`).join('\n') : '_Niciun medic arondat_',
      inline: false
    });
  });
  fields.push({ name: '🥼 Total medici pe teren', value: `**${total}** cadre medicale active`, inline: false });
  const payload = {
    username: 'Repartizare LIVE',
    avatar_url: `${env.PUBLIC_APP_ORIGIN || 'https://ghidul-departamentului-medical-eight.vercel.app'}/hr.png`,
    embeds: [{ title: '🩺 Medicii repartizați pe zone.', description: 'Mai jos este lista cu medicii pe tură.', color: 0x245AB1, fields, timestamp: new Date().toISOString() }]
  };
  try {
    const messageId = await redisCommand(env, ['GET', LIVE_MESSAGE_KEY]);
    if (messageId) {
      const edit = await fetch(`${webhookUrl}/messages/${messageId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      if (edit.ok) return;
    }
    const sent = await fetch(`${webhookUrl}?wait=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (sent.ok) {
      const result = await sent.json();
      if (result.id) await redisCommand(env, ['SET', LIVE_MESSAGE_KEY, result.id]);
    } else {
      console.error('Discord live webhook failed:', sent.status);
    }
  } catch (error) {
    console.error('Discord live webhook request failed:', error);
  }
}
