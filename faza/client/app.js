const socket = io();

// ---- Helpers (declared first to avoid TDZ errors) ----
const COLORS = ['#5865f2','#eb459e','#ed4245','#57f287','#1abc9c','#e67e22','#9b59b6','#3498db'];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % COLORS.length;
  return COLORS[Math.abs(h)];
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function setAvatarEl(el, name, avatar) {
  if (avatar) { el.innerHTML = `<img src="${avatar}" alt="${escHtml(name)}"/>`; }
  else { el.style.background = avatarColor(name); el.textContent = name[0].toUpperCase(); }
}
function resizeImage(file, maxSize, cb) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx2d = canvas.getContext('2d');
      ctx2d.fillStyle = '#ffffff';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
      cb(canvas.toDataURL('image/jpeg', maxSize <= 128 ? 0.8 : 0.75));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.style.animation = 'fadeOut .3s ease forwards'; setTimeout(() => t.remove(), 300); }, 3000);
}

// ---- Sound effects ----
function playSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const g = ctx.createGain();
    g.connect(ctx.destination);
    if (type === 'message') {
      const o = ctx.createOscillator(); o.connect(g);
      o.frequency.setValueAtTime(880, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      o.start(); o.stop(ctx.currentTime + 0.15);
    } else if (type === 'join') {
      [440, 660].forEach((freq, i) => {
        const o = ctx.createOscillator(); o.connect(g); o.frequency.value = freq;
        g.gain.setValueAtTime(0.1, ctx.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.15);
        o.start(ctx.currentTime + i * 0.12); o.stop(ctx.currentTime + i * 0.12 + 0.15);
      });
    } else if (type === 'leave') {
      [660, 440].forEach((freq, i) => {
        const o = ctx.createOscillator(); o.connect(g); o.frequency.value = freq;
        g.gain.setValueAtTime(0.1, ctx.currentTime + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.15);
        o.start(ctx.currentTime + i * 0.12); o.stop(ctx.currentTime + i * 0.12 + 0.15);
      });
    } else if (type === 'mention') {
      const o = ctx.createOscillator(); o.connect(g);
      o.frequency.setValueAtTime(1200, ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.2);
      g.gain.setValueAtTime(0.2, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      o.start(); o.stop(ctx.currentTime + 0.25);
    }
  } catch {}
}

// ---- State ----
let username = '', myAvatar = null, currentChannel = null, currentVoiceChannel = null;
let localStream = null, muted = false, deafened = false, denoiseEnabled = false;
let denoiseNodes = null, isResizing = false, lastUser = null;
const peers = {}, voiceUsers = {}, onlineUsers = {}, speakingTimers = {};

// ---- Audio context (lazy) ----
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ---- DOM ----
const loginScreen    = document.getElementById('login-screen');
const appEl          = document.getElementById('app');
const tabLogin       = document.getElementById('tab-login');
const tabRegister    = document.getElementById('tab-register');
const formLogin      = document.getElementById('form-login');
const formRegister   = document.getElementById('form-register');
const loginUsername  = document.getElementById('login-username');
const loginPassword  = document.getElementById('login-password');
const loginBtn       = document.getElementById('login-btn');
const regUsername    = document.getElementById('reg-username');
const regPassword    = document.getElementById('reg-password');
const regPassword2   = document.getElementById('reg-password2');
const regBtn         = document.getElementById('reg-btn');
const loginAvatarInput   = document.getElementById('login-avatar-input');
const loginAvatarPreview = document.getElementById('login-avatar-preview');
const textChannelsList   = document.getElementById('text-channels');
const voiceChannelsList  = document.getElementById('voice-channels');
const onlineListEl   = document.getElementById('online-list');
const channelTitle   = document.getElementById('channel-title');
const messagesEl     = document.getElementById('messages');
const msgInput       = document.getElementById('msg-input');
const sendBtn        = document.getElementById('send-btn');
const userNameDisplay = document.getElementById('user-name-display');
const userAvatarEl   = document.getElementById('user-avatar');
const userAvatarWrap = document.getElementById('user-avatar-wrap');
const avatarInput    = document.getElementById('avatar-input');
const muteBtn        = document.getElementById('mute-btn');
const logoutBtn      = document.getElementById('logout-btn');
const voiceOverlay   = document.getElementById('voice-overlay');
const voiceOverlayUsers = document.getElementById('voice-overlay-users');
const voiceMuteBtn   = document.getElementById('voice-mute-btn');
const voiceDeafenBtn = document.getElementById('voice-deafen-btn');
const voiceDenoiseBtn = document.getElementById('voice-denoise-btn');
const voiceLeaveBtn  = document.getElementById('voice-leave-btn');
const audioContainer = document.getElementById('audio-container');
const imgInput       = document.getElementById('img-input');
const lightbox       = document.getElementById('lightbox');
const lightboxImg    = document.getElementById('lightbox-img');
const lightboxClose  = document.getElementById('lightbox-close');
const chatArea       = document.getElementById('chat-area');
const resizeHandle   = document.getElementById('voice-resize-handle');

// ---- Auth tabs ----
tabLogin.addEventListener('click', () => {
  tabLogin.classList.add('active'); tabRegister.classList.remove('active');
  formLogin.classList.remove('hidden'); formRegister.classList.add('hidden');
});
tabRegister.addEventListener('click', () => {
  tabRegister.classList.add('active'); tabLogin.classList.remove('active');
  formRegister.classList.remove('hidden'); formLogin.classList.add('hidden');
});

