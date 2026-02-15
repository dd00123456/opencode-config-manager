const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const jsonc = require('jsonc-parser');
const { URL } = require('url');
const { spawn } = require('child_process');

// Initialize store for persistent config
const store = new Store({
  name: 'opencode-config',
  defaults: {
    profiles: [],
    activeProfileId: null
  }
});

let mainWindow = null;
let tray = null;
let isQuitting = false;

function syncAllProfilesToOpenCode() {
  const profiles = store.get('profiles', []);
  for (const profile of profiles) {
    try {
      // Only sync profiles that look complete
      if (!profile || typeof profile !== 'object') continue;
      if (!profile.providerId || !profile.url || !profile.key) continue;
      if (getProfileModelIds(profile).length === 0) continue;
      syncProfileToOpenCode(profile);
    } catch {
      // Non-fatal
    }
  }
}

function getOpenCodeConfigPath() {
  // OpenCode global config is loaded from ~/.config/opencode/ (or XDG_CONFIG_HOME/opencode)
  // and merged in this order: config.json -> opencode.json -> opencode.jsonc.
  // Prefer writing to opencode.jsonc when present so our changes win.
  const home = app.getPath('home');
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const configDir = path.join(xdgConfigHome, 'opencode');

  const candidates = ['opencode.jsonc', 'opencode.json', 'config.json'];
  for (const filename of candidates) {
    const candidatePath = path.join(configDir, filename);
    if (fs.existsSync(candidatePath)) return candidatePath;
  }

  // Legacy installs may have kept config under the data dir; fall back if present.
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  for (const filename of ['opencode.jsonc', 'opencode.json']) {
    const legacyPath = path.join(xdgDataHome, 'opencode', filename);
    if (fs.existsSync(legacyPath)) return legacyPath;
  }

  // Default to opencode.jsonc (highest precedence among global config files).
  return path.join(configDir, 'opencode.jsonc');
}

