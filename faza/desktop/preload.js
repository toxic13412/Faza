const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fazaDesktop', {
  // Send activity to Discord RPC
  setDiscordRPC: (activity) => ipcRenderer.send('set-discord-rpc', activity),
  clearDiscordRPC: () => ipcRenderer.send('clear-discord-rpc'),
  // Receive Discord activity updates
  onDiscordActivity: (cb) => ipcRenderer.on('discord-activity', (_, data) => cb(data)),
  isDesktop: true
});