let pendingAvatar = null;
loginAvatarInput.addEventListener('change', () => {
  const file = loginAvatarInput.files[0]; if (!file) return;
  resizeImage(file, 600, (dataUrl) => {
    pendingAvatar = dataUrl;
    loginAvatarPreview.innerHTML = `<img src="${dataUrl}" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
  });
});

loginBtn.addEventListener('click', doLogin);
loginPassword.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
loginUsername.addEventListener('keydown', e => { if (e.key === 'Enter') loginPassword.focus(); });
function doLogin() {
  const name = loginUsername.value.trim(), pass = loginPassword.value;
  if (!name || !pass) return showToast('Заполни все поля', 'error');
  socket.emit('login', { username: name, password: pass });
}

regBtn.addEventListener('click', doRegister);
regPassword2.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
function doRegister() {
  const name = regUsername.value.trim(), pass = regPassword.value, pass2 = regPassword2.value;
  if (!name || !pass) return showToast('Заполни все поля', 'error');
  if (pass !== pass2) return showToast('Пароли не совпадают', 'error');
  if (pass.length < 4) return showToast('Пароль минимум 4 символа', 'error');
  socket.emit('register', { username: name, password: pass });
}

socket.on('authError', msg => showToast(msg, 'error'));
socket.on('sessionExpired', () => {
  localStorage.removeItem('faza_session');
  location.reload();
});
socket.on('authOk', ({ username: name, avatar }) => {
  username = name;
  // Always use server avatar, fallback to localStorage only if server has none
  myAvatar = avatar || localStorage.getItem('faza_avatar_' + name) || null;
  // If server has avatar, sync to localStorage
  if (avatar) localStorage.setItem('faza_avatar_' + name, avatar);
  localStorage.setItem('faza_session', JSON.stringify({ username: name }));
  enterApp(name, myAvatar);
});
function enterApp(name, avatar) {
  loginScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  userNameDisplay.textContent = name;
  setAvatarEl(userAvatarEl, name, avatar);
  // Update rail avatar
  const railAv = document.getElementById('rail-user-avatar');
  if (railAv) setAvatarEl(railAv, name, avatar);
  socket.emit('join', { username: name, avatar });
  // Default to DM view
  setTimeout(() => { if (railDms) railDms.click(); }, 100);
}

// Auto-login
const savedSession = localStorage.getItem('faza_session');
if (savedSession) {
  try {
    const { username: savedName } = JSON.parse(savedSession);
    if (savedName) {
      loginScreen.style.display = 'none';
      appEl.classList.remove('hidden');
      username = savedName;
      // Use localStorage avatar temporarily, server will update via authOk or join
      myAvatar = localStorage.getItem('faza_avatar_' + savedName) || null;
      userNameDisplay.textContent = savedName;
      setAvatarEl(userAvatarEl, savedName, myAvatar);
      // Re-authenticate to get fresh avatar from server
      socket.emit('autoLogin', { username: savedName });
    }
  } catch {}
}

// ---- Avatar change ----
userAvatarWrap.addEventListener('click', () => avatarInput.click());
avatarInput.addEventListener('change', () => {
  const file = avatarInput.files[0]; if (!file) return;
  resizeImage(file, 600, (dataUrl) => { openCropper(dataUrl); });
});
// ---- Avatar cropper ----
const avatarModal    = document.getElementById('avatar-modal');
const avatarCancel   = document.getElementById('avatar-cancel');
const avatarConfirm  = document.getElementById('avatar-confirm');
const cropImg        = document.getElementById('crop-img');
const cropWrap       = document.getElementById('crop-canvas-wrap');
const cropScale      = document.getElementById('crop-scale');

let cropState = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, imgW: 0, imgH: 0 };

function openCropper(dataUrl) {
  cropImg.src = dataUrl;
  cropState = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0, imgW: 0, imgH: 0 };
  cropScale.value = 1;
  cropImg.onload = () => {
    cropState.imgW = cropImg.naturalWidth;
    cropState.imgH = cropImg.naturalHeight;
    // Auto-fit: scale so entire image fits inside the circle
    const size = 240;
    const fitScale = size / Math.max(cropState.imgW, cropState.imgH);
    cropState.scale = Math.max(0.1, Math.min(fitScale, 3));
    cropScale.value = cropState.scale;
    applyCrop();
  };
  avatarModal.classList.remove('hidden');
}

function applyCrop() {
  const size = 240;
  const s = cropState.scale;
  const w = cropState.imgW * s;
  const h = cropState.imgH * s;
  const x = cropState.x + (size - w) / 2;
  const y = cropState.y + (size - h) / 2;
  cropImg.style.width = w + 'px';
  cropImg.style.height = h + 'px';
  cropImg.style.left = x + 'px';
  cropImg.style.top = y + 'px';
}

cropScale.addEventListener('input', () => {
  cropState.scale = parseFloat(cropScale.value);
  applyCrop();
});

cropWrap.addEventListener('mousedown', e => {
  cropState.dragging = true;
  cropState.startX = e.clientX - cropState.x;
  cropState.startY = e.clientY - cropState.y;
  e.preventDefault();
});
cropWrap.addEventListener('touchstart', e => {
  const t = e.touches[0];
  cropState.dragging = true;
  cropState.startX = t.clientX - cropState.x;
  cropState.startY = t.clientY - cropState.y;
}, { passive: true });

document.addEventListener('mousemove', e => {
  if (!cropState.dragging) return;
  cropState.x = e.clientX - cropState.startX;
  cropState.y = e.clientY - cropState.startY;
  applyCrop();
});
document.addEventListener('touchmove', e => {
  if (!cropState.dragging) return;
  const t = e.touches[0];
  cropState.x = t.clientX - cropState.startX;
  cropState.y = t.clientY - cropState.startY;
  applyCrop();
}, { passive: true });
document.addEventListener('mouseup', () => { cropState.dragging = false; });
document.addEventListener('touchend', () => { cropState.dragging = false; });

// Pinch to zoom on mobile
cropWrap.addEventListener('wheel', e => {
  e.preventDefault();
  cropState.scale = Math.max(0.5, Math.min(3, cropState.scale - e.deltaY * 0.001));
  cropScale.value = cropState.scale;
  applyCrop();
}, { passive: false });

avatarCancel.addEventListener('click', () => avatarModal.classList.add('hidden'));

avatarConfirm.addEventListener('click', () => {
  // Render cropped circle to canvas
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.beginPath(); ctx.arc(size/2, size/2, size/2, 0, Math.PI*2); ctx.clip();
  const displaySize = 240;
  const s = cropState.scale;
  const w = cropState.imgW * s;
  const h = cropState.imgH * s;
  const x = cropState.x + (displaySize - w) / 2;
  const y = cropState.y + (displaySize - h) / 2;
  const ratio = size / displaySize;
  ctx.drawImage(cropImg, x * ratio, y * ratio, w * ratio, h * ratio);
  pendingAvatar = canvas.toDataURL('image/jpeg', 0.85);
  myAvatar = pendingAvatar;
  localStorage.setItem('faza_avatar_' + username, myAvatar);
  setAvatarEl(userAvatarEl, username, myAvatar);
  socket.emit('updateAvatar', myAvatar);
  avatarModal.classList.add('hidden');
  if (onlineUsers[username] !== undefined) { onlineUsers[username] = myAvatar; renderOnlineList(); }
});
socket.on('avatarUpdated', ({ name, avatar }) => { onlineUsers[name] = avatar; renderOnlineList(); });

// ---- Logout ----
logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('faza_session');
  if (currentVoiceChannel) leaveVoice();
  location.reload();
});

// ---- Sidebar mute ----
muteBtn.addEventListener('click', () => {
  muted = !muted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  muteBtn.classList.toggle('muted', muted);
  muteBtn.textContent = muted ? '🔇' : '🎙️';
  if (voiceMuteBtn) voiceMuteBtn.classList.toggle('active', muted);
});

// ---- Channels ----
socket.on('channels', (channelList) => {
  textChannelsList.innerHTML = ''; voiceChannelsList.innerHTML = '';
  channelList.forEach(ch => {
    const li = document.createElement('li');
    li.dataset.id = ch.id;
    li.innerHTML = `<span>#</span> ${ch.name}`;
    li.addEventListener('click', () => joinTextChannel(ch.id, li));
    textChannelsList.appendChild(li);
    const vli = document.createElement('li');
    vli.dataset.id = ch.id; vli.id = 'vc-' + ch.id;
    vli.innerHTML = `<span>🔊</span> ${ch.name} <span class="badge" id="vbadge-${ch.id}" style="display:none">0</span>`;
    vli.addEventListener('click', () => joinVoiceChannel(ch.id, ch.name));
    voiceChannelsList.appendChild(vli);
  });
  const firstLi = textChannelsList.querySelector('li');
  if (firstLi) firstLi.click();
});

socket.on('voiceCount', ({ channelId, count, members = [] }) => {
  const badge = document.getElementById('vbadge-' + channelId);
  if (!badge) return;
  badge.style.display = count > 0 ? '' : 'none';
  badge.textContent = count;
  const vli = document.getElementById('vc-' + channelId);
  if (!vli) return;
  let ml = document.getElementById('vmembers-' + channelId);
  if (!ml) { ml = document.createElement('ul'); ml.id = 'vmembers-' + channelId; ml.className = 'voice-member-list'; vli.insertAdjacentElement('afterend', ml); }
  ml.innerHTML = '';
  members.forEach(name => {
    const li = document.createElement('li');
    li.className = 'voice-member-item' + (name === username ? ' is-me' : '');
    const av = document.createElement('div'); av.className = 'voice-member-avatar';
    setAvatarEl(av, name, onlineUsers[name] || null);
    const nm = document.createElement('span'); nm.textContent = name;
    li.append(av, nm); ml.appendChild(li);
  });
});

function joinTextChannel(id, li) {
  document.querySelectorAll('#text-channels li').forEach(el => el.classList.remove('active'));
  li.classList.add('active');
  currentChannel = id; currentDM = null; currentGroup = null;
  const hdrAv = document.getElementById('chat-header-avatar');
  hdrAv.style.background = ''; hdrAv.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="color:#949ba4"><path d="M5.88 4.12L13.76 12l-7.88 7.88L8 22l10-10L8 2z"/></svg>';
  document.getElementById('channel-title').textContent = '# ' + id;
  document.getElementById('chat-header-status').textContent = '';
  document.getElementById('call-btn').style.display = 'none';
  document.getElementById('profile-toggle-btn').style.display = 'none';
  document.getElementById('invite-btn').style.display = 'none';
  document.getElementById('profile-panel').classList.add('hidden');
  msgInput.disabled = false; sendBtn.disabled = false;
  msgInput.placeholder = `Написать в #${id}`;
  messagesEl.innerHTML = ''; lastUser = null;
  const welcome = document.getElementById('messages-welcome');
  const welcomeName = document.getElementById('welcome-channel-name');
  if (welcome) { welcome.classList.remove('hidden'); welcomeName.textContent = '#' + id; messagesEl.appendChild(welcome); }
  socket.emit('joinChannel', id);
  msgInput.focus();
  if (typeof openChatOnMobile === 'function') openChatOnMobile();
}

