'use strict';
// Most mezi rendererem a hlavním procesem — jen úzké, pojmenované API.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('forge', {
  // písničky (chart/mid + song.ini + stems + album/video)
  openSong:       ()     => ipcRenderer.invoke('song:openDialog'),
  openSongFolder: ()     => ipcRenderer.invoke('song:openFolderDialog'),
  loadSongPath:   (p)    => ipcRenderer.invoke('song:loadPath', p),
  readFile:       (p)    => ipcRenderer.invoke('file:read', p),
  addRecent:      (p)    => ipcRenderer.invoke('recent:add', p),   // naposledy otevřené (File ▸ Open recent)
  recentList:     ()     => ipcRenderer.invoke('recent:list'),     // pro vlastní (HTML) lištu menu
  recentClear:    ()     => ipcRenderer.invoke('recent:clear'),
  quitApp:        ()     => ipcRenderer.send('app:quit'),
  toggleDevTools: ()     => ipcRenderer.send('app:devtools'),
  reloadApp:      ()     => ipcRenderer.send('app:reload'),
  // ukládání
  saveChart:   (filePath, content)    => ipcRenderer.invoke('chart:save', filePath, content),
  saveChartAs: (content, defaultPath) => ipcRenderer.invoke('chart:saveAs', content, defaultPath),
  // export binárních formátů (.mid / .sng) — data jako Uint8Array
  saveBinaryAs: (data, defaultPath, filterName, ext) => ipcRenderer.invoke('file:saveBinaryAs', data, defaultPath, filterName, ext),
  saveBinary:   (filePath, data)      => ipcRenderer.invoke('file:saveBinary', filePath, data),   // projekt .chartproj (Ctrl+S)
  exportSong:  (files, folderName, baseDir) => ipcRenderer.invoke('song:export', files, folderName, baseDir),
  pickExportDir: ()                   => ipcRenderer.invoke('song:pickDir'),
  saveArt:     (dir, name, data)      => ipcRenderer.invoke('art:save', dir, name, data),
  // samostatné audio
  openAudio:   () => ipcRenderer.invoke('audio:openDialog'),
  // YouTube/URL audio (yt-dlp)
  ytEnsure:     ()        => ipcRenderer.invoke('yt:ensure'),
  ytDownload:   (url, kind) => ipcRenderer.invoke('yt:download', url, kind),   // kind: 'audio' (výchozí) | 'video'
  // mezipaměť stažených médií (userData/yt) — ruční úklid, protože na soubory odkazují starší projekty
  ytCacheInfo:  ()          => ipcRenderer.invoke('yt:cacheInfo'),
  ytCacheClear: (keepPath)  => ipcRenderer.invoke('yt:cacheClear', keepPath || null),
  ytDeleteFile: (p)         => ipcRenderer.invoke('yt:deleteFile', p),   // smazat jeden stažený soubor
  onYtStatus:   (cb)      => ipcRenderer.on('yt:status', (e, s) => cb(s)),
  // drag & drop: File objekt -> absolutní cesta (File.path v novém Electronu není)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch(e){ return null; } },
  // vrátit oknu fokus (programový Alt+Tab) — když se otevře vstupní pole, ale nechytá klávesnici
  focusWin: () => ipcRenderer.send('win:focus'),
  // po startu nahlásit, o kolik px chybí sidebaru místo → okno se jednorázově dorovná (jen bez uloženého stavu)
  fitSidebar: (overflowPx) => ipcRenderer.send('win:fitSidebar', overflowPx),
  onMenu: (cb) => ipcRenderer.on('menu', (e, action) => cb(action)),
  // Window menu: přepínání viditelnosti panelů (Photoshop-style)
  onPanelToggle: (cb) => ipcRenderer.on('panel:toggle', (e, id, visible) => cb(id, visible)),
  sendPanelStates: (states) => ipcRenderer.invoke('panel:states', states),
});
