import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../cloudflare-worker.js', import.meta.url), 'utf8');
const worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
const savedFetch = globalThis.fetch;
const redis = new Map();
const webhookCalls = [];
const legacyState = {
  'Zona 1': [{ callSign: 'M-100', name: 'Medic existent' }],
  'Zona 2': [],
  'Zona 3': [],
  'Zona 4': [],
  Spital: [],
  rev: 2496,
  updatedAt: 123
};
const env = {
  UPSTASH_REDIS_REST_URL: 'https://upstash.test',
  UPSTASH_REDIS_REST_TOKEN: 'test-token',
  LEGACY_STATE_URL: 'https://legacy.test/state',
  WEBHOOK_REPARTIZARE: 'https://discord.test/live',
  WEBHOOK_LOGURI: 'https://discord.test/logs',
  ALLOWED_ORIGIN: 'https://site.test',
  PUBLIC_APP_ORIGIN: 'https://site.test'
};

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  if (url.endsWith('/pipeline')) {
    const commands = JSON.parse(options.body);
    return Response.json(commands.map(([command, key, value]) => {
      if (command === 'GET') return { result: redis.get(key) ?? null };
      if (command === 'SET') {
        redis.set(key, value);
        return { result: 'OK' };
      }
      throw new Error(`Unexpected Redis command: ${command}`);
    }));
  }
  if (url === env.LEGACY_STATE_URL) return Response.json(legacyState);
  if (url.startsWith('https://discord.test/')) {
    const body = JSON.parse(options.body);
    webhookCalls.push({ url, body });
    return Response.json({ id: 'live-message-id' });
  }
  throw new Error(`Unexpected request URL: ${url}`);
};

async function invoke(method, body) {
  const request = new Request('https://worker.test/', {
    method,
    headers: { Origin: 'https://site.test', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return worker.fetch(request, env);
}

try {
  const firstRead = await invoke('GET');
  const firstState = await firstRead.json();
  assert.equal(firstRead.status, 200);
  assert.equal(firstState.rev, 2496);
  assert.equal(redis.has('state_v3'), true, 'legacy state should seed Upstash');

  const addResponse = await invoke('POST', {
    type: 'op',
    op: {
      kind: 'add',
      zone: 'Zona 1',
      member: { callSign: 'M-101', name: 'Medic nou' },
      log: { action: 'join', callSign: 'M-101', name: 'Medic nou', zone: 'Zona 1' }
    }
  });
  const added = await addResponse.json();
  assert.equal(addResponse.status, 200);
  assert.equal(added.state['Zona 1'].length, 2);
  assert.equal(added.state.rev, 2497);
  assert.equal(redis.has('discord_live_msg_id'), true);

  const staleResponse = await invoke('POST', {
    type: 'assign',
    state: { 'Zona 1': [], 'Zona 2': [], 'Zona 3': [], 'Zona 4': [], Spital: [] },
    baseRev: 2496
  });
  assert.equal((await staleResponse.json()).stale, true);

  const batchResponse = await invoke('POST', {
    type: 'log_batch',
    logs: [
      { action: 'join', callSign: 'M-102', zone: 'Zona 2' },
      { action: 'leave', callSign: 'M-103', zone: 'Zona 3' }
    ]
  });
  assert.equal(batchResponse.status, 200);
  assert.deepEqual(webhookCalls.map(call => call.body.username).sort(), [
    'Loguri ZONE', 'Loguri ZONE', 'Loguri ZONE', 'Repartizare LIVE'
  ]);
  console.log('Cloudflare Worker → Upstash smoke test passed.');
} finally {
  globalThis.fetch = savedFetch;
}