// ---- Online ----
socket.on('onlineUsers', users => { users.forEach(u => onlineUsers[u.name] = u.avatar); renderOnlineList(); });
socket.on('userJoined', ({ name, avatar }) => { onlineUsers[name] = avatar; renderOnlineList(); });
socket.on('userLeft', ({ name }) => { delete onlineUsers[name]; renderOnlineList(); });
function renderOnlineList() {
  onlineListEl.innerHTML = '';
  const entries = Object.entries(onlineUsers);
  const countEl = document.getElementById('online-count');
  if (countEl) countEl.textContent = entries.length;
  entries.forEach(([name, avatar]) => {
    const li = document.createElement('li'); li.className = 'online-item';
    const av = document.createElement('div'); av.className = 'online-item-avatar';
    setAvatarEl(av, name, avatar);
    const nm = document.createElement('span'); nm.className = 'online-item-name'; nm.textContent = name;
    li.append(av, nm); onlineListEl.appendChild(li);
  });
}

// ---- Messages ----
socket.on('history', msgs => { messagesEl.innerHTML = ''; lastUser = null; msgs.forEach(renderMessage); scrollBottom(); });
socket.on('message', msg => {
  renderMessage(msg); scrollBottom();
  if (msg.user !== username) playSound(msg.text && msg.text.includes(username) ? 'mention' : 'message');
});

function renderMessage(msg) {
  const time = new Date(msg.time).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const isOwn = msg.user === username;
  if (msg.user === lastUser && !msg.image) {
    const group = document.createElement('div');
    group.className = 'msg-group'; group.dataset.id = String(msg.id);
    group.innerHTML = `<div class="msg-text">${escHtml(msg.text)}</div>`;
    if (isOwn || username === 'faza') addDeleteBtn(group, msg.id);
  } else {
    lastUser = msg.user;
    const el = document.createElement('div'); el.className = 'msg'; el.dataset.id = String(msg.id);
    const avDiv = document.createElement('div'); avDiv.className = 'msg-avatar';
    setAvatarEl(avDiv, msg.user, msg.avatar || onlineUsers[msg.user] || null);
    const content = msg.image ? `<img class="msg-img" src="${msg.image}" alt="фото"/>` : `<div class="msg-text${msg.missed ? ' msg-missed' : ''}">${escHtml(msg.text)}</div>`;
    el.innerHTML = `<div class="msg-body"><div class="msg-meta"><span class="msg-user">${escHtml(msg.user)}</span><span class="msg-time">${time}</span></div>${content}</div>`;
    el.insertBefore(avDiv, el.firstChild);
    if (msg.image) el.querySelector('.msg-img').addEventListener('click', () => openLightbox(msg.image));
    if (isOwn || username === 'faza') addDeleteBtn(el, msg.id);
    messagesEl.appendChild(el);
  }
}

function addDeleteBtn(el, msgId) {
  const btn = document.createElement('button');
  btn.className = 'msg-delete-btn'; btn.title = 'Удалить'; btn.innerHTML = '🗑️';
  btn.addEventListener('click', e => { e.stopPropagation(); socket.emit('deleteMessage', { id: String(msgId), channelId: currentChannel }); });
  el.appendChild(btn);
}
socket.on('messageDeleted', ({ id }) => {
  const el = messagesEl.querySelector(`[data-id="${id}"]`) || messagesEl.querySelector(`[data-id="${String(id)}"]`);
  if (el) el.remove();
});

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
function sendMessage() {
  const text = msgInput.value.trim(); if (!text) return;
  if (currentDM) {
    socket.emit('dmMessage', { targetUser: currentDM, text });
  } else if (currentGroup) {
    socket.emit('groupMessage', { groupId: currentGroup.id, text });
  } else if (currentChannel) {
    socket.emit('message', { channelId: currentChannel, text });
  }
  msgInput.value = '';
}

imgInput.addEventListener('change', () => {
  const file = imgInput.files[0]; if (!file || !currentChannel) return;
  resizeImage(file, 600, dataUrl => socket.emit('imageMessage', { channelId: currentChannel, dataUrl }));
  imgInput.value = '';
});

function openLightbox(src) { lightboxImg.src = src; lightbox.classList.remove('hidden'); }
lightboxClose.addEventListener('click', () => lightbox.classList.add('hidden'));
lightbox.addEventListener('click', e => { if (e.target === lightbox) lightbox.classList.add('hidden'); });

// ---- Resize handle ----
if (resizeHandle) {
  resizeHandle.addEventListener('mousedown', e => { isResizing = true; resizeHandle.classList.add('dragging'); e.preventDefault(); });
}
document.addEventListener('mousemove', e => {
  if (!isResizing || !chatArea) return;
  const rect = chatArea.getBoundingClientRect();
  const chatH = Math.max(120, Math.min(rect.bottom - e.clientY, rect.height - 180));
  chatArea.style.gridTemplateRows = `1fr 5px ${chatH}px`;
});
document.addEventListener('mouseup', () => { isResizing = false; if (resizeHandle) resizeHandle.classList.remove('dragging'); });

// ---- Voice ----
async function joinVoiceChannel(channelId, channelNameStr) {
  if (currentVoiceChannel === channelId) return;
  if (currentVoiceChannel || currentCallRoomId) endCall();
  if (!await initCallStream()) return;
  currentVoiceChannel = channelId;
  showVoiceUI();
  socket.emit('joinVoice', channelId);
}

function leaveVoice() {
  socket.emit('leaveVoice');
  endCall();
}

voiceMuteBtn.addEventListener('click', () => {
  muted = !muted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !muted);
  voiceMuteBtn.classList.toggle('active', muted);
  muteBtn.classList.toggle('muted', muted); muteBtn.textContent = muted ? '🔇' : '🎙️';
});

voiceDeafenBtn.addEventListener('click', () => {
  deafened = !deafened;
  voiceDeafenBtn.classList.toggle('active', deafened);
  document.querySelectorAll('#audio-container audio').forEach(a => a.muted = deafened);
  if (deafened && !muted) {
    muted = true;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
    voiceMuteBtn.classList.add('active'); muteBtn.classList.add('muted'); muteBtn.textContent = '🔇';
  }
});

voiceDenoiseBtn.addEventListener('click', () => {
  denoiseEnabled = !denoiseEnabled;
  voiceDenoiseBtn.classList.toggle('active', denoiseEnabled);
  applyDenoise();
  showToast(denoiseEnabled ? '🎙️ Шумоподавление включено' : '🎙️ Шумоподавление выключено', 'info');
});

function buildDenoiseChain(stream) {
  // Not used anymore — browser native noise suppression is better
  return stream;
}
function applyDenoise() {
  if (!localStream) return;
  // Restart stream with updated noise suppression setting
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: denoiseEnabled,
      autoGainControl: true,
      sampleRate: 48000
    },
    video: false
  };
  navigator.mediaDevices.getUserMedia(constraints).then(newStream => {
    const newTrack = newStream.getAudioTracks()[0];
    // Replace track in all peer connections
    Object.values(peers).forEach(pc => {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
    });
    // Stop old tracks and replace stream
    localStream.getAudioTracks().forEach(t => t.stop());
    localStream = newStream;
    // Restart speaking monitor
    stopMonitoring('me');
    monitorSpeaking(localStream, 'me');
  }).catch(() => {});
}

