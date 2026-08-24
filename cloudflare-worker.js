// Cloudflare Worker - Webhook Relay (Optional)
// Dacă vrei să trimiti webhook-uri prin Cloudflare Worker

export default {
  async fetch(request, env) {
    // CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    if (request.method === 'POST') {
      try {
        const data = await request.json();
        const { type, message, discordId, callSign, zone, partner } = data;

        // Configurează aceste valori ca Secrets în Cloudflare, nu le pune în frontend.
        const WEBHOOK_REPARTIZARE = env.WEBHOOK_REPARTIZARE || '';
        const WEBHOOK_LOGURI = env.WEBHOOK_LOGURI || '';

        let webhookUrl = WEBHOOK_REPARTIZARE;
        let payload = {};

        if (type === 'assign') {
          // Mesajul vizibil în camera de repartizare
          payload = {
            content: message || `✅ **${callSign}** - **${data.name || 'Membru'}** s-a arondat pe **${zone}**${partner ? ` împreună cu **${partner}**` : ''}`
          };
          webhookUrl = WEBHOOK_REPARTIZARE;
        } else if (type === 'log') {
          // Log
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
