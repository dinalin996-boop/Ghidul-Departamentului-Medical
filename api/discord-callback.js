export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://ghidul-departamentului-medical-eight.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'No code provided' });

  const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
  const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
  const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
  const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
  const API_KEY = process.env.GOOGLE_API_KEY;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !REDIRECT_URI || !SHEET_ID || !API_KEY) {
    throw new Error('Missing required OAuth or Google API environment variables');
  }



  try {
    // 1. Schimbă codul cu access token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        scope: 'identify'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('Discord token exchange failed:', tokenRes.status, tokenData.error);
      return res.status(502).json({ error: 'Token exchange failed' });
    }

    // 2. Obține Discord user
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();
    if (!userRes.ok || !discordUser.id) {
      console.error('Discord user lookup failed:', userRes.status);
      return res.status(502).json({ error: 'Discord user lookup failed' });
    }
    const discordId = discordUser.id;

    // 3. Caută în Google Sheets coloana T (index 19) după Discord ID
    const sheetRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent('LISTA DEPARTAMENT!A1:T300')}?key=${API_KEY}`
    );
    const sheetData = await sheetRes.json();
    if (!sheetRes.ok || !Array.isArray(sheetData.values)) {
      console.error('Google Sheets lookup failed:', sheetRes.status, sheetData.error?.code);
      return res.status(502).json({ error: 'User database lookup failed' });
    }
    const rows = sheetData.values;
    const matchingRow = rows.slice(1).find(row => row[19] && row[19].toString().trim() === discordId.toString().trim());
    const foundUser = matchingRow ? mapSheetRowToUser(matchingRow, discordId, discordUser) : null;

    if (!foundUser) {
      console.warn('Discord user not found in Google Sheets:', { discordId, totalRows: rows.length });
      return res.status(404).json({ error: 'not_found' });
    }

    return res.status(200).json({ success: true, user: foundUser });

  } catch (err) {
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
}

function mapSheetRowToUser(row, discordId, discordUser) {
  const callSignRaw = (row[2] || '').toString().trim();
  const csNum = parseInt(callSignRaw.replace(/\D/g, ''), 10) || 0;
  const callSign = callSignRaw ? (callSignRaw.startsWith('M-') ? callSignRaw : 'M-' + callSignRaw) : ('M-' + csNum);
  const name = (row[3] || discordUser.username || '').toString().trim();
  const rank = (row[4] || '').toString().trim();
  const dept = (row[5] || '').toString().trim();
  const radioVal = (row[11] || '').toString().trim().toUpperCase();
  const blsVal = (row[12] || '').toString().trim().toUpperCase();
  const isConducere = (csNum >= 1 && csNum <= 13) || ['DIRECTOR', 'INSPECTOR', 'CONDUCERE'].some(value => rank.toUpperCase().includes(value)) || dept.toUpperCase().includes('CONDUCERE');
  const tier = isConducere ? 'conducere' : csNum >= 100 && csNum <= 699 ? `${Math.floor(csNum / 100)}00` : 'other';
  return { id: (row[1] || '').toString().trim(), name, callSign, csNum, rank: rank || (isConducere ? 'Conducere' : 'Medic'), dept, tier, isConducere, radio: ['TRUE', '1', 'DA'].includes(radioVal), bls: ['TRUE', '1', 'DA'].includes(blsVal), discordId, avatar: discordUser.avatar ? `https://cdn.discordapp.com/avatars/${discordId}/${discordUser.avatar}.png` : null };
}