socket.on('voicePeers', async ({ peers: existingPeers }) => {
  for (const peerId of existingPeers) {
    const pc = createPeerConnection(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, offer });
  }
});
socket.on('voiceUserJoined', ({ socketId, user }) => { stopOutgoingRingtone(); addVoiceUser(socketId, user, onlineUsers[user], false); playSound('join'); });
socket.on('voiceUserLeft', ({ socketId }) => {
  if (peers[socketId]) { peers[socketId].close(); delete peers[socketId]; }
  removeVoiceUser(socketId);
  document.getElementById('audio-' + socketId)?.remove();
  playSound('leave');
});
socket.on('offer', async ({ from, offer, user }) => {
  addVoiceUser(from, user, onlineUsers[user], false);
  const pc = createPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: from, answer });
});
socket.on('answer', async ({ from, answer }) => { if (peers[from]) await peers[from].setRemoteDescription(new RTCSessionDescription(answer)); });
socket.on('ice', async ({ from, candidate }) => { if (peers[from]) try { await peers[from].addIceCandidate(new RTCIceCandidate(candidate)); } catch {} });

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: '835daccaa366f211309dfa89', credential: 'SwxzLuUrYVSLRqmK' },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: '835daccaa366f211309dfa89', credential: 'SwxzLuUrYVSLRqmK' },
      { urls: 'turn:global.relay.metered.ca:443', username: '835daccaa366f211309dfa89', credential: 'SwxzLuUrYVSLRqmK' },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '835daccaa366f211309dfa89', credential: 'SwxzLuUrYVSLRqmK' }
    ]
  });
  peers[peerId] = pc;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = ({ candidate }) => { if (candidate) socket.emit('ice', { to: peerId, candidate }); };
  pc.ontrack = ({ track, streams }) => {
    if (track.kind === 'video') {
      showScreenInCard(peerId, streams[0]);
      track.addEventListener('ended', () => {
        const card = document.getElementById('vu-' + peerId);
        if (card) { card.classList.remove('sharing'); card.querySelector('.vo-user-video')?.remove(); }
        if (!document.querySelector('.vo-user.sharing')) voiceOverlayUsers.classList.remove('has-screen');
      });
    } else {
      let audio = document.getElementById('audio-' + peerId);
      if (!audio) { audio = document.createElement('audio'); audio.id = 'audio-' + peerId; audio.autoplay = true; audioContainer.appendChild(audio); }
      audio.srcObject = streams[0];
      monitorSpeaking(streams[0], peerId);
    }
  };
  return pc;
}

function addVoiceUser(id, name, avatar, isMe) {
  if (voiceUsers[id]) return;
  const el = document.createElement('div');
  el.className = 'vo-user' + (isMe ? ' is-me' : ''); el.id = 'vu-' + id;
  const avDiv = document.createElement('div'); avDiv.className = 'vo-user-avatar';
  setAvatarEl(avDiv, name, avatar);
  const nm = document.createElement('div'); nm.className = 'vo-user-name'; nm.textContent = isMe ? name + ' (я)' : name;
  el.append(avDiv, nm); voiceOverlayUsers.appendChild(el);
  voiceUsers[id] = { name, el };
}
function removeVoiceUser(id) { stopMonitoring(id); voiceUsers[id]?.el.remove(); delete voiceUsers[id]; }

function monitorSpeaking(stream, userId) {
  try {
    const ac = getAudioCtx();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser(); analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    function check() {
      if (!voiceUsers[userId]) return;
      analyser.getByteFrequencyData(data);
      const vol = data.reduce((a, b) => a + b, 0) / data.length;
      const el = document.getElementById('vu-' + userId);
      if (el) el.classList.toggle('speaking', vol > 8);
      speakingTimers[userId] = requestAnimationFrame(check);
    }
    check();
  } catch {}
}
function stopMonitoring(userId) {
  if (speakingTimers[userId]) { cancelAnimationFrame(speakingTimers[userId]); delete speakingTimers[userId]; }
}

// ---- Mobile navigation ----
const sidebar = document.getElementById('sidebar');
const sidebarClose = document.getElementById('sidebar-close');
const mobChannelsBtn = document.getElementById('mob-channels-btn');
const mobChatBtn = document.getElementById('mob-chat-btn');
const mobOnlineBtn = document.getElementById('mob-online-btn');

function isMobile() { return window.innerWidth <= 768; }

if (mobChannelsBtn) {
  mobChannelsBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    // Show channels section, hide online
    document.querySelector('.sidebar-section:last-of-type').style.display = 'none';
    setMobActive(mobChannelsBtn);
  });
}
if (mobOnlineBtn) {
  mobOnlineBtn.addEventListener('click', () => {
    sidebar.classList.add('open');
    // Show online section
    document.querySelector('.sidebar-section:last-of-type').style.display = '';
    setMobActive(mobOnlineBtn);
  });
}
if (mobChatBtn) {
  mobChatBtn.addEventListener('click', () => {
    sidebar.classList.remove('open');
    setMobActive(mobChatBtn);
  });
}
if (sidebarClose) {
  sidebarClose.addEventListener('click', () => {
    sidebar.classList.remove('open');
    setMobActive(mobChatBtn);
  });
}

function setMobActive(btn) {
  [mobChannelsBtn, mobChatBtn, mobOnlineBtn].forEach(b => b && b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

// Close sidebar when channel is selected on mobile
// (handled inside joinTextChannel directly)
document.addEventListener('click', e => {
  if (isMobile() && sidebar && sidebar.classList.contains('open')) {
    if (!sidebar.contains(e.target) && e.target !== mobChannelsBtn && e.target !== mobOnlineBtn) {
      sidebar.classList.remove('open');
      setMobActive(mobChatBtn);
    }
  }
});

// ---- Rail navigation ----
const railDms    = document.getElementById('rail-dms');
const railServer = document.getElementById('rail-server');
const viewServer = document.getElementById('view-server');
const viewDms    = document.getElementById('view-dms');

function showView(view) {
  [viewServer, viewDms].forEach(v => v && v.classList.add('hidden'));
  [railDms, railServer].forEach(b => b && b.classList.remove('active'));
  if (view) view.classList.remove('hidden');
}

railDms.addEventListener('click', () => {
  showView(viewDms); railDms.classList.add('active');
  socket.emit('getFriends');
  socket.emit('getGroups');
});
railServer.addEventListener('click', () => {
  showView(viewServer); railServer.classList.add('active');
});

// Legacy tab refs (kept for compatibility)
const tabServer = railServer;
const tabDms = railDms;
const tabGroups = railDms;

// ---- Add friend ----
const addFriendModal  = document.getElementById('add-friend-modal');
const addFriendInput  = document.getElementById('add-friend-input');
const addFriendBtn    = document.getElementById('add-friend-btn');
const addFriendCancel = document.getElementById('add-friend-cancel');
const addFriendConfirm = document.getElementById('add-friend-confirm');

addFriendBtn.addEventListener('click', () => { addFriendInput.value = ''; addFriendModal.classList.remove('hidden'); addFriendInput.focus(); });
addFriendCancel.addEventListener('click', () => addFriendModal.classList.add('hidden'));
addFriendConfirm.addEventListener('click', () => {
  const name = addFriendInput.value.trim();
  if (!name) return;
  socket.emit('addFriend', name);
  addFriendModal.classList.add('hidden');
});
addFriendInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFriendConfirm.click(); });

socket.on('friendRequestSent', name => showToast(`Запрос отправлен → ${name}`, 'success'));
socket.on('friendError', msg => showToast(msg, 'error'));
socket.on('friendRequest', ({ from, avatar }) => {
  showToast(`${from} хочет добавить тебя в друзья`, 'info');
  renderFriendRequest(from, avatar);
});
socket.on('friendAccepted', name => {
  showToast(`${name} принял запрос в друзья!`, 'success');
  socket.emit('getFriends');
});

socket.on('friendsList', rows => {
  const friendsList = document.getElementById('friends-list');
  const reqList = document.getElementById('friend-requests');
  friendsList.innerHTML = ''; reqList.innerHTML = '';
  rows.forEach(row => {
    const friendName = row.friend;
    if (row.status === 'accepted') {
      const li = document.createElement('li');
      li.className = 'dm-item';
      const av = document.createElement('div'); av.className = 'dm-item-avatar';
      setAvatarEl(av, friendName, onlineUsers[friendName] || null);
      if (onlineUsers[friendName] !== undefined) {
        const dot = document.createElement('div'); dot.className = 'status-dot'; av.appendChild(dot);
      }
      const info = document.createElement('div'); info.className = 'dm-item-info';
      const nm = document.createElement('div'); nm.className = 'dm-item-name'; nm.textContent = friendName;
      const prev = document.createElement('div'); prev.className = 'dm-item-preview'; prev.textContent = onlineUsers[friendName] !== undefined ? 'онлайн' : 'не в сети';
      info.append(nm, prev);
      li.append(av, info);
      li.addEventListener('click', () => { openDM(friendName); li.classList.add('active'); document.querySelectorAll('.dm-item').forEach(i => { if(i!==li) i.classList.remove('active'); }); });
      friendsList.appendChild(li);
    } else if (row.status === 'pending' && row.to_user === username) {
      renderFriendRequest(row.from_user, null, reqList);
    }
  });
});