function getOpenCodeAuthPath() {
  // OpenCode credentials are stored under the data dir (XDG_DATA_HOME/opencode/auth.json)
  const home = app.getPath('home');
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(xdgDataHome, 'opencode', 'auth.json');
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isValidProviderId(providerId) {
  return typeof providerId === 'string' && /^[0-9a-z-]+$/.test(providerId);
}

function parseModelIds(input) {
  if (Array.isArray(input)) {
    return input
      .map((x) => String(x || '').trim())
      .filter(Boolean);
  }
  if (typeof input !== 'string') return [];
  return input
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getProfileModelIds(profile) {
  // Backwards compatible:
  // - profile.modelId may be a single model OR a list (comma/newline separated)
  // - profile.modelIds may be an array of models
  const fromModelId = parseModelIds(profile?.modelId);
  const fromModelIds = parseModelIds(profile?.modelIds);
  const combined = [...fromModelId, ...fromModelIds];
  const seen = new Set();
  const result = [];
  for (const id of combined) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function joinUrl(base, pathSuffix) {
  const baseStr = String(base || '').trim();
  const suffix = String(pathSuffix || '').trim();
  if (!baseStr) throw new Error('Missing baseURL');
  const baseUrl = new URL(baseStr.endsWith('/') ? baseStr : baseStr + '/');
  const suffixNoLead = suffix.startsWith('/') ? suffix.slice(1) : suffix;
  return new URL(suffixNoLead, baseUrl).toString();
}

function normalizeOpenAIBaseURL(baseURL) {
  // Common typo: /V1 instead of /v1 (many servers are case-sensitive)
  try {
    const u = new URL(String(baseURL || '').trim());
    const p = (u.pathname || '').replace(/\/+$/, '');
    if (p === '/V1' || p.endsWith('/V1')) {
      u.pathname = p.replace(/\/V1$/, '/v1');
      return u.toString().replace(/\/+$/, '');
    }
    return u.toString().replace(/\/+$/, '');
  } catch {
    return String(baseURL || '').trim().replace(/\/+$/, '');
  }
}

function baseURLPathEndsWithV1CaseInsensitive(baseURL) {
  try {
    const u = new URL(String(baseURL || '').trim());
    const p = (u.pathname || '').replace(/\/+$/, '').toLowerCase();
    return p === '/v1' || p.endsWith('/v1');
  } catch {
    return false;
  }
}

function extractModelIdsFromResponse(json) {
  if (!json || typeof json !== 'object') return [];
  // OpenAI-style: { data: [{ id: "..." }] }
  if (Array.isArray(json.data)) {
    return json.data
      .map((x) => (x && typeof x.id === 'string' ? x.id.trim() : ''))
      .filter(Boolean);
  }
  // Fallback shapes used by some gateways
  if (Array.isArray(json.models)) {
    return json.models
      .map((x) => {
        if (typeof x === 'string') return x.trim();
        if (x && typeof x.id === 'string') return x.id.trim();
        return '';
      })
      .filter(Boolean);
  }
  return [];
}

async function fetchModelsFromProvider(baseURL, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('Missing API key');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);

  try {
    const normalized = normalizeOpenAIBaseURL(baseURL);
    const bases = [String(baseURL || '').trim(), normalized].filter(Boolean);
    const uniqueBases = [...new Set(bases.map((b) => b.replace(/\/+$/, '')))].filter(Boolean);

    const candidates = [];
    for (const b of uniqueBases) {
      // Most OpenAI-compatible servers: baseURL already ends with /v1
      candidates.push(joinUrl(b, '/models'));
      // If user provided a host root, try /v1/models as well.
      if (!baseURLPathEndsWithV1CaseInsensitive(b)) {
        candidates.push(joinUrl(b, '/v1/models'));
      }
    }

    const uniqueCandidates = [...new Set(candidates)];

    let lastError;
    for (const url of uniqueCandidates) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Authorization': `Bearer ${key}`
          },
          signal: controller.signal
        });
        if (!res.ok) {
          lastError = new Error(`HTTP ${res.status} from ${url}`);
          continue;
        }
        const json = await res.json().catch(() => null);
        const ids = extractModelIdsFromResponse(json);
        if (ids.length > 0) {
          // Infer the working baseURL from the successful request.
          // For /models: base is request url minus trailing /models
          // For /v1/models: base is request url minus trailing /v1/models
          const u = new URL(url);
          const p = (u.pathname || '').replace(/\/+$/, '');
          if (p.toLowerCase().endsWith('/v1/models')) {
            u.pathname = p.slice(0, -'/v1/models'.length) + '/v1';
          } else if (p.toLowerCase().endsWith('/models')) {
            u.pathname = p.slice(0, -'/models'.length);
          }
          const resolvedBaseURL = u.toString().replace(/\/+$/, '');
          return { ids, resolvedBaseURL };
        }
        lastError = new Error(`No models in response from ${url}`);
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error('Failed to fetch models');
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshProfileModels(profile, { replace = false } = {}) {
  if (!profile || typeof profile !== 'object') return { changed: false, modelCount: 0 };
  const url = String(profile.url || '').trim();
  const key = String(profile.key || '').trim();
  if (!url || !key) return { changed: false, modelCount: 0 };

  const fetched = await fetchModelsFromProvider(url, key);
  const fetchedIds = Array.isArray(fetched) ? fetched : fetched.ids;
  const resolvedBaseURL = Array.isArray(fetched) ? url : (fetched.resolvedBaseURL || url);
  const existing = getProfileModelIds(profile);

  const combined = replace ? fetchedIds : [...existing, ...fetchedIds];
  const seen = new Set();
  const unique = [];
  for (const id of combined) {
    const v = String(id || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    unique.push(v);
    if (unique.length >= 500) break;
  }

  if (unique.length === 0) return { changed: false, modelCount: 0 };

  const prevSig = JSON.stringify(existing);
  const nextSig = JSON.stringify(unique);
  if (prevSig === nextSig) return { changed: false, modelCount: unique.length };

  profile.modelIds = unique;
  profile.modelId = unique[0];
  if (resolvedBaseURL && typeof resolvedBaseURL === 'string') {
    profile.url = resolvedBaseURL;
  }
  return { changed: true, modelCount: unique.length };
}

function readJsonFile(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function jsoncApply(filePath, applyEditsFn) {
  ensureDirForFile(filePath);
  const defaultText = '{\n  "$schema": "https://opencode.ai/config.json"\n}\n';
  let text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : defaultText;
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };
  const edits = applyEditsFn(text, formattingOptions);
  text = jsonc.applyEdits(text, edits);
  fs.writeFileSync(filePath, text);
}

function jsoncSet(filePath, jsonPath, value) {
  jsoncApply(filePath, (text, formattingOptions) => jsonc.modify(text, jsonPath, value, { formattingOptions }));
}

function jsoncDelete(filePath, jsonPath) {
  jsoncApply(filePath, (text, formattingOptions) => jsonc.modify(text, jsonPath, undefined, { formattingOptions }));
}

function syncProfileToOpenCode(profile, options = {}) {
  const providerId = (profile.providerId || '').trim();
  if (!isValidProviderId(providerId)) {
    throw new Error('Invalid Provider ID. Use a-z, 0-9, and hyphens only.');
  }

  const modelIds = getProfileModelIds(profile);
  const defaultModelId = modelIds[0] || '';

  const authPath = getOpenCodeAuthPath();
  const configPath = getOpenCodeConfigPath();

  // auth.json controls /connect credentials
  if (typeof profile.key === 'string' && profile.key.trim().length > 0) {
    const auth = readJsonFile(authPath, {});
    const existing = auth[providerId];
    if (existing && existing.type && existing.type !== 'api') {
      throw new Error(`Provider '${providerId}' is stored as '${existing.type}' in auth.json (not api).`);
    }
    auth[providerId] = { type: 'api', key: profile.key };
    ensureDirForFile(authPath);
    fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
  }

  // opencode.json provides display name + baseURL in config
  jsoncSet(configPath, ['$schema'], 'https://opencode.ai/config.json');
  jsoncSet(configPath, ['provider', providerId, 'name'], profile.name || providerId);
  // Default to OpenAI-compatible for "Other" providers unless user already configured differently.
  // We only set this if missing to avoid breaking custom setups.
  try {
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const parsed = jsonc.parse(raw, [], { allowTrailingComma: true, disallowComments: false }) || {};
    const existingNpm = parsed?.provider?.[providerId]?.npm;
    if (!existingNpm) {
      jsoncSet(configPath, ['provider', providerId, 'npm'], '@ai-sdk/openai-compatible');
    }
  } catch {
    // If parsing fails, still set npm to a safe default.
    jsoncSet(configPath, ['provider', providerId, 'npm'], '@ai-sdk/openai-compatible');
  }

  if (typeof profile.url === 'string' && profile.url.trim().length > 0) {
    jsoncSet(configPath, ['provider', providerId, 'options', 'baseURL'], profile.url);
  }

  // Ensure at least one model exists so the provider shows up in provider lists.
  for (const id of modelIds) {
    jsoncSet(configPath, ['provider', providerId, 'models', id, 'name'], id);
  }

  // Optionally set the active model in global config for convenience.
  if (options && options.setActiveModel && defaultModelId) {
    const modelSpec = defaultModelId.startsWith(providerId + '/') ? defaultModelId : `${providerId}/${defaultModelId}`;
    jsoncSet(configPath, ['model'], modelSpec);
  }
}

function unsyncProfileFromOpenCode(providerId) {
  const id = (providerId || '').trim();
  if (!isValidProviderId(id)) return;
  const authPath = getOpenCodeAuthPath();

  // Remove only the entry matching this provider id.
  try {
    const auth = readJsonFile(authPath, {});
    if (auth && typeof auth === 'object' && auth[id]) {
      delete auth[id];
      ensureDirForFile(authPath);
      fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
    }
  } catch {
    // ignore
  }
}

// Create the main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 680,
    minWidth: 400,
    minHeight: 500,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false
  });

  mainWindow.loadFile('index.html');

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Hide instead of close (for tray functionality)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create system tray
function createTray() {
  // Create tray icon (16x16 for Windows, 22x22 for Linux)
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA2ElEQVR4nGNgGAWjYBQMJsCITZKBgYHhPwMDQzUDA8N/LPz/z5lJpBjdigEYy6WqiRkgZIsFJDaC6c4MCHqBod4PYAY01AYoaQbSBl0GBgYGBmJOVDCGmf+DKM9g8P//ZyYDZDK8WN0cxKmGiZkDWKpciCb6Pwz9/5nJANmMqxWYKS0DyW0DFLN/BiYdDAx1DgOD0f9Z/v//z1SGwNj+w////xlJUwIj+38GJjRUQENB+jMwobHiEpgYHhSMh/FAFjkGBgYGBr7AMDAAAL0MzU1V0bYAAAAASUVORK5CYII='
  );
  
  tray = new Tray(icon);
  
  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open Config Manager', 
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    { 
      label: 'Active Profile', 
      enabled: false 
    },
    ...getProfileMenuItems(),
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('OpenCode Config Manager');
  tray.setContextMenu(contextMenu);
  
  // Double click to show window
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// Get profile menu items for tray
function getProfileMenuItems() {
  const profiles = store.get('profiles', []);
  const activeId = store.get('activeProfileId');
  
  if (profiles.length === 0) {
    return [{ label: '(No profiles)', enabled: false }];
  }
  
  return profiles.map(profile => ({
    label: profile.name,
    type: 'checkbox',
    checked: profile.id === activeId,
    click: () => {
      activateProfile(profile.id);
    }
  }));
}

