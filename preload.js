const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Profile management
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  saveProfiles: (profiles) => ipcRenderer.invoke('save-profiles', profiles),
  addProfile: (profile) => ipcRenderer.invoke('add-profile', profile),
  updateProfile: (profile) => ipcRenderer.invoke('update-profile', profile),
  deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),
  activateProfile: (id) => ipcRenderer.invoke('activate-profile', id),
  
  // Config path
  getOpenCodeConfigPath: () => ipcRenderer.invoke('get-opencode-config-path'),
  getOpenCodeAuthPath: () => ipcRenderer.invoke('get-opencode-auth-path'),

  // OpenCode helpers
  opencodeModels: () => ipcRenderer.invoke('opencode-models'),
  launchOpenCode: (args) => ipcRenderer.invoke('launch-opencode', args),
  fetchProviderModels: (params) => ipcRenderer.invoke('fetch-provider-models', params),
  
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  
  // Events
  onProfileActivated: (callback) => {
    ipcRenderer.on('profile-activated', (event, profile) => callback(profile));
  },

  onProfilesChanged: (callback) => {
    ipcRenderer.on('profiles-changed', () => callback());
  },
});