function renderFriendRequest(from, avatar, container) {
  const list = container || document.getElementById('friend-requests');
  if (!list) return;
  const li = document.createElement('li');
  li.className = 'friend-req-item';
  const av = document.createElement('div'); av.className = 'dm-header-avatar';
  setAvatarEl(av, from, avatar || onlineUsers[from] || null);
  const nm = document.createElement('span'); nm.textContent = from; nm.style.flex = '1';
  const actions = document.createElement('div'); actions.className = 'friend-req-actions';
  const accept = document.createElement('button'); accept.className = 'btn-accept'; accept.textContent = '✓';
  const decline = document.createElement('button'); decline.className = 'btn-decline'; decline.textContent = '✕';
  accept.addEventListener('click', () => { socket.emit('acceptFriend', from); li.remove(); });
  decline.addEventListener('click', () => { socket.emit('declineFriend', from); li.remove(); });
  actions.append(accept, decline);
  li.append(av, nm, actions);
  list.appendChild(li);
}

// ---- DM ----
let currentDM = null;

function openDM(targetUser) {
  currentDM = targetUser; currentChannel = null; currentGroup = null;
  // Update header
  const hdrAv = document.getElementById('chat-header-avatar');
  setAvatarEl(hdrAv, targetUser, onlineUsers[targetUser] || null);
  document.getElementById('channel-title').textContent = targetUser;
  document.getElementById('chat-header-status').textContent = onlineUsers[targetUser] !== undefined ? '● онлайн' : '';
  // Show call button
  const callBtn = document.getElementById('call-btn');
  const profileBtn = document.getElementById('profile-toggle-btn');
  if (callBtn) { callBtn.style.display = ''; callBtn.onclick = () => startDMCall(targetUser); }
  if (profileBtn) { profileBtn.style.display = ''; profileBtn.onclick = () => toggleProfilePanel(targetUser); }
  document.getElementById('invite-btn').style.display = 'none';
  msgInput.disabled = false; sendBtn.disabled = false;
  msgInput.placeholder = `Написать ${targetUser}...`;
  messagesEl.innerHTML = ''; lastUser = null;
  socket.emit('getDM', targetUser);
  if (typeof openChatOnMobile === 'function') openChatOnMobile();
}

function toggleProfilePanel(targetUser) {
  const panel = document.getElementById('profile-panel');
  if (panel.classList.contains('hidden')) {
    // Fill profile data
    const av = document.getElementById('profile-avatar');
    setAvatarEl(av, targetUser, onlineUsers[targetUser] || null);
    document.getElementById('profile-name').textContent = targetUser;
    document.getElementById('profile-tag').textContent = targetUser.toLowerCase();
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

socket.on('dmHistory', ({ roomId, messages }) => {
  if (!currentDM) return;
  messagesEl.innerHTML = ''; lastUser = null;
  messages.forEach(renderMessage); scrollBottom();
});
socket.on('dmMessage', ({ roomId, msg }) => {
  if (currentDM && [currentDM, username].includes(msg.user)) {
    renderMessage(msg); scrollBottom();
    if (msg.user !== username) playSound('message');
  }
});
socket.on('dmNotify', ({ from }) => {
  if (from !== currentDM) showToast(`💬 Новое сообщение от ${from}`, 'info');
});

// (sendMessage already handles DM and groups)

// ---- Groups ----
const createGroupModal   = document.getElementById('create-group-modal');
const groupNameInput     = document.getElementById('group-name-input');
const groupMembersInput  = document.getElementById('group-members-input');
const createGroupBtn     = document.getElementById('create-group-btn');
const createGroupCancel  = document.getElementById('create-group-cancel');
const createGroupConfirm = document.getElementById('create-group-confirm');

createGroupBtn.addEventListener('click', () => { groupNameInput.value = ''; groupMembersInput.value = ''; createGroupModal.classList.remove('hidden'); groupNameInput.focus(); });
createGroupCancel.addEventListener('click', () => createGroupModal.classList.add('hidden'));
createGroupConfirm.addEventListener('click', () => {
  const name = groupNameInput.value.trim();
  if (!name) return;
  const members = groupMembersInput.value.split(',').map(s => s.trim()).filter(Boolean);
  socket.emit('createGroup', { name, members });
  createGroupModal.classList.add('hidden');
});

socket.on('groupCreated', group => { showToast(`Группа "${group.name}" создана`, 'success'); socket.emit('getGroups'); });
socket.on('groupInvite', group => { showToast(`Тебя добавили в группу "${group.name}"`, 'info'); socket.emit('getGroups'); });
socket.on('groupDeleted', ({ groupId }) => {
  showToast('Группа удалена', 'info');
  if (currentGroup && currentGroup.id == groupId) {
    currentGroup = null;
    document.getElementById('channel-title').textContent = 'Выбери беседу';
    messagesEl.innerHTML = '';
    msgInput.disabled = true; sendBtn.disabled = true;
    if (typeof closeChatOnMobile === 'function') closeChatOnMobile();
  }
  socket.emit('getGroups');
});

let currentGroup = null;
socket.on('groupsList', groups => {
  const list = document.getElementById('groups-list');
  list.innerHTML = '';
  groups.forEach(g => {
    const li = document.createElement('li'); li.className = 'dm-item';
    const av = document.createElement('div'); av.className = 'dm-item-avatar';
    av.style.background = '#5865f2'; av.textContent = g.name[0].toUpperCase();
    const info = document.createElement('div'); info.className = 'dm-item-info';
    const nm = document.createElement('div'); nm.className = 'dm-item-name'; nm.textContent = g.name;
    const prev = document.createElement('div'); prev.className = 'dm-item-preview'; prev.textContent = 'Группа';
    info.append(nm, prev); li.append(av, info);
    li.addEventListener('click', () => { openGroup(g); li.classList.add('active'); document.querySelectorAll('.dm-item').forEach(i => { if(i!==li) i.classList.remove('active'); }); });
    list.appendChild(li);
  });
});

function openGroup(group) {
  currentGroup = group; currentDM = null; currentChannel = null;
  const hdrAv = document.getElementById('chat-header-avatar');
  hdrAv.style.background = '#5865f2'; hdrAv.textContent = group.name[0].toUpperCase();
  document.getElementById('channel-title').textContent = '👥 ' + group.name;
  document.getElementById('chat-header-status').textContent = 'Группа';
  const callBtn = document.getElementById('call-btn');
  const profileBtn = document.getElementById('profile-toggle-btn');
  const inviteBtn = document.getElementById('invite-btn');
  if (callBtn) { callBtn.style.display = ''; callBtn.onclick = () => startGroupCall(group.id); }
  if (profileBtn) profileBtn.style.display = 'none';
  if (inviteBtn) { inviteBtn.style.display = ''; inviteBtn.onclick = () => socket.emit('createInvite', group.id); }

  // Delete button for owner
  let deleteBtn = document.getElementById('group-delete-btn');
  if (!deleteBtn) {
    deleteBtn = document.createElement('button');
    deleteBtn.id = 'group-delete-btn';
    deleteBtn.className = 'hdr-btn';
    deleteBtn.title = 'Удалить группу';
    deleteBtn.innerHTML = '🗑️';
    document.querySelector('.chat-header-actions').appendChild(deleteBtn);
  }
  if (group.owner === username || username === 'faza') {
    deleteBtn.style.display = '';
    deleteBtn.onclick = () => {
      if (confirm(`Удалить группу "${group.name}"? Это действие необратимо.`)) {
        socket.emit('deleteGroup', group.id);
      }
    };
  } else {
    deleteBtn.style.display = 'none';
  }

  document.getElementById('profile-panel').classList.add('hidden');
  msgInput.disabled = false; sendBtn.disabled = false;
  msgInput.placeholder = `Написать в ${group.name}...`;
  messagesEl.innerHTML = ''; lastUser = null;
  socket.emit('getGroupMessages', group.id);
  if (typeof openChatOnMobile === 'function') openChatOnMobile();
}

socket.on('groupHistory', ({ groupId, messages }) => {
  if (!currentGroup || currentGroup.id != groupId) return;
  messagesEl.innerHTML = ''; lastUser = null;
  messages.forEach(renderMessage); scrollBottom();
});
socket.on('groupMessage', ({ groupId, msg }) => {
  if (currentGroup && currentGroup.id == groupId) {
    renderMessage(msg); scrollBottom();
    if (msg.user !== username) playSound('message');
  }
});

// (sendMessage already handles groups above)

// ---- Invite link handling ----
socket.on('inviteCreated', ({ link }) => {
  navigator.clipboard.writeText(link).catch(() => {});
  showToast('Ссылка скопирована: ' + link, 'success');
});
socket.on('inviteError', msg => showToast(msg, 'error'));
socket.on('joinedByInvite', group => {
  showToast(`Ты вступил в группу "${group.name}"`, 'success');
  socket.emit('getGroups');
  tabGroups.click();
});

// Check invite code in URL on load
function checkInviteUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('invite');
  if (!code) return;
  // Wait until logged in then join
  const tryJoin = () => {
    if (username) {
      socket.emit('joinByInvite', code);
      window.history.replaceState({}, '', '/');
    } else {
      setTimeout(tryJoin, 500);
    }
  };
  tryJoin();
}
checkInviteUrl();

// ---- DM / Group Voice Calls ----
let currentCallRoomId = null;

async function startDMCall(targetUser) {
  const roomId = 'dm:' + [username, targetUser].sort().join(':');
  if (!await initCallStream()) return;
  currentCallRoomId = roomId;
  showVoiceUI();
  // Play outgoing call sound while waiting
  playOutgoingRingtone();
  socket.emit('startDMCall', targetUser);
}

async function startGroupCall(groupId) {
  const roomId = 'group:' + groupId;
  if (!await initCallStream()) return;
  currentCallRoomId = roomId;
  showVoiceUI();
  playOutgoingRingtone();
  socket.emit('startGroupCall', groupId);
}

async function joinCallRoom(roomId) {
  if (currentCallRoomId === roomId) return;
  if (currentCallRoomId) endCall();
  if (!await initCallStream()) return;
  currentCallRoomId = roomId;
  showVoiceUI();
  socket.emit('joinDMCall', roomId); // server adds us and sends voicePeers
}

async function initCallStream() {
  if (localStream) return true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000
      },
      video: false
    });
    return true;
  } catch (e) {
    showToast('Нет доступа к микрофону: ' + e.message, 'error');
    return false;
  }
}