// Activate a profile
function activateProfile(profileId) {
  const profiles = store.get('profiles', []);
  const profile = profiles.find(p => p.id === profileId);
  
  if (!profile) return;

  const providerId = (profile.providerId || '').trim();
  if (!providerId) {
    dialog.showErrorBox('Missing Provider ID', 'This profile is missing a Provider ID. Edit the profile and set the Provider ID used in /connect -> Others.');
    return;
  }
  if (!isValidProviderId(providerId)) {
    dialog.showErrorBox('Invalid Provider ID', 'Provider ID must match: a-z, 0-9, and hyphens only.');
    return;
  }
  
  store.set('activeProfileId', profileId);

  try {
    syncProfileToOpenCode(profile, { setActiveModel: true });

    // Best-effort: auto-discover and persist models for /models.
    // Do this after syncing so activation stays fast.
    refreshProfileModels(profile)
      .then((result) => {
        if (!result.changed) return;

        const profiles = store.get('profiles', []);
        const index = profiles.findIndex((p) => p.id === profile.id);
        if (index === -1) return;
        profiles[index] = profile;
        store.set('profiles', profiles);

        // Re-sync so OpenCode sees the fetched model list.
        try {
          syncProfileToOpenCode(profile, { setActiveModel: true });
        } catch {
          // ignore
        }

        mainWindow?.webContents.send('profiles-changed');
      })
      .catch(() => {
        // ignore
      });
    
    // Show notification
    new Notification({
      title: 'OpenCode Config',
      body: `Switched '${providerId}' to: ${profile.name}`
    }).show();
    
    // Update tray menu
    if (tray) {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Open Config Manager', click: () => mainWindow?.show() || createWindow() },
        { type: 'separator' },
        { label: 'Active Profile', enabled: false },
        ...getProfileMenuItems(),
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
      ]);
      tray.setContextMenu(contextMenu);
    }
    
    // Notify renderer
    mainWindow?.webContents.send('profile-activated', profile);
    
  } catch (error) {
    dialog.showErrorBox('Error', `Failed to write config: ${error.message}`);
  }
}

