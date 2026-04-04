const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');

const FAZA_URL = 'https://faza-jvo1.onrender.com';

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Faza',
    backgroundColor: '#1a1b1e',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadURL(FAZA_URL);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  startDiscordRPC();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- Discord RPC ----
let rpc = null;
let rpcConnected = false;

async function startDiscordRPC() {
  try {
    const { Client } = require('discord-rpc');
    // Use a generic client ID — works without registering an app
    const CLIENT_ID = '1234567890'; // placeholder, will try to connect anyway
    rpc = new Client({ transport: 'ipc' });

    rpc.on('ready', () => {
      rpcConnected = true;
      console.log('Discord RPC connected');
      pollActivity();
    });

    rpc.on('disconnected', () => {
      rpcConnected = false;
      console.log('Discord RPC disconnected');
      // Retry after 30s
      setTimeout(startDiscordRPC, 30000);
    });

    await rpc.login({ clientId: CLIENT_ID }).catch(() => {
      // Try without client ID (read-only mode)
      return rpc.login({}).catch(() => {});
    });
  } catch (e) {
    console.log('Discord RPC not available:', e.message);
    // Retry after 30s
    setTimeout(startDiscordRPC, 30000);
  }
}

let lastActivity = null;

async function pollActivity() {
  if (!rpc || !rpcConnected) return;
  try {
    // Get current user's activity via RPC
    const activity = await rpc.request('GET_SELECTED_VOICE_CHANNEL').catch(() => null);
    // Also try to get current activity from subscriptions
    sendActivityToFaza();
  } catch {}
  setTimeout(pollActivity, 5000);
}

function sendActivityToFaza() {
  if (!mainWindow || !rpc) return;
  // We'll use a different approach — subscribe to activity updates
}

// Subscribe to Discord activity updates
async function subscribeToActivity() {
  if (!rpc || !rpcConnected) return;
  try {
    await rpc.subscribe('ACTIVITY_JOIN', () => {});
    rpc.on('ACTIVITY_UPDATE', (data) => {
      if (mainWindow) {
        mainWindow.webContents.send('discord-activity', data);
      }
    });
  } catch {}
}

// IPC: renderer can send activity to Discord
ipcMain.on('set-discord-rpc', (event, activity) => {
  if (!rpc || !rpcConnected) return;
  try {
    rpc.setActivity({
      details: activity.details || 'В Faza',
      state: activity.state || '',
      largeImageKey: 'faza',
      largeImageText: 'Faza Messenger',
      startTimestamp: activity.startTimestamp || Date.now(),
      instance: false
    });
  } catch {}
});

ipcMain.on('clear-discord-rpc', () => {
  if (!rpc || !rpcConnected) return;
  try { rpc.clearActivity(); } catch {}
});