function showVoiceUI() {
  chatArea.classList.add('in-voice');
  voiceOverlay.classList.remove('hidden');
  addVoiceUser('me', username, myAvatar, true);
  monitorSpeaking(localStream, 'me');
}

function endCall() {
  if (!currentCallRoomId && !currentVoiceChannel) return;
  stopOutgoingRingtone();
  if (currentCallRoomId) socket.emit('leaveCallRoom', currentCallRoomId);
  currentCallRoomId = null;
  currentVoiceChannel = null;
  chatArea.classList.remove('in-voice'); chatArea.style.gridTemplateRows = '';
  voiceOverlay.classList.add('hidden'); voiceOverlayUsers.innerHTML = '';
  Object.values(peers).forEach(pc => pc.close());
  for (const k in peers) delete peers[k];
  for (const k in voiceUsers) { stopMonitoring(k); voiceUsers[k]?.el?.remove(); delete voiceUsers[k]; }
  for (const k in speakingTimers) { cancelAnimationFrame(speakingTimers[k]); delete speakingTimers[k]; }
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  audioContainer.innerHTML = '';
  muted = false; deafened = false; denoiseEnabled = false;
  muteBtn.textContent = '🎙️'; muteBtn.classList.remove('muted');
  voiceMuteBtn.classList.remove('active');
  voiceDeafenBtn.classList.remove('active');
  voiceDenoiseBtn.classList.remove('active');
  voiceOverlayUsers.classList.remove('has-screen');
}

// Single leave button handler
voiceLeaveBtn.addEventListener('click', endCall);

// Incoming call notification
socket.on('incomingCall', ({ from, roomId, avatar }) => {
  showIncomingCall(from, avatar, () => joinCallRoom(roomId));
});
socket.on('incomingGroupCall', ({ from, groupId, roomId, avatar }) => {
  showIncomingCall(from + ' (группа)', avatar, () => joinCallRoom(roomId));
});

function showIncomingCall(from, avatar, onAccept) {
  document.getElementById('incoming-call-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'incoming-call-toast';
  el.style.cssText = `position:fixed;bottom:80px;right:20px;background:var(--bg-mid);border:1px solid rgba(255,255,255,.1);
    border-radius:14px;padding:16px 20px;display:flex;align-items:center;gap:12px;z-index:300;
    box-shadow:0 8px 30px rgba(0,0,0,.5);min-width:260px;`;
  const av = document.createElement('div');
  av.style.cssText = 'width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;overflow:hidden;flex-shrink:0;';
  setAvatarEl(av, from, avatar);
  const info = document.createElement('div'); info.style.flex = '1';
  info.innerHTML = `<div style="font-weight:700;color:var(--text-head);font-size:.9rem">${escHtml(from)}</div><div style="color:var(--text-muted);font-size:.8rem">Входящий звонок...</div>`;
  const accept = document.createElement('button');
  accept.textContent = '✓';
  accept.style.cssText = 'background:var(--green);border:none;border-radius:8px;color:#fff;width:36px;height:36px;cursor:pointer;font-size:1.1rem;';
  const decline = document.createElement('button');
  decline.textContent = '✕';
  decline.style.cssText = 'background:var(--red);border:none;border-radius:8px;color:#fff;width:36px;height:36px;cursor:pointer;font-size:1rem;margin-left:4px;';
  accept.addEventListener('click', () => { el.remove(); onAccept(); });
  decline.addEventListener('click', () => el.remove());
  el.append(av, info, accept, decline);
  document.body.appendChild(el);
  playSound('join');
  setTimeout(() => el.remove(), 30000);
}

// ---- Screen Share ----
let screenStream = null;
const voiceScreenBtn = document.getElementById('voice-screen-btn');

voiceScreenBtn.addEventListener('click', async () => {
  if (screenStream) {
    stopScreenShare();
  } else {
    await startScreenShare();
  }
});

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    showToast('Нет доступа к экрану', 'error'); return;
  }
  voiceScreenBtn.classList.add('active');
  const screenTrack = screenStream.getVideoTracks()[0];

  // Add video track to all peer connections
  Object.values(peers).forEach(pc => {
    pc.addTrack(screenTrack, screenStream);
  });

  // Show own screen in voice card
  showScreenInCard('me', screenStream);
  voiceOverlayUsers.classList.add('has-screen');

  // Stop when user clicks "stop sharing" in browser
  screenTrack.addEventListener('ended', stopScreenShare);

  // Notify peers via renegotiation
  Object.entries(peers).forEach(async ([peerId, pc]) => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer });
    } catch {}
  });
}

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  voiceScreenBtn.classList.remove('active');

  // Remove video from own card
  const myCard = document.getElementById('vu-me');
  if (myCard) {
    myCard.classList.remove('sharing');
    myCard.querySelector('.vo-user-video')?.remove();
  }
  voiceOverlayUsers.classList.remove('has-screen');

  // Remove video track from peers
  Object.values(peers).forEach(pc => {
    pc.getSenders().forEach(sender => {
      if (sender.track?.kind === 'video') pc.removeTrack(sender);
    });
  });
}

function showScreenInCard(userId, stream) {
  const card = document.getElementById('vu-' + userId);
  if (!card) return;
  card.classList.add('sharing');
  let video = card.querySelector('.vo-user-video');
  if (!video) {
    video = document.createElement('video');
    video.className = 'vo-user-video';
    video.autoplay = true; video.muted = true; video.playsInline = true;
    card.insertBefore(video, card.firstChild);
  }
  video.srcObject = stream;
  voiceOverlayUsers.classList.add('has-screen');
}

// Patch createPeerConnection to handle video tracks — встроено в оригинал выше

// ---- Activity / RPC ----
const activityBtn     = document.getElementById('activity-btn');
const activityModal   = document.getElementById('activity-modal');
const activityNameInput    = document.getElementById('activity-name-input');
const activityDetailsInput = document.getElementById('activity-details-input');
const activityEmojiPreview = document.getElementById('activity-emoji-preview');
const activityCancel  = document.getElementById('activity-cancel');
const activityConfirm = document.getElementById('activity-confirm');
const activityClear   = document.getElementById('activity-clear');

let myActivity = null;
let selectedActivityType = { emoji: '🎮', type: 'playing', label: 'Играю' };

