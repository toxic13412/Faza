const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '../client')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10e6
});

// ---- Database ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      avatar TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      channel TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar TEXT,
      text TEXT,
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS friends (
      id BIGSERIAL PRIMARY KEY,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(from_user, to_user)
    );
    CREATE TABLE IF NOT EXISTS dm_messages (
      id BIGSERIAL PRIMARY KEY,
      room_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar TEXT,
      text TEXT,
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS groups (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      avatar TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      PRIMARY KEY(group_id, username)
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id BIGSERIAL PRIMARY KEY,
      group_id BIGINT NOT NULL,
      username TEXT NOT NULL,
      avatar TEXT,
      text TEXT,
      image TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_invites (
      code TEXT PRIMARY KEY,
      group_id BIGINT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

initDB().catch(err => {
  console.error('DB init failed, using in-memory fallback:', err.message);
});

// In-memory fallback (when no DATABASE_URL)
const memUsers = {};
const memMessages = { general: [], random: [], gaming: [] };

const useDB = () => !!process.env.DATABASE_URL;

// ---- Auth helpers ----
async function findUser(username) {
  if (!useDB()) return memUsers[username.toLowerCase()] || null;
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
  return r.rows[0] || null;
}

async function createUser(username, passwordHash, avatar) {
  if (!useDB()) {
    memUsers[username.toLowerCase()] = { username, password_hash: passwordHash, avatar };
    return;
  }
  await pool.query(
    'INSERT INTO users (username, password_hash, avatar) VALUES ($1, $2, $3)',
    [username.toLowerCase(), passwordHash, avatar]
  );
}

async function updateAvatar(username, avatar) {
  if (!useDB()) {
    if (memUsers[username.toLowerCase()]) memUsers[username.toLowerCase()].avatar = avatar;
    return;
  }
  await pool.query('UPDATE users SET avatar = $1 WHERE username = $2', [avatar, username.toLowerCase()]);
}

// ---- Message helpers ----
async function getMessages(channel) {
  if (!useDB()) return (memMessages[channel] || []).slice(-50);
  const r = await pool.query(
    'SELECT * FROM messages WHERE channel = $1 ORDER BY created_at DESC LIMIT 50',
    [channel]
  );
  return r.rows.reverse().map(row => ({
    id: row.id,
    user: row.username,
    avatar: row.avatar,
    text: row.text,
    image: row.image,
    time: row.created_at
  }));
}

async function saveMessage(channel, username, avatar, text, image) {
  const msg = {
    id: Date.now(),
    user: username,
    avatar: avatar || null,
    text: text || null,
    image: image || null,
    time: new Date().toISOString()
  };
  if (!useDB()) {
    if (!memMessages[channel]) memMessages[channel] = [];
    memMessages[channel].push(msg);
    return msg;
  }
  const r = await pool.query(
    'INSERT INTO messages (channel, username, avatar, text, image) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [channel, username, avatar || null, text || null, image || null]
  );
  const row = r.rows[0];
  return { id: row.id, user: row.username, avatar: row.avatar, text: row.text, image: row.image, time: row.created_at };
}

// ---- Channels ----
const channels = {
  general: { name: 'general' },
  random:  { name: 'random' },
  gaming:  { name: 'gaming' },
};

const onlineUsers = {};
const voiceRooms = {};

// Broadcast voice count for all channels on startup (clears stale state)
function clearVoiceState() {
  for (const channelId of Object.keys(voiceRooms)) {
    voiceRooms[channelId] = new Set();
    io.emit('voiceCount', { channelId, count: 0, members: [] });
  }
}

io.on('connection', (socket) => {
  let currentUser = null;
  let currentChannel = null;
  let currentVoiceChannel = null;

  // ---- Auth ----
  socket.on('register', async ({ username, password }) => {
    try {
      const name = username.trim();
      if (!name || !password || password.length < 4)
        return socket.emit('authError', 'Имя и пароль обязательны (мин. 4 символа)');
      const existing = await findUser(name);
      if (existing) return socket.emit('authError', 'Это имя уже занято');
      const hash = bcrypt.hashSync(password, 10);
      await createUser(name, hash, null);
      socket.emit('authOk', { username: name, avatar: null });
    } catch (e) {
      console.error(e);
      socket.emit('authError', 'Ошибка сервера');
    }
  });

  socket.on('login', async ({ username, password }) => {
    try {
      const acc = await findUser(username.trim());
      if (!acc) return socket.emit('authError', 'Аккаунт не найден');
      if (!bcrypt.compareSync(password, acc.password_hash))
        return socket.emit('authError', 'Неверный пароль');
      socket.emit('authOk', { username: acc.username || username.trim(), avatar: acc.avatar });
    } catch (e) {
      console.error(e);
      socket.emit('authError', 'Ошибка сервера');
    }
  });

  // Auto-login: restore session without password, just fetch fresh avatar
  socket.on('autoLogin', async ({ username }) => {
    try {
      const acc = await findUser(username.trim());
      if (!acc) {
        // Account not found, force re-login
        socket.emit('sessionExpired');
        return;
      }
      socket.emit('authOk', { username: acc.username || username.trim(), avatar: acc.avatar });
    } catch (e) {
      console.error(e);
      // Fallback: just join without fresh avatar
      socket.emit('authOk', { username: username.trim(), avatar: null });
    }
  });

  socket.on('join', ({ username, avatar }) => {
    currentUser = username;
    onlineUsers[socket.id] = { name: username, avatar: avatar || null, activity: null };
    socket.emit('channels', Object.keys(channels).map(id => ({
      id, name: channels[id].name,
      voiceCount: (voiceRooms[id] || new Set()).size
    })));
    socket.emit('onlineUsers', Object.values(onlineUsers).map(u => ({ name: u.name, avatar: u.avatar, activity: u.activity || null })));
    socket.broadcast.emit('userJoined', { name: username, avatar: avatar || null, activity: null });
  });

  socket.on('setActivity', (activity) => {
    if (!onlineUsers[socket.id]) return;
    onlineUsers[socket.id].activity = activity; // { type, name, details, emoji } or null
    io.emit('activityUpdated', { name: currentUser, activity });
  });

  socket.on('updateAvatar', async (avatar) => {
    if (!onlineUsers[socket.id]) return;
    onlineUsers[socket.id].avatar = avatar;
    try { await updateAvatar(currentUser, avatar); } catch {}
    io.emit('avatarUpdated', { name: currentUser, avatar });
  });

  socket.on('joinChannel', async (channelId) => {
    if (!channels[channelId]) return;
    if (currentChannel) socket.leave(currentChannel);
    currentChannel = channelId;
    socket.join(channelId);
    try {
      const msgs = await getMessages(channelId);
      socket.emit('history', msgs);
    } catch (e) {
      socket.emit('history', []);
    }
  });

  socket.on('message', async ({ channelId, text }) => {
    if (!channels[channelId] || !currentUser) return;
    try {
      const msg = await saveMessage(channelId, currentUser, onlineUsers[socket.id]?.avatar, text, null);
      io.to(channelId).emit('message', msg);
    } catch (e) { console.error(e); }
  });

  socket.on('imageMessage', async ({ channelId, dataUrl }) => {
    if (!channels[channelId] || !currentUser) return;
    if (!dataUrl.startsWith('data:image/')) return;
    try {
      const msg = await saveMessage(channelId, currentUser, onlineUsers[socket.id]?.avatar, null, dataUrl);
      io.to(channelId).emit('message', msg);
    } catch (e) { console.error(e); }
  });

  // ---- Voice ----
  socket.on('joinVoice', (channelId) => {
    if (!channels[channelId]) return;
    if (currentVoiceChannel) leaveVoice(socket);
    currentVoiceChannel = channelId;
    if (!voiceRooms[channelId]) voiceRooms[channelId] = new Set();
    const existingPeers = [...voiceRooms[channelId]];
    voiceRooms[channelId].add(socket.id);
    socket.join('voice:' + channelId);
    socket.emit('voicePeers', { channelId, peers: existingPeers, user: currentUser });
    socket.to('voice:' + channelId).emit('voiceUserJoined', { socketId: socket.id, user: currentUser });
    broadcastVoiceCount(channelId);
  });

  socket.on('deleteMessage', async ({ id, channelId }) => {
    if (!currentUser) return;
    const isAdmin = currentUser === 'faza';
    if (channels[channelId] && channels[channelId].messages) {
      channels[channelId].messages = channels[channelId].messages.filter(m => String(m.id) !== String(id));
    }
    if (useDB()) {
      try {
        const query = isAdmin
          ? 'DELETE FROM messages WHERE id = $1::bigint'
          : 'DELETE FROM messages WHERE id = $1::bigint AND username = $2';
        const params = isAdmin ? [id] : [id, currentUser];
        await pool.query(query, params);
      } catch (e) { console.error('delete error:', e.message); }
    }
    io.to(channelId).emit('messageDeleted', { id: String(id) });
  });
  socket.on('offer',  ({ to, offer })     => io.to(to).emit('offer',  { from: socket.id, offer, user: currentUser }));
  socket.on('answer', ({ to, answer })    => io.to(to).emit('answer', { from: socket.id, answer }));
  socket.on('ice',    ({ to, candidate }) => io.to(to).emit('ice',    { from: socket.id, candidate }));

  // ---- Friends ----
  socket.on('getFriends', async () => {
    if (!currentUser || !useDB()) return;
    try {
      const r = await pool.query(`
        SELECT f.*, 
          CASE WHEN f.from_user = $1 THEN f.to_user ELSE f.from_user END as friend
        FROM friends f
        WHERE (f.from_user = $1 OR f.to_user = $1)
      `, [currentUser]);
      socket.emit('friendsList', r.rows);
    } catch(e) { console.error(e); }
  });

  socket.on('addFriend', async (targetUsername) => {
    if (!currentUser || !useDB()) return;
    try {
      const target = await findUser(targetUsername.trim());
      if (!target) return socket.emit('friendError', 'Пользователь не найден');
      if (target.username === currentUser) return socket.emit('friendError', 'Нельзя добавить себя');
      await pool.query(
        'INSERT INTO friends (from_user, to_user, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [currentUser, target.username, 'pending']
      );
      socket.emit('friendRequestSent', target.username);
      // Notify target if online
      for (const [sid, u] of Object.entries(onlineUsers)) {
        if (u.name === target.username) {
          io.to(sid).emit('friendRequest', { from: currentUser, avatar: onlineUsers[socket.id]?.avatar });
        }
      }
    } catch(e) { console.error(e); socket.emit('friendError', 'Ошибка'); }
  });

  socket.on('acceptFriend', async (fromUser) => {
    if (!currentUser || !useDB()) return;
    try {
      await pool.query(
        'UPDATE friends SET status=$1 WHERE from_user=$2 AND to_user=$3',
        ['accepted', fromUser, currentUser]
      );
      socket.emit('friendAccepted', fromUser);
      for (const [sid, u] of Object.entries(onlineUsers)) {
        if (u.name === fromUser) io.to(sid).emit('friendAccepted', currentUser);
      }
    } catch(e) { console.error(e); }
  });

  socket.on('declineFriend', async (fromUser) => {
    if (!currentUser || !useDB()) return;
    try {
      await pool.query('DELETE FROM friends WHERE from_user=$1 AND to_user=$2', [fromUser, currentUser]);
    } catch(e) { console.error(e); }
  });

  // ---- DM ----
  function dmRoomId(a, b) { return [a,b].sort().join(':'); }

  socket.on('getDM', async (targetUser) => {
    if (!currentUser || !useDB()) return;
    const roomId = dmRoomId(currentUser, targetUser);
    socket.join('dm:' + roomId);
    try {
      const r = await pool.query(
        'SELECT * FROM dm_messages WHERE room_id=$1 ORDER BY created_at DESC LIMIT 50',
        [roomId]
      );
      socket.emit('dmHistory', { roomId, messages: r.rows.reverse().map(row => ({
        id: row.id, user: row.username, avatar: row.avatar,
        text: row.text, image: row.image, time: row.created_at
      }))});
    } catch(e) { console.error(e); }
  });

  socket.on('dmMessage', async ({ targetUser, text, image }) => {
    if (!currentUser || !useDB()) return;
    const roomId = dmRoomId(currentUser, targetUser);
    try {
      const r = await pool.query(
        'INSERT INTO dm_messages (room_id,username,avatar,text,image) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [roomId, currentUser, onlineUsers[socket.id]?.avatar||null, text||null, image||null]
      );
      const row = r.rows[0];
      const msg = { id: row.id, user: row.username, avatar: row.avatar, text: row.text, image: row.image, time: row.created_at };
      io.to('dm:' + roomId).emit('dmMessage', { roomId, msg });
      // Notify target if not in room
      for (const [sid, u] of Object.entries(onlineUsers)) {
        if (u.name === targetUser) io.to(sid).emit('dmNotify', { from: currentUser, roomId });
      }
    } catch(e) { console.error(e); }
  });

  // ---- Groups ----
  socket.on('createGroup', async ({ name, members }) => {
    if (!currentUser || !useDB()) return;
    try {
      const r = await pool.query(
        'INSERT INTO groups (name, owner) VALUES ($1,$2) RETURNING *',
        [name, currentUser]
      );
      const group = r.rows[0];
      // Only add the creator — others join via invite link
      await pool.query('INSERT INTO group_members (group_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING', [group.id, currentUser]);
      socket.emit('groupCreated', group);
    } catch(e) { console.error(e); }
  });

  socket.on('getGroups', async () => {
    if (!currentUser || !useDB()) return;
    try {
      const r = await pool.query(
        'SELECT g.* FROM groups g JOIN group_members gm ON g.id=gm.group_id WHERE gm.username=$1',
        [currentUser]
      );
      socket.emit('groupsList', r.rows);
    } catch(e) { console.error(e); }
  });

  socket.on('getGroupMessages', async (groupId) => {
    if (!currentUser || !useDB()) return;
    socket.join('group:' + groupId);
    try {
      const r = await pool.query(
        'SELECT * FROM group_messages WHERE group_id=$1 ORDER BY created_at DESC LIMIT 50',
        [groupId]
      );
      socket.emit('groupHistory', { groupId, messages: r.rows.reverse().map(row => ({
        id: row.id, user: row.username, avatar: row.avatar,
        text: row.text, image: row.image, time: row.created_at
      }))});
    } catch(e) { console.error(e); }
  });

  socket.on('groupMessage', async ({ groupId, text, image }) => {
    if (!currentUser || !useDB()) return;
    try {
      const r = await pool.query(
        'INSERT INTO group_messages (group_id,username,avatar,text,image) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [groupId, currentUser, onlineUsers[socket.id]?.avatar||null, text||null, image||null]
      );
      const row = r.rows[0];
      const msg = { id: row.id, user: row.username, avatar: row.avatar, text: row.text, image: row.image, time: row.created_at };
      io.to('group:' + groupId).emit('groupMessage', { groupId, msg });
    } catch(e) { console.error(e); }
  });

  // ---- DM Voice ----
  socket.on('startDMCall', (targetUser) => {
    if (!currentUser) return;
    const roomId = [currentUser, targetUser].sort().join(':');
    if (!voiceRooms['dm:' + roomId]) voiceRooms['dm:' + roomId] = new Set();
    const existing = [...voiceRooms['dm:' + roomId]];
    voiceRooms['dm:' + roomId].add(socket.id);
    socket.join('voice:dm:' + roomId);
    socket.emit('voicePeers', { channelId: 'dm:' + roomId, peers: existing, user: currentUser });
    // Notify target
    for (const [sid, u] of Object.entries(onlineUsers)) {
      if (u.name === targetUser && !voiceRooms['dm:' + roomId].has(sid)) {
        io.to(sid).emit('incomingCall', { from: currentUser, roomId: 'dm:' + roomId, avatar: onlineUsers[socket.id]?.avatar });
      }
    }
  });

  socket.on('declineCall', async ({ from, roomId }) => {
    if (!currentUser || !useDB()) return;
    // Save missed call message in DM
    const dmRoomId = [currentUser, from].sort().join(':');
    try {
      const r = await pool.query(
        'INSERT INTO dm_messages (room_id,username,avatar,text) VALUES ($1,$2,$3,$4) RETURNING *',
        [dmRoomId, from, null, '📵 Пропущенный звонок']
      );
      const row = r.rows[0];
      const msg = { id: row.id, user: row.username, avatar: null, text: row.text, time: row.created_at, missed: true };
      // Notify both users
      const fullRoomId = 'dm:' + dmRoomId;
      io.to('dm:' + dmRoomId).emit('dmMessage', { roomId: fullRoomId, msg });
      // Also notify caller
      for (const [sid, u] of Object.entries(onlineUsers)) {
        if (u.name === from) io.to(sid).emit('dmMessage', { roomId: fullRoomId, msg });
      }
    } catch(e) { console.error(e); }
  });

  socket.on('joinDMCall', (roomId) => {
    if (!currentUser) return;
    if (!voiceRooms[roomId]) voiceRooms[roomId] = new Set();
    const existing = [...voiceRooms[roomId]];
    voiceRooms[roomId].add(socket.id);
    socket.join('voice:' + roomId);
    socket.emit('voicePeers', { channelId: roomId, peers: existing, user: currentUser });
    socket.to('voice:' + roomId).emit('voiceUserJoined', { socketId: socket.id, user: currentUser });
  });

  // ---- Group Voice ----
  socket.on('startGroupCall', (groupId) => {
    if (!currentUser) return;
    const roomId = 'group:' + groupId;
    if (!voiceRooms[roomId]) voiceRooms[roomId] = new Set();
    const existing = [...voiceRooms[roomId]];
    voiceRooms[roomId].add(socket.id);
    socket.join('voice:' + roomId);
    socket.emit('voicePeers', { channelId: roomId, peers: existing, user: currentUser });
    // Don't emit voiceUserJoined for self — client adds itself locally
    if (useDB()) {
      pool.query('SELECT username FROM group_members WHERE group_id=$1', [groupId]).then(r => {
        r.rows.forEach(row => {
          if (row.username === currentUser) return;
          for (const [sid, u] of Object.entries(onlineUsers)) {
            if (u.name === row.username && !voiceRooms[roomId].has(sid)) {
              io.to(sid).emit('incomingGroupCall', { from: currentUser, groupId, roomId, avatar: onlineUsers[socket.id]?.avatar });
            }
          }
        });
      }).catch(() => {});
    }
  });

  socket.on('leaveCallRoom', (roomId) => {
    if (!voiceRooms[roomId]) return;
    voiceRooms[roomId].delete(socket.id);
    socket.leave('voice:' + roomId);
    io.to('voice:' + roomId).emit('voiceUserLeft', { socketId: socket.id });
  });

  socket.on('deleteGroup', async (groupId) => {
    if (!currentUser || !useDB()) return;
    try {
      // Only owner can delete
      const r = await pool.query('SELECT owner FROM groups WHERE id=$1', [groupId]);
      if (!r.rows.length || r.rows[0].owner !== currentUser) return;
      await pool.query('DELETE FROM group_messages WHERE group_id=$1', [groupId]);
      await pool.query('DELETE FROM group_members WHERE group_id=$1', [groupId]);
      await pool.query('DELETE FROM group_invites WHERE group_id=$1', [groupId]);
      await pool.query('DELETE FROM groups WHERE id=$1', [groupId]);
      // Notify all members in the room
      io.to('group:' + groupId).emit('groupDeleted', { groupId });
    } catch(e) { console.error(e); }
  });

  // ---- Group invite links ----
  socket.on('createInvite', async (groupId) => {
    if (!currentUser || !useDB()) return;
    try {
      // Check user is member
      const member = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND username=$2', [groupId, currentUser]);
      if (!member.rows.length) return;
      // Generate short code
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      await pool.query('INSERT INTO group_invites (code, group_id, created_by) VALUES ($1,$2,$3)', [code, groupId, currentUser]);
      const link = (process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000') + '/invite/' + code;
      socket.emit('inviteCreated', { code, link });
    } catch(e) { console.error(e); socket.emit('inviteError', 'Ошибка'); }
  });

  socket.on('joinByInvite', async (code) => {
    if (!currentUser || !useDB()) return;
    try {
      const r = await pool.query('SELECT * FROM group_invites WHERE code=$1', [code.toUpperCase()]);
      if (!r.rows.length) return socket.emit('inviteError', 'Ссылка недействительна');
      const { group_id } = r.rows[0];
      await pool.query('INSERT INTO group_members (group_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING', [group_id, currentUser]);
      const g = await pool.query('SELECT * FROM groups WHERE id=$1', [group_id]);
      socket.emit('groupInvite', g.rows[0]);
      socket.emit('joinedByInvite', g.rows[0]);
    } catch(e) { console.error(e); socket.emit('inviteError', 'Ошибка'); }
  });

  socket.on('disconnect', () => {
    if (currentVoiceChannel) leaveVoice(socket);
    delete onlineUsers[socket.id];
    if (currentUser) socket.broadcast.emit('userLeft', { name: currentUser });
  });

  function leaveVoice(sock) {
    const ch = currentVoiceChannel;
    if (!ch || !voiceRooms[ch]) return;
    voiceRooms[ch].delete(sock.id);
    sock.leave('voice:' + ch);
    io.to('voice:' + ch).emit('voiceUserLeft', { socketId: sock.id });
    currentVoiceChannel = null;
    broadcastVoiceCount(ch);
  }

  function broadcastVoiceCount(channelId) {
    const room = voiceRooms[channelId] || new Set();
    const count = room.size;
    // Collect names of users in voice
    const members = [...room].map(sid => onlineUsers[sid]?.name).filter(Boolean);
    io.emit('voiceCount', { channelId, count, members });
  }
});

// Express route for invite links
app.get('/invite/:code', (req, res) => {
  res.redirect('/?invite=' + req.params.code);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Faza v2 server running on http://localhost:${PORT}`);
  // Keep-alive: ping self every 10 min so Render doesn't sleep
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      const url = process.env.RENDER_EXTERNAL_URL;
      require('https').get(url, () => {}).on('error', () => {});
    }, 10 * 60 * 1000);
  }
});