function runOpenCodeModels() {
  return new Promise((resolve) => {
    const child = spawn('opencode', ['models'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ ok: false, output: '', error: err && err.message ? err.message : String(err) });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, output: stdout, error: '' });
      } else {
        resolve({ ok: false, output: stdout, error: stderr || `opencode exited with code ${code}` });
      }
    });
  });
}

function launchOpenCode(commandArgs) {
  const args = Array.isArray(commandArgs) ? commandArgs : [];
  if (process.platform === 'win32') {
    // Open a new console window.
    const keepOpen = args.length > 0;
    const child = keepOpen
      ? spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', 'opencode', ...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      : spawn('cmd.exe', ['/c', 'start', '""', 'opencode'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    child.unref();
    return { ok: true, error: '' };
  }

  // Best-effort fallback: try launching without a new terminal.
  // This will likely fail for interactive TUI, but works for non-interactive commands.
  try {
    const child = spawn('opencode', args, { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// IPC Handlers
ipcMain.handle('get-profiles', () => {
  return {
    profiles: store.get('profiles', []),
    activeProfileId: store.get('activeProfileId')
  };
});

ipcMain.handle('save-profiles', (event, profiles) => {
  store.set('profiles', profiles);
  return true;
});

ipcMain.handle('activate-profile', (event, profileId) => {
  activateProfile(profileId);
  return true;
});

ipcMain.handle('add-profile', (event, profile) => {
  const profiles = store.get('profiles', []);
  profiles.push(profile);
  store.set('profiles', profiles);
  syncProfileToOpenCode(profile);

  // Best-effort: auto-populate model list for /models.
  refreshProfileModels(profile)
    .then((result) => {
      if (!result.changed) return;
      const profiles = store.get('profiles', []);
      const index = profiles.findIndex((p) => p.id === profile.id);
      if (index === -1) return;
      profiles[index] = profile;
      store.set('profiles', profiles);
      try {
        syncProfileToOpenCode(profile);
      } catch {
        // ignore
      }

      mainWindow?.webContents.send('profiles-changed');
    })
    .catch(() => {
      // ignore
    });

  return true;
});

ipcMain.handle('update-profile', (event, updatedProfile) => {
  const profiles = store.get('profiles', []);
  const index = profiles.findIndex(p => p.id === updatedProfile.id);
  if (index !== -1) {
    const prevProviderId = profiles[index]?.providerId;
    profiles[index] = updatedProfile;
    store.set('profiles', profiles);

    if (prevProviderId && prevProviderId !== updatedProfile.providerId) {
      unsyncProfileFromOpenCode(prevProviderId);
    }

    syncProfileToOpenCode(updatedProfile);

    // Best-effort: keep models list updated.
    refreshProfileModels(updatedProfile)
      .then((result) => {
        if (!result.changed) return;
        const profiles = store.get('profiles', []);
        const index = profiles.findIndex((p) => p.id === updatedProfile.id);
        if (index === -1) return;
        profiles[index] = updatedProfile;
        store.set('profiles', profiles);
        try {
          const isActive = updatedProfile.id === store.get('activeProfileId');
          syncProfileToOpenCode(updatedProfile, { setActiveModel: isActive });
        } catch {
          // ignore
        }

        mainWindow?.webContents.send('profiles-changed');
      })
      .catch(() => {
        // ignore
      });
     
    // If this is active profile, re-apply
    if (updatedProfile.id === store.get('activeProfileId')) {
      activateProfile(updatedProfile.id);
    }
  }
  return true;
});

ipcMain.handle('delete-profile', (event, profileId) => {
  let profiles = store.get('profiles', []);
  const removed = profiles.find(p => p.id === profileId);
  profiles = profiles.filter(p => p.id !== profileId);
  store.set('profiles', profiles);

  if (removed?.providerId) {
    unsyncProfileFromOpenCode(removed.providerId);
  }
  
  if (store.get('activeProfileId') === profileId) {
    store.delete('activeProfileId');
  }
  return true;
});

ipcMain.handle('get-opencode-config-path', () => {
  return getOpenCodeConfigPath();
});

ipcMain.handle('get-opencode-auth-path', () => {
  return getOpenCodeAuthPath();
});

ipcMain.handle('opencode-models', async () => {
  return await runOpenCodeModels();
});

ipcMain.handle('launch-opencode', (event, args) => {
  return launchOpenCode(args);
});

ipcMain.handle('fetch-provider-models', async (event, input) => {
  try {
    const url = input && typeof input.url === 'string' ? input.url : '';
    const key = input && typeof input.key === 'string' ? input.key : '';
    const result = await fetchModelsFromProvider(url, key);
    if (Array.isArray(result)) {
      return { ok: true, modelIds: result, resolvedBaseURL: url };
    }
    return { ok: true, modelIds: result.ids || [], resolvedBaseURL: result.resolvedBaseURL || url };
  } catch (e) {
    return { ok: false, modelIds: [], resolvedBaseURL: '', error: e && e.message ? e.message : String(e) };
  }
});

// Window controls
ipcMain.on('window-minimize', () => {
  mainWindow?.hide();
});

ipcMain.on('window-close', () => {
  mainWindow?.hide();
});

// App lifecycle
app.whenReady().then(() => {
  // Ensure existing app profiles are reflected in OpenCode config files
  syncAllProfilesToOpenCode();

  createWindow();
  createTray();
  
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in tray
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});