// Load saved activity
const savedActivity = localStorage.getItem('faza_activity');
if (savedActivity) { try { myActivity = JSON.parse(savedActivity); } catch {} }

activityBtn.addEventListener('click', () => {
  activityNameInput.value = myActivity?.name || '';
  activityDetailsInput.value = myActivity?.details || '';
  if (myActivity) {
    activityEmojiPreview.textContent = myActivity.emoji;
    selectedActivityType = { emoji: myActivity.emoji, type: myActivity.type };
    document.querySelectorAll('.activity-preset').forEach(b => {
      b.classList.toggle('active', b.dataset.type === myActivity.type);
    });
  }
  activityModal.classList.remove('hidden');
  activityNameInput.focus();
});

document.querySelectorAll('.activity-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.activity-preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedActivityType = { emoji: btn.dataset.emoji, type: btn.dataset.type };
    activityEmojiPreview.textContent = btn.dataset.emoji;
  });
});

activityCancel.addEventListener('click', () => activityModal.classList.add('hidden'));
activityClear.addEventListener('click', () => {
  myActivity = null;
  localStorage.removeItem('faza_activity');
  socket.emit('setActivity', null);
  updateMyActivityUI();
  activityModal.classList.add('hidden');
});
activityConfirm.addEventListener('click', () => {
  const name = activityNameInput.value.trim();
  if (!name) return showToast('Введи название', 'error');
  myActivity = {
    emoji: selectedActivityType.emoji,
    type: selectedActivityType.type,
    name,
    details: activityDetailsInput.value.trim() || null
  };
  localStorage.setItem('faza_activity', JSON.stringify(myActivity));
  socket.emit('setActivity', myActivity);
  updateMyActivityUI();
  activityModal.classList.add('hidden');
  showToast('Активность установлена', 'success');
});
activityNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') activityConfirm.click(); });

function updateMyActivityUI() {
  // Update user bar
  let actEl = document.getElementById('user-activity-display');
  if (myActivity) {
    if (!actEl) {
      actEl = document.createElement('span');
      actEl.id = 'user-activity-display';
      actEl.className = 'user-activity';
      document.querySelector('.user-info').appendChild(actEl);
    }
    actEl.textContent = myActivity.emoji + ' ' + myActivity.name;
  } else if (actEl) {
    actEl.remove();
  }
}

// Receive activity updates
const userActivities = {}; // name -> activity

socket.on('activityUpdated', ({ name, activity }) => {
  userActivities[name] = activity;
  renderOnlineList();
  // Update DM list previews
  document.querySelectorAll('.dm-item').forEach(li => {
    const nm = li.querySelector('.dm-item-name');
    if (nm && nm.textContent === name) {
      let badge = li.querySelector('.activity-badge');
      if (activity) {
        if (!badge) { badge = document.createElement('div'); badge.className = 'activity-badge'; li.querySelector('.dm-item-info').appendChild(badge); }
        badge.innerHTML = `<span class="act-emoji">${activity.emoji}</span> ${escHtml(activity.name)}`;
      } else if (badge) badge.remove();
    }
  });
});

// Override renderOnlineList to show activity
const _origRenderOnlineList = renderOnlineList;
function renderOnlineList() {
  onlineListEl.innerHTML = '';
  const entries = Object.entries(onlineUsers);
  const countEl = document.getElementById('online-count');
  if (countEl) countEl.textContent = entries.length;
  entries.forEach(([name, avatar]) => {
    const li = document.createElement('li'); li.className = 'online-item';
    const av = document.createElement('div'); av.className = 'online-item-avatar';
    setAvatarEl(av, name, avatar);
    const info = document.createElement('div'); info.style.cssText = 'flex:1;min-width:0;';
    const nm = document.createElement('span'); nm.className = 'online-item-name'; nm.textContent = name;
    info.appendChild(nm);
    const act = userActivities[name];
    if (act) {
      const badge = document.createElement('div'); badge.className = 'activity-badge';
      badge.innerHTML = `<span class="act-emoji">${act.emoji}</span> ${escHtml(act.name)}`;
      info.appendChild(badge);
    }
    li.append(av, info); onlineListEl.appendChild(li);
  });
}

// Send saved activity after login
socket.on('onlineUsers', users => {
  users.forEach(u => {
    onlineUsers[u.name] = u.avatar;
    if (u.activity) userActivities[u.name] = u.activity;
  });
  renderOnlineList();
  // Send own activity if saved
  if (myActivity) {
    socket.emit('setActivity', myActivity);
    updateMyActivityUI();
  }
});

// ---- Ringtone ----
let ringtoneDataUrl = localStorage.getItem('faza_ringtone') || null;
let ringtoneType = localStorage.getItem('faza_ringtone_type') || 'default';
let ringtoneAudio = null;

const ringtoneBtn    = document.getElementById('ringtone-btn');
const ringtoneModal  = document.getElementById('ringtone-modal');
const ringtoneCancel = document.getElementById('ringtone-cancel');
const ringtoneConfirm = document.getElementById('ringtone-confirm');
const ringtoneTest   = document.getElementById('ringtone-test');
const ringtoneFileInput = document.getElementById('ringtone-file-input');
const ringtoneFileWrap  = document.getElementById('ringtone-file-wrap');
const ringtoneFileName  = document.getElementById('ringtone-file-name');
const ringtonePreview   = document.getElementById('ringtone-preview');

let pendingRingtone = null;
let pendingRingtoneType = ringtoneType;

ringtoneBtn.addEventListener('click', () => {
  pendingRingtone = ringtoneDataUrl;
  pendingRingtoneType = ringtoneType;
  updateRingtoneUI();
  ringtoneModal.classList.remove('hidden');
});

document.querySelectorAll('.ringtone-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ringtone-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    pendingRingtoneType = btn.dataset.ringtone;
    ringtoneFileWrap.style.display = pendingRingtoneType === 'custom' ? '' : 'none';
    updateRingtoneUI();
  });
});

