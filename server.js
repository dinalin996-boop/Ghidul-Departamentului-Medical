const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const session = require('express-session');
const dotenv = require('dotenv');
const path = require('path');
const crypto = require('crypto');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}

app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

const sheets = google.sheets({ version: 'v4', auth: GOOGLE_API_KEY });

// Structura zone
const ZONES = {
  1: { name: 'Port/Aeroport', maxMembers: 4 },
  2: { name: 'Zona Centrală/Amarrilo', maxMembers: 4 },
  3: { name: 'Vinewood + Highway', maxMembers: 4 },
  4: { name: 'Sandy-Paleto-Roxwood', maxMembers: 4 },
  spital: { name: 'Spital', maxMembers: 10 }
};

// Stocaj în memorie (în producție, folosiți bază de date)
let zoneAssignments = {
  1: [],
  2: [],
  3: [],
  4: [],
  spital: []
};

// Discord OAuth Login
app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify&state=${state}`;
  res.redirect(discordAuthUrl);
});

// Discord OAuth Callback
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code) {
    return res.redirect('/repartizare.html?error=no_code');
  }

  if (!state || !req.session.oauthState || state !== req.session.oauthState) {
    return res.redirect('/repartizare.html?error=invalid_state');
  }
  delete req.session.oauthState;

  try {
    const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', {
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: DISCORD_REDIRECT_URI,
      scope: 'identify'
    });

    const accessToken = tokenResponse.data.access_token;
    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const discordId = userResponse.data.id;
    req.session.discordId = discordId;
    req.session.discordUser = userResponse.data;

    res.redirect('/repartizare.html?authenticated=true');
  } catch (error) {
    console.error('Discord auth error:', error);
    res.redirect('/repartizare.html?error=auth_failed');
  }
});

// Verificare autentificare
app.get('/api/auth/check', (req, res) => {
  if (req.session.discordId) {
    res.json({ authenticated: true, discordId: req.session.discordId, user: req.session.discordUser });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.get('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Obține date din Google Sheets
async function getSheetData() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: 'Sheet1!A:T'
    });
    return response.data.values || [];
  } catch (error) {
    console.error('Error fetching sheet:', error);
    return [];
  }
}

// Găsește utilizatorul în Google Sheets
async function findUserByDiscordId(discordId) {
  const data = await getSheetData();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[19] && row[19].toString() === discordId.toString()) {
      return {
        name: row[1] || 'Unknown',
        callSign: row[2] || 'N/A',
        grad: row[4] || 'N/A',
        radio: row[11] === 'TRUE' || row[11] === true,
        bls: row[12] === 'TRUE' || row[12] === true,
        rowIndex: i
      };
    }
  }
  return null;
}

// Obține starea zonelor
app.get('/api/zones/status', (req, res) => {
  const status = {};
  for (const [zone, members] of Object.entries(zoneAssignments)) {
    status[zone] = {
      members: members,
      count: members.length,
      maxMembers: ZONES[zone].maxMembers,
      name: ZONES[zone].name
    };
  }
  res.json(status);
});

// Calculează media persoane pe zone
function calculateAverageMembers() {
  const totalMembers = Object.values(zoneAssignments).reduce((sum, zone) => sum + zone.length, 0);
  const totalZones = Object.keys(zoneAssignments).length;
  return totalZones > 0 ? totalMembers / totalZones : 0;
}

// Verifică dacă utilizatorul poate fi alocat pe o zonă
function canAssignToZone(user, zone) {
  const grad = parseInt(user.grad.match(/\d+/)?.[0] || 0);
  const average = calculateAverageMembers();
  const zoneMembers = zoneAssignments[zone].length;

  if (zoneMembers >= ZONES[zone].maxMembers) {
    return { allowed: false, reason: `Zona ${zone} este plină.` };
  }

  // Restricții grad
  if (grad === 600 && (!user.radio || !user.bls)) {
    return { allowed: false, reason: 'Grad 600 fără Radio/BLS poate merge doar pe Spital' };
  }

  if (grad === 600 && zone !== 'spital') {
    return { allowed: false, reason: 'Grad 600 cu Radio/BLS poate merge pe Spital + Zona 1,2,3' };
  }

  if (grad === 500 && zone === '4') {
    return { allowed: false, reason: 'Grad 500 nu poate merge pe Zona 4' };
  }

  // Restricții medie
  if (zoneMembers > average) {
    return { allowed: false, reason: `Zona ${zone} are prea mulți oameni. Mergi pe o zonă cu deficit.` };
  }

  return { allowed: true };
}

// Alocare pe zonă
app.post('/api/zones/assign', async (req, res) => {
  if (!req.session.discordId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { zone, partnerCallSign } = req.body;

  if (!zone || !ZONES[zone]) {
    return res.status(400).json({ error: 'Invalid zone' });
  }

  let user;
  try {
    user = await findUserByDiscordId(req.session.discordId);
  } catch (error) {
    console.error('Assignment user lookup error:', error);
    return res.status(503).json({ error: 'Unable to access user database' });
  }
  if (!user) {
    return res.status(404).json({ error: 'User not found in database' });
  }

  // Verifică dacă utilizatorul este deja alocat
  for (const [z, members] of Object.entries(zoneAssignments)) {
    if (members.some(m => m.discordId === req.session.discordId)) {
      return res.status(400).json({ error: 'Already assigned to a zone' });
    }
  }

  // Verifică restricții
  const canAssign = canAssignToZone(user, zone);
  if (!canAssign.allowed) {
    return res.status(400).json({ error: canAssign.reason });
  }

  // Pentru grad 600, necesită partner
  let assignmentData = {
    discordId: req.session.discordId,
    name: user.name,
    callSign: user.callSign,
    grad: user.grad
  };

  if (user.grad.includes('600') && partnerCallSign) {
    assignmentData.partner = partnerCallSign;
  }

  try {
    zoneAssignments[zone].push(assignmentData);
  } catch (error) {
    console.error('Assignment update error:', error);
    return res.status(500).json({ error: 'Unable to update zone assignment' });
  }

  res.json({
    success: true,
    message: `Alocat pe ${ZONES[zone].name}`,
    assignment: assignmentData
  });
});

// Dealocare din zonă
app.post('/api/zones/unassign', (req, res) => {
  if (!req.session.discordId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  for (const [zone, members] of Object.entries(zoneAssignments)) {
    const index = members.findIndex(m => m.discordId === req.session.discordId);
    if (index !== -1) {
      const removed = members.splice(index, 1)[0];
      return res.json({ success: true, message: `Dealocat din ${ZONES[zone].name}`, removed });
    }
  }

  res.status(404).json({ error: 'Not assigned to any zone' });
});

// Obține informații utilizator
app.get('/api/user/info', async (req, res) => {
  if (!req.session.discordId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = await findUserByDiscordId(req.session.discordId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  res.json(user);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