ringtoneFileInput.addEventListener('change', () => {
  const file = ringtoneFileInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { showToast('Файл слишком большой (макс 2MB)', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    pendingRingtone = e.target.result;
    ringtoneFileName.textContent = file.name;
    ringtonePreview.textContent = '🎵 ' + file.name;
  };
  reader.readAsDataURL(file);
});

ringtoneTest.addEventListener('click', () => {
  stopRingtone();
  let src = null;
  if (pendingRingtoneType === 'ring1') src = '/sounds/ring1.mp3';
  else if (pendingRingtoneType === 'ring2') src = '/sounds/ring2.mp3';
  else if (pendingRingtoneType === 'custom') src = pendingRingtone;
  playRingtone(src, true);
});

ringtoneCancel.addEventListener('click', () => { stopRingtone(); ringtoneModal.classList.add('hidden'); });

ringtoneConfirm.addEventListener('click', () => {
  ringtoneType = pendingRingtoneType;
  ringtoneDataUrl = pendingRingtoneType === 'custom' ? pendingRingtone : null;
  localStorage.setItem('faza_ringtone_type', ringtoneType);
  if (ringtoneDataUrl) localStorage.setItem('faza_ringtone', ringtoneDataUrl);
  else localStorage.removeItem('faza_ringtone');
  stopRingtone();
  ringtoneModal.classList.add('hidden');
  showToast('Звук звонка сохранён', 'success');
});

function updateRingtoneUI() {
  document.querySelectorAll('.ringtone-opt').forEach(b => b.classList.toggle('active', b.dataset.ringtone === pendingRingtoneType));
  ringtoneFileWrap.style.display = pendingRingtoneType === 'custom' ? '' : 'none';
  ringtonePreview.textContent = pendingRingtoneType === 'custom' && pendingRingtone ? '🎵 Свой файл' : 'Стандартный звук';
}

function playRingtone(dataUrl, once = false) {
  stopRingtone();
  let src = dataUrl;
  if (!src && ringtoneType === 'ring1') src = '/sounds/ring1.mp3';
  if (!src && ringtoneType === 'ring2') src = '/sounds/ring2.mp3';
  if (src) {
    ringtoneAudio = new Audio(src);
    ringtoneAudio.loop = !once;
    ringtoneAudio.volume = 0.7;
    ringtoneAudio.play().catch(() => {});
  } else {
    playDefaultRingtone(once);
  }
}

function playDefaultRingtone(once) {
  let count = 0;
  const maxRings = once ? 1 : 999;
  function ring() {
    if (count >= maxRings || !ringtoneAudio) return;
    count++;
    playSound('join');
    if (!once) ringtoneAudio = setTimeout(ring, 1500);
  }
  ringtoneAudio = setTimeout(ring, 0);
}

function stopRingtone() {
  if (ringtoneAudio instanceof Audio) { ringtoneAudio.pause(); ringtoneAudio.currentTime = 0; }
  else if (ringtoneAudio) { clearTimeout(ringtoneAudio); }
  ringtoneAudio = null;
}

// Override showIncomingCall to use custom ringtone
const _origShowIncomingCall = showIncomingCall;
function showIncomingCall(from, avatar, onAccept) {
  let ringSrc = null;
  if (ringtoneType === 'ring1') ringSrc = '/sounds/ring1.mp3';
  else if (ringtoneType === 'ring2') ringSrc = '/sounds/ring2.mp3';
  else if (ringtoneType === 'custom') ringSrc = ringtoneDataUrl;
  playRingtone(ringSrc);
  document.getElementById('incoming-call-toast')?.remove();
  const el = document.createElement('div');
  el.id = 'incoming-call-toast';
  el.style.cssText = `position:fixed;bottom:80px;right:20px;background:var(--bg-2);border:1px solid rgba(255,255,255,.1);border-radius:14px;padding:16px 20px;display:flex;align-items:center;gap:12px;z-index:300;box-shadow:0 8px 30px rgba(0,0,0,.5);min-width:260px;`;
  const av = document.createElement('div');
  av.style.cssText = 'width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;overflow:hidden;flex-shrink:0;';
  setAvatarEl(av, from, avatar);
  const info = document.createElement('div'); info.style.flex = '1';
  info.innerHTML = `<div style="font-weight:700;color:var(--text-h);font-size:.9rem">${escHtml(from)}</div><div style="color:var(--text-m);font-size:.8rem">Входящий звонок...</div>`;
  const accept = document.createElement('button');
  accept.textContent = '✓';
  accept.style.cssText = 'background:var(--green);border:none;border-radius:8px;color:#fff;width:36px;height:36px;cursor:pointer;font-size:1.1rem;';
  const decline = document.createElement('button');
  decline.textContent = '✕';
  decline.style.cssText = 'background:var(--red);border:none;border-radius:8px;color:#fff;width:36px;height:36px;cursor:pointer;font-size:1rem;margin-left:4px;';

  const doDecline = () => {
    stopRingtone(); el.remove();
    socket.emit('declineCall', { from });
  };
  const timeout = setTimeout(doDecline, 30000);

  accept.addEventListener('click', () => { clearTimeout(timeout); stopRingtone(); el.remove(); onAccept(); });
  decline.addEventListener('click', () => { clearTimeout(timeout); doDecline(); });
  el.append(av, info, accept, decline);
  document.body.appendChild(el);
}

// ---- Outgoing call ringtone ----
let outgoingRingtoneAudio = null;

function playOutgoingRingtone() {
  stopOutgoingRingtone();
  // Use same ringtone files but loop
  let src = null;
  if (ringtoneType === 'ring1') src = '/sounds/ring1.mp3';
  else if (ringtoneType === 'ring2') src = '/sounds/ring2.mp3';
  else if (ringtoneType === 'custom' && ringtoneDataUrl) src = ringtoneDataUrl;

  if (src) {
    outgoingRingtoneAudio = new Audio(src);
    outgoingRingtoneAudio.loop = true;
    outgoingRingtoneAudio.volume = 0.5;
    outgoingRingtoneAudio.play().catch(() => {});
  } else {
    // Generated beeping
    let active = true;
    outgoingRingtoneAudio = { stop: () => { active = false; } };
    const beep = () => {
      if (!active) return;
      playSound('join');
      setTimeout(() => { if (active) beep(); }, 2000);
    };
    beep();
  }
}

function stopOutgoingRingtone() {
  if (outgoingRingtoneAudio instanceof Audio) {
    outgoingRingtoneAudio.pause();
    outgoingRingtoneAudio.currentTime = 0;
  } else if (outgoingRingtoneAudio?.stop) {
    outgoingRingtoneAudio.stop();
  }
  outgoingRingtoneAudio = null;
}

// (voiceUserJoined handled above with stopOutgoingRingtone)

// ---- Mobile navigation (new) ----
function isMobile() { return window.innerWidth <= 768; }
const sidebarEl2 = document.getElementById('sidebar');
const chatAreaEl2 = document.getElementById('chat-area');

function openChatOnMobile() {
  if (!isMobile()) return;
  chatAreaEl2?.classList.add('chat-open');
}
function closeChatOnMobile() {
  if (!isMobile()) return;
  chatAreaEl2?.classList.remove('chat-open');
}

const mobBackBtn2 = document.getElementById('mob-back-btn');
if (mobBackBtn2) mobBackBtn2.addEventListener('click', closeChatOnMobile);

const mobBtnChat2    = document.getElementById('mob-btn-chat');
const mobBtnNotif2   = document.getElementById('mob-btn-notif');
const mobBtnProfile2 = document.getElementById('mob-btn-profile');
const mobRailDms2    = document.getElementById('mob-rail-dms');
const mobRailServer2 = document.getElementById('mob-rail-server');
const mobAddFriendBar2 = document.getElementById('mob-add-friend-bar');

function setMobNavActive2(btn) {
  [mobBtnChat2, mobBtnNotif2, mobBtnProfile2].forEach(b => b?.classList.remove('active'));
  btn?.classList.add('active');
}

if (mobBtnChat2) mobBtnChat2.addEventListener('click', () => {
  setMobNavActive2(mobBtnChat2);
  closeChatOnMobile();
  showView(viewDms); socket.emit('getFriends'); socket.emit('getGroups');
});
if (mobBtnNotif2) mobBtnNotif2.addEventListener('click', () => {
  setMobNavActive2(mobBtnNotif2);
  closeChatOnMobile();
});
if (mobBtnProfile2) mobBtnProfile2.addEventListener('click', () => {
  setMobNavActive2(mobBtnProfile2);
  closeChatOnMobile();
  sidebarEl2?.scrollTo(0, sidebarEl2.scrollHeight);
});
if (mobRailDms2) mobRailDms2.addEventListener('click', () => {
  showView(viewDms); socket.emit('getFriends'); socket.emit('getGroups');
});
if (mobRailServer2) mobRailServer2.addEventListener('click', () => {
  showView(viewServer);
});
if (mobAddFriendBar2) mobAddFriendBar2.addEventListener('click', () => {
  document.getElementById('add-friend-modal')?.classList.remove('hidden');
  document.getElementById('add-friend-input')?.focus();
});

// ---- Discord RPC (Desktop only) ----
if (window.fazaDesktop) {
  console.log('Running in Faza Desktop — Discord RPC available');

  // Update Discord RPC when user is in voice
  const _origShowVoiceUI = showVoiceUI;
  function showVoiceUI() {
    _origShowVoiceUI();
    window.fazaDesktop.setDiscordRPC({
      details: 'В голосовом чате',
      state: currentVoiceChannel || currentCallRoomId || 'Faza',
      startTimestamp: Date.now()
    });
  }

  const _origEndCall2 = endCall;
  function endCall() {
    _origEndCall2();
    window.fazaDesktop.clearDiscordRPC();
  }

  // Update RPC when chatting
  socket.on('message', (msg) => {
    if (msg.user === username) {
      window.fazaDesktop.setDiscordRPC({
        details: 'Переписывается в Faza',
        state: currentChannel ? '#' + currentChannel : (currentDM || ''),
        startTimestamp: Date.now()
      });
    }
  });

  // Receive Discord activity from main process and show in Faza
  window.fazaDesktop.onDiscordActivity((data) => {
    if (data?.activity) {
      const act = {
        emoji: '🎮',
        type: 'playing',
        name: data.activity.name || 'Discord',
        details: data.activity.details || null
      };
      myActivity = act;
      socket.emit('setActivity', act);
      updateMyActivityUI();
    }
  });

  // Set initial RPC
  window.fazaDesktop.setDiscordRPC({
    details: 'В Faza',
    state: 'Мессенджер',
    startTimestamp: Date.now()
  });
}
