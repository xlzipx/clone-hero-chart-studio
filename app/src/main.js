'use strict';
// ChartStudio — hlavní proces Electronu.
// Okno + nativní dialogy + načítání celých písniček (chart/mid + song.ini + stems)
// + aplikační menu + hlídání neuložených změn.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

// Platforma. Na macOS má aplikace jinou lištu menu (nahoře v systému, ne v okně),
// jinou příponu spustitelných binárek a jinou konvenci zavírání oken. Všechny odchylky
// od Windows chování drží jeden přepínač, ať se nedá zapomenout na některé místo.
const IS_MAC = process.platform === 'darwin';
// yt-dlp přípona: Windows „yt-dlp.exe", macOS/Linux „yt-dlp" (bez přípony).
// ffmpeg totéž. Držíme to jako konstanty, ať se dole nemusí platform-checkovat na 3 místech.
const YTDLP_BIN = IS_MAC ? 'yt-dlp_macos' : 'yt-dlp.exe';
const FFMPEG_BIN = IS_MAC ? 'ffmpeg' : 'ffmpeg.exe';

// Windows „zamrznutí do Alt+Tabu": okno (nebo políčko) přestane reagovat na vstup, dokud ho
// znovu neaktivuješ. Dvě příčiny, obě řešíme:
//  1) GPU kompozitor se občas zasekne (v konzoli „GPU state invalid after WaitForGetOffsetInRange")
//     — při zátěži z 60fps kreslení highwaye přestane přijímat/směrovat vstup. Alt+Tab vynutí
//     re-kompozici → ožije. Vypnutím HW akcelerace jede kreslení softwarově (pro 2D canvas plně
//     dostačuje) a tahle třída zamrznutí zmizí i s těmi GPU chybami.
//  2) Chromium občas chybně vyhodnotí okno jako „zakryté" (native occlusion) a uspí ho.
// Obě vypínáme (+ backgroundThrottling:false na okně), ať okno zůstane vždy živé a reagující.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const SMOKE = process.argv.includes('--smoke'); // headless kontrola pro CI/testy
// Jen jedna instance (smoke testy z toho vyjmuty, ty se pouštějí i souběžně). Dvě spuštěné
// aplikace si navzájem přepisovaly window-state.json i recent.json — vyhrála ta, co skončila
// později, a uživateli beze stopy zmizely položky v Open recent.
if(!SMOKE && !app.requestSingleInstanceLock()){
  app.quit();
} else {
  app.on('second-instance', () => {
    if(win && !win.isDestroyed()){
      if(win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
const argAfter = flag => { const i = process.argv.indexOf(flag); return (i >= 0 && process.argv[i+1]) ? process.argv[i+1] : null; };
const SMOKE_SONG = argAfter('--song');
const SMOKE_YT = process.argv.includes('--ytcheck');

let win = null;
let forceClose = false;

// Výchozí velikost okna je odvozená z toho, co UI reálně potřebuje: poslední panel v sidebaru končí
// těsně nad stavovým řádkem — bez posuvníku a bez velké mezery. Čísla jsou změřená v rendereru,
// ale nemusí sedět navěky (stačí přidat tlačítko do panelu), proto je po startu ještě dorovná
// jednorázový auto-fit (`win:fitSidebar`) — tyhle konstanty jsou jen prvotní odhad, ať okno
// nenaskočí ve špatné velikosti a hned se nepřekreslovalo.
const UI_SIDEBAR_H = 1210;                 // obsah sidebaru ve výchozím rozložení (1 sloupec, 232 px)
const UI_CHROME_H  = 113;                  // toolbar + druhý řádek lišty + stavový řádek
const UI_NEED_H    = UI_SIDEBAR_H + UI_CHROME_H + 2;   // +2 px rezerva proti zaokrouhlení (jinak vyskočí posuvník)
const UI_MIN_1ROW_W = 1600;                // pod ~1555 px se horní lišta zalomí na dva řádky (a sidebar by přetekl)

// Zapamatovaná velikost/pozice okna (userData/window-state.json) — okno se otevře přesně tak,
// jak si ho uživatel naposledy nastavil (vč. maximalizace). Bez uloženého stavu platí dopočtený default.
function windowStatePath(){ return path.join(app.getPath('userData'), 'window-state.json'); }
function loadWindowState(){
  try {
    const st = JSON.parse(fssync.readFileSync(windowStatePath(), 'utf8'));
    if(!(st && st.width >= 940 && st.height >= 600)) return null;
    // musí být aspoň zčásti vidět na některém z aktuálních displejů (odpojený monitor apod.)
    const onScreen = screen.getAllDisplays().some(d => {
      const a = d.workArea;
      return st.x < a.x + a.width - 60 && st.x + st.width > a.x + 60 && st.y < a.y + a.height - 60 && st.y + st.height > a.y + 60;
    });
    if(!onScreen) return null;
    // Uložený rozměr může pocházet z VĚTŠÍHO monitoru (jiný počítač, odpojený displej,
    // změna škálování Windows). Bez tohohle by okno naskočilo mimo obrazovku i s titulkem.
    // Vejde se do pracovní plochy toho displeje, na kterém okno leží.
    const d = screen.getDisplayMatching({x: st.x, y: st.y, width: st.width, height: st.height});
    const a = d.workArea;
    // pozor: st.width/height je velikost OBSAHU (useContentSize), takže u výšky je potřeba
    // nechat místo i na titulkový pruh — jinak by okno o jeho výšku přesahovalo dolů
    st.width  = Math.max(940, Math.min(st.width,  a.width  - 20));
    st.height = Math.max(600, Math.min(st.height, a.height - 60));
    st.x = Math.min(Math.max(st.x, a.x), a.x + a.width  - st.width);
    st.y = Math.min(Math.max(st.y, a.y), a.y + a.height - st.height);
    return st;
  } catch(e){ return null; }
}
// Ukládá se POZICE z vnějších bounds + VELIKOST OBSAHU (`useContentSize` při obnovení).
// KLÍČOVÉ: ukládá se jen skutečná UŽIVATELSKÁ změna. Windows si při vytváření okna velikost o pár
// pixelů upraví (rám + DPI škálování); kdybychom tenhle dopočet uložili zpět, okno by každým
// spuštěním o kousek narostlo. Startovní „usazení" proto ignorujeme (_wsReady) a uložený rozměr
// zůstává přesně ten, na který uživatel okno naposledy roztáhl.
let _wsReady = false;         // true až po usazení okna po startu
let _wsUserChanged = false;   // uživatel sám hnul oknem / změnil velikost (jen pak přepisovat soubor)
let _wsHadSaved = false;      // okno se otevřelo z uloženého stavu → auto-fit sidebaru se neuplatní
let _lastNormalSize = null;   // poslední velikost obsahu v nemaximalizovaném stavu
function saveWindowState(){
  if(SMOKE || !_wsUserChanged || !win || win.isDestroyed()) return;
  try {
    const maximized = win.isMaximized();
    if(!maximized){ const c = win.getContentBounds(); _lastNormalSize = {width: c.width, height: c.height}; }
    if(!_lastNormalSize) return;                       // maximalizováno hned po startu, normal size neznáme
    const b = win.getNormalBounds();
    fssync.writeFileSync(windowStatePath(), JSON.stringify({maximized, x: b.x, y: b.y, ..._lastNormalSize}));
  } catch(e){}
}
let _winStateTimer = null;
function queueWindowStateSave(){
  if(!_wsReady) return;                     // startovní usazení okna není uživatelská změna
  _wsUserChanged = true;
  clearTimeout(_winStateTimer); _winStateTimer = setTimeout(saveWindowState, 500);
}

function createWindow(){
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const winH = Math.min(UI_NEED_H, wa.height - 30);
  const winW = Math.min(Math.max(UI_MIN_1ROW_W, Math.round(winH * 1.45)), wa.width - 30);
  const saved = loadWindowState();
  win = new BrowserWindow({
    // Uložený stav jde PŘÍMO do konstruktoru (pozdější setBounds na Windows rozměr posouvá).
    // Bez uloženého stavu platí dopočtený default, vycentrovaný.
    useContentSize: true,    // width/height = vnitřní plocha (bez rámu) — nezávislé na tloušťce rámu
    ...(saved
      ? {x: saved.x, y: saved.y, width: saved.width, height: saved.height}
      : {width: winW, height: winH, center: true}),
    minWidth: 940,
    minHeight: 600,
    show: !SMOKE,
    backgroundColor: '#141519',
    icon: path.join(__dirname, 'renderer', 'assets', 'appicon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,        // preload potřebuje webUtils (drag & drop cesty); izolace kontextu zůstává
      zoomFactor: 1.0,       // výchozí UI scale = 100 %
      backgroundThrottling: false,  // nepozastavovat rAF/vstup, i když Chromium okno chybně „odloží"
    },
  });

  // Nativní lišta menu se na Windows SKRYJE (Alt ji nevyvolá), ale aplikační menu zůstává
  // nastavené — drží akcelerátory (Ctrl+S, Ctrl+O, Ctrl+E…), takže se žádná zkratka neztrácí.
  // Samotný pruh s File/Edit/View kreslí renderer vlastní (HTML): u nativního pruhu je citlivá
  // plocha položky jen obdélník kolem textu, ne celá výška pruhu, a přejezd myší kousek níž se
  // proto „nechytal".
  //
  // Na macOS je aplikační menu v LIŠTĚ NAHOŘE OBRAZOVKY, ne v okně — `setMenuBarVisibility`
  // se tam ignoruje a systémovou lištu není ani žádoucí schovávat; HTML lištu v okně
  // renderer sám na Macu skryje, aby se položky nezdvojovaly.
  if(!IS_MAC) win.setMenuBarVisibility(false);

  if(saved && saved.maximized) win.maximize();
  if(saved){ _wsHadSaved = true; _lastNormalSize = {width: saved.width, height: saved.height}; }   // dokud uživatel nesáhne, platí uložené
  // uživatelské změny velikosti/pozice se (odloženě) ukládají; startovní usazení okna se ignoruje
  setTimeout(() => { _wsReady = true; }, 1200);
  for(const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, queueWindowStateSave);
  win.on('close', () => saveWindowState());

  // uzamknout UI scale na 100 % (aby se nepřenášel dřívější Ctrl +/- zoom)
  win.webContents.on('did-finish-load', () => { try { win.webContents.setZoomFactor(1.0); } catch(e){} });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Neuložené změny: zeptat se před zavřením
  win.on('close', async (e) => {
    if(forceClose || SMOKE) return;
    e.preventDefault();
    let dirty = false;
    try { dirty = await win.webContents.executeJavaScript('!!(window.CF && CF.state.dirty)'); }
    catch(err){ dirty = false; }
    if(dirty){
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Save & close', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Unsaved changes',
        detail: 'The chart has unsaved changes. Save before closing?',
      });
      if(r === 2) return;
      if(r === 0){
        const ok = await win.webContents.executeJavaScript('window.__forgeSave ? __forgeSave() : true').catch(() => false);
        if(!ok) return; // uživatel zrušil Save As dialog
      }
    }
    forceClose = true;
    win.close();
  });

  win.webContents.setWindowOpenHandler(({url}) => {
    if(url.startsWith('https://')) shell.openExternal(url);
    return {action: 'deny'};
  });

  // Nativní kontextové menu (pravé tlačítko) pro textová pole — Vyjmout/Kopírovat/Vložit.
  // Bez toho jde v Electronu jen Ctrl+V; role řeší schránku nativně pro fokusovaný webContents.
  win.webContents.on('context-menu', (e, params) => {
    if(params.isEditable){
      Menu.buildFromTemplate([
        {role: 'cut', enabled: params.editFlags.canCut},
        {role: 'copy', enabled: params.editFlags.canCopy},
        {role: 'paste', enabled: params.editFlags.canPaste},
        {type: 'separator'},
        {role: 'selectAll'},
      ]).popup({window: win});
    } else if(params.selectionText){
      Menu.buildFromTemplate([{role: 'copy'}]).popup({window: win});
    }
  });

  if(SMOKE){
    // Bez těchto dvou pojistek smoke test nic nehlídal: při chybě načtení nikdy nepřišel
    // did-finish-load a proces visel navždy, a i „FAILED" končilo návratovým kódem 0,
    // takže rozbitý build prošel jako v pořádku.
    const smokeFail = msg => { console.log('[smoke] FAILED', msg); process.exitCode = 1; forceClose = true; app.quit(); };
    const smokeTimer = setTimeout(() => smokeFail('timeout — okno se nenačetlo do 90 s'), 90000);
    win.webContents.on('did-fail-load', (e2, code, desc) => { clearTimeout(smokeTimer); smokeFail('did-fail-load ' + code + ' ' + desc); });
    win.webContents.on('did-finish-load', async () => {
      clearTimeout(smokeTimer);
      try {
        if(SMOKE_SONG){
          const r = await win.webContents.executeJavaScript(
            `window.__forgeSmokeSong(${JSON.stringify(SMOKE_SONG)})`, true
          );
          console.log('[smoke:song]', r);
        } else if(SMOKE_YT){
          const r = await win.webContents.executeJavaScript(
            `window.forge.ytEnsure().then(x => JSON.stringify(x))`, true
          );
          console.log('[smoke:yt]', r);
        } else {
          const r = await win.webContents.executeJavaScript(
            '(window.CF && CF.state.chart) ? "CF-OK notes=" + Object.keys(CF.state.chart.tracks).length : "CF-MISSING"'
          );
          console.log('[smoke]', r, '| forge api:', await win.webContents.executeJavaScript('typeof window.forge'));
          // Lišta menu:
          //  - Windows: HTML lišta vidět (File/Edit/View/Window/Keybinds), nativní schovaná.
          //  - macOS: HTML lišta hidden (menu je nahoře v systému), nativní musí obsahovat
          //    „ChartStudio" jako první položku (systémový App menu contract).
          // Aplikační menu (nativní) musí být VŽDY nastavené — drží akcelerátory.
          const bar = await win.webContents.executeJavaScript(
            '(() => { const b = document.getElementById("menubar"); return b ? (b.hidden ? "hidden" : [...b.children].map(x => x.textContent).join(",")) : "chybi"; })()'
          );
          const nativeMenu = !!Menu.getApplicationMenu();
          const nativeItems = Menu.getApplicationMenu() ? Menu.getApplicationMenu().items.map(i => i.label).join(',') : '';
          console.log('[smoke:menu] HTML lišta:', bar, '| nativní pruh viditelný:', win.isMenuBarVisible(), '| app menu (akcelerátory):', nativeMenu, '| položky:', nativeItems);
          const expectedBar = IS_MAC ? 'hidden' : 'File,Edit,View,Window,Keybinds';
          const expectedNative = IS_MAC ? 'ChartStudio,File,Edit,View,Window,Keybinds' : 'File,Edit,View,Window,Keybinds';
          if(bar !== expectedBar || (!IS_MAC && win.isMenuBarVisible()) || !nativeMenu || nativeItems !== expectedNative){
            console.log('[smoke] FAILED lišta menu');
            process.exitCode = 1;
          }
          if(typeof r === 'string' && r.startsWith('CF-MISSING')) process.exitCode = 1;
        }
      } catch(err){
        console.log('[smoke] FAILED', err.message);
        process.exitCode = 1;
      }
      forceClose = true;
      app.quit();
    });
  }
}

// ---------- Načítání písničky (chart/mid + song.ini + audio stems) ----------
const CHART_FILTERS = [
  {name: 'ChartStudio project & songs', extensions: ['chartproj', 'chart', 'mid', 'midi', 'sng']},
  {name: 'ChartStudio project', extensions: ['chartproj']},
  {name: 'Clone Hero songs', extensions: ['chart', 'mid', 'midi', 'sng']},
  {name: 'All files', extensions: ['*']},
];
const AUDIO_EXTS = ['.ogg', '.opus', '.mp3', '.wav', '.flac', '.m4a'];
const AUDIO_FILTERS = [
  {name: 'Audio', extensions: AUDIO_EXTS.map(e => e.slice(1))},
  {name: 'All files', extensions: ['*']},
];
// pojmenování stop podle CH/Phase Shift konvence
const STEM_NAMES = new Set([
  'song','guitar','rhythm','bass','keys','drums',
  'drums_1','drums_2','drums_3','drums_4',
  'vocals','vocals_1','vocals_2','crowd',
]);

function findChartInDir(dir){
  let entries;
  try { entries = fssync.readdirSync(dir); } catch(e){ return null; }
  const lower = new Map(entries.map(f => [f.toLowerCase(), f]));
  // projekt ChartStudia má přednost — nese víc než herní notes.chart (média, lyrics, pozice)
  const anyProj = entries.find(f => /\.chartproj$/i.test(f));
  if(anyProj) return path.join(dir, anyProj);
  for(const pref of ['notes.chart', 'notes.mid', 'notes.midi']){
    if(lower.has(pref)) return path.join(dir, lower.get(pref));
  }
  const anyChart = entries.find(f => /\.chart$/i.test(f));
  if(anyChart) return path.join(dir, anyChart);
  const anyMid = entries.find(f => /\.midi?$/i.test(f));
  if(anyMid) return path.join(dir, anyMid);
  const anySng = entries.find(f => /\.sng$/i.test(f));   // zabalená CH písnička (jeden soubor)
  if(anySng) return path.join(dir, anySng);
  return null;
}

async function gatherSong(chartPath){
  const dir = path.dirname(chartPath);
  // .chartproj = projekt ChartStudia (kontejner: chart + média + stav editoru) — rozbalí ho renderer
  if(/\.chartproj$/i.test(chartPath)){
    return {chartPath, songDir: dir, kind: 'proj', stems: [], data: await fs.readFile(chartPath)};
  }
  // .sng = zabalený formát (chart + ini metadata + audio v jednom) — rozbalí ho renderer
  if(/\.sng$/i.test(chartPath)){
    return {chartPath, songDir: dir, kind: 'sng', stems: [], data: await fs.readFile(chartPath)};
  }
  const kind = /\.midi?$/i.test(chartPath) ? 'mid' : 'chart';
  const payload = {chartPath, songDir: dir, kind, stems: []};
  if(kind === 'chart') payload.text = await fs.readFile(chartPath, 'utf8');
  else payload.data = await fs.readFile(chartPath);   // Buffer -> po IPC Uint8Array

  let entries = [];
  try { entries = await fs.readdir(dir); } catch(e){}
  for(const f of entries){
    const ext = path.extname(f).toLowerCase();
    const base = path.basename(f, path.extname(f)).toLowerCase();
    if(f.toLowerCase() === 'song.ini'){
      try { payload.ini = await fs.readFile(path.join(dir, f), 'utf8'); } catch(e){}
    } else if(AUDIO_EXTS.includes(ext) && (STEM_NAMES.has(base) || base === 'preview')){
      if(base !== 'preview') payload.stems.push({name: f, path: path.join(dir, f)});
    } else if(/^album\.(png|jpe?g)$/i.test(f)){
      payload.albumPath = path.join(dir, f);
    } else if(/^video\.(mp4|webm|avi|mpe?g)$/i.test(f)){
      payload.videoPath = path.join(dir, f);   // pozadí za highwayí (hotová CH složka ho má vedle chartu)
    }
  }
  // složka bez pojmenovaných stop: vezmi jakékoli audio (např. "Song Name.mp3")
  if(!payload.stems.length){
    for(const f of entries){
      if(AUDIO_EXTS.includes(path.extname(f).toLowerCase())){
        payload.stems.push({name: f, path: path.join(dir, f)});
        if(payload.stems.length >= 3) break;
      }
    }
  }
  payload.stems.sort((a,b) => (a.name.toLowerCase().startsWith('song') ? -1 : 0) - (b.name.toLowerCase().startsWith('song') ? -1 : 0));
  return payload;
}

async function loadSongFromPath(p){
  try {
    const st = await fs.stat(p);
    if(st.isDirectory()){
      const chartPath = findChartInDir(p);
      if(!chartPath) return {error: 'No .chart or .mid file found in this folder.'};
      return await gatherSong(chartPath);
    }
    if(/\.(chartproj|chart|midi?|sng)$/i.test(p)) return await gatherSong(p);
    return {error: 'Unsupported file type: ' + path.basename(p)};
  } catch(err){
    return {error: 'Could not load song: ' + err.message};
  }
}

ipcMain.handle('song:openDialog', async () => {
  const r = await dialog.showOpenDialog(win, {filters: CHART_FILTERS, properties: ['openFile']});
  if(r.canceled || !r.filePaths.length) return null;
  return loadSongFromPath(r.filePaths[0]);
});

ipcMain.handle('song:openFolderDialog', async () => {
  const r = await dialog.showOpenDialog(win, {properties: ['openDirectory']});
  if(r.canceled || !r.filePaths.length) return null;
  return loadSongFromPath(r.filePaths[0]);
});

ipcMain.handle('song:loadPath', async (e, p) => loadSongFromPath(p));

ipcMain.handle('file:read', async (e, p) => fs.readFile(p));

// Programový „Alt+Tab": vrátit oknu i jeho webContents fokus. Řeší občasný Windows/Electron stav,
// kdy se otevře vstupní pole (inline editace slabiky, dialog…), ale nechytá klávesnici, dokud okno
// ručně znovu neaktivuješ. Volá renderer při otevření pole. Bez webview → žádná kolize fokusu.
ipcMain.on('win:focus', () => {
  if(win && !win.isDestroyed()){
    try { win.focus(); win.webContents.focus(); } catch(e){}
  }
});

// Auto-fit výchozí výšky: renderer po startu pošle, o kolik px sidebaru chybí místo. Okno se
// jednorázově zvětší, aby se všechny panely vešly bez posuvníku (a zůstalo vycentrované).
// Jen když si okno velikost ještě nepamatuje — uživatelovu vlastní velikost nikdy nepřepisujeme.
ipcMain.on('win:fitSidebar', (e, overflow) => {
  if(!win || win.isDestroyed() || _wsHadSaved || win.isMaximized()) return;
  if(!(overflow > 0)) return;
  const [w, h] = win.getContentSize();
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const newH = Math.min(h + Math.ceil(overflow), wa.height - 60);
  if(newH > h){ win.setContentSize(w, newH); win.center(); }
});

// ---------- Ukládání ----------
// Zápis přes .tmp + rename, stejně jako u binárních souborů: pád nebo plný disk uprostřed
// zápisu jinak usekne uživatelův .chart a původní obsah je nenávratně pryč.
ipcMain.handle('chart:save', async (e, filePath, content) => {
  const tmp = filePath + '.tmp';
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
    return {ok: true};
  } catch(err){
    try { await fs.unlink(tmp); } catch(e2){}
    return {error: 'Could not save the chart: ' + err.message};
  }
});

ipcMain.handle('chart:saveAs', async (e, content, defaultPath) => {
  const r = await dialog.showSaveDialog(win, {
    filters: [{name: 'Clone Hero chart', extensions: ['chart']}],
    defaultPath: defaultPath || 'notes.chart',
  });
  if(r.canceled || !r.filePath) return null;
  try { await fs.writeFile(r.filePath, content, 'utf8'); }
  catch(err){ return {error: 'Could not save the chart: ' + err.message}; }
  return {path: r.filePath};
});

// Uložení BINÁRNÍHO souboru (export .mid / .sng). Data chodí jako Uint8Array přes structured clone.
ipcMain.handle('file:saveBinaryAs', async (e, data, defaultPath, filterName, ext) => {
  const r = await dialog.showSaveDialog(win, {
    filters: [{name: filterName || 'File', extensions: [ext || 'bin']}],
    defaultPath: defaultPath || ('export.' + (ext || 'bin')),
  });
  if(r.canceled || !r.filePath) return null;
  try { await fs.writeFile(r.filePath, Buffer.from(data)); }
  catch(err){ return {error: 'Could not save the file: ' + err.message}; }
  return {path: r.filePath};
});

// Přepis binárního souboru na známé cestě (Ctrl+S nad projektem). Píše se do .tmp a teprve pak
// přejmenuje — kdyby zápis stominutového videa spadl uprostřed, o původní projekt nepřijdeš.
ipcMain.handle('file:saveBinary', async (e, filePath, data) => {
  const tmp = filePath + '.tmp';
  try {
    await fs.writeFile(tmp, Buffer.from(data));
    await fs.rename(tmp, filePath);
    return {ok: true, path: filePath};
  } catch(err){
    try { await fs.unlink(tmp); } catch(e2){}
    return {error: 'Could not save the file: ' + err.message};
  }
});

// ---------- Export Clone Hero song folder ----------
// Vybere se jen NADŘAZENÉ umístění; složka „Umělec - Píseň" se vytvoří automaticky
ipcMain.handle('song:export', async (e, files, folderName, baseDir) => {
  // přednastavená cílová složka (pokud platí a existuje) → bez dialogu
  let base = (typeof baseDir === 'string' && baseDir && fssync.existsSync(baseDir)) ? baseDir : null;
  if(!base){
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to create the song folder (e.g. your Clone Hero Songs folder)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if(r.canceled || !r.filePaths.length) return null;
    base = r.filePaths[0];
  }
  // sanitizace názvu složky (Windows: zakázané znaky + tečka/mezera na konci)
  const safe = String(folderName || 'Untitled Song')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || 'Untitled Song';
  const dir = path.join(base, safe);
  // varovat i u .mid písničky — dřív se hlídal jen notes.chart, takže složce s notes.mid
  // se bez ptaní přepsalo song.ini i album
  const clash = ['notes.chart', 'notes.mid', 'song.ini'].find(n => fssync.existsSync(path.join(dir, n)));
  if(clash){
    const c = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Overwrite', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'The song folder already exists',
      detail: safe + ' already contains ' + clash + '. Overwrite the exported files?',
    });
    if(c === 1) return null;
  }
  try {
    await fs.mkdir(dir, {recursive: true});
    for(const f of files){
      const data = (f.data instanceof Uint8Array || Buffer.isBuffer(f.data)) ? Buffer.from(f.data) : Buffer.from(String(f.data), 'utf8');
      await fs.writeFile(path.join(dir, path.basename(String(f.name))), data);   // jméno jen holé, nikdy cesta
    }
  } catch(err){ return {error: 'Could not write the song folder: ' + err.message}; }
  return dir;
});

// výběr přednastavené cílové složky pro exporty (jen vrátí cestu, nic nezapisuje)
ipcMain.handle('song:pickDir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose the default export destination (e.g. your Clone Hero Songs folder)',
    properties: ['openDirectory', 'createDirectory'],
  });
  return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
});

// ---------- Album art ----------
ipcMain.handle('art:save', async (e, dir, name, data) => {
  if(!dir) return {error: 'No song folder to save album art into.'};
  try { await fs.writeFile(path.join(dir, name || 'album.png'), Buffer.from(data)); return {ok: true}; }
  catch(err){ return {error: 'Could not save album art: ' + err.message}; }
});

// ---------- YouTube audio přes yt-dlp ----------
// Hledáme v userData (kam si ji sami stahujeme) a pak v PATH. Na macOS aplikaci spuštěné
// z Docku Chromium NEdědí uživatelův shell PATH — obvyklé Homebrew cesty (`/opt/homebrew/bin`,
// `/usr/local/bin`) v PATH nejsou. Přidáváme je proto ručně, aby yt-dlp nainstalovaný přes
// `brew install yt-dlp` byl vidět. Bez toho by se aplikace pořád ptala na stažení.
const MAC_EXTRA_PATHS = IS_MAC ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] : [];
function findYtDlp(){
  const local = path.join(app.getPath('userData'), 'tools', YTDLP_BIN);
  if(fssync.existsSync(local)) return local;
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(MAC_EXTRA_PATHS);
  for(const d of dirs){
    if(!d) continue;
    try { const p = path.join(d, YTDLP_BIN); if(fssync.existsSync(p)) return p; } catch(e){}
  }
  return null;
}
ipcMain.handle('yt:ensure', async () => {
  const found = findYtDlp();
  if(found) return {path: found};
  if(!SMOKE){
    const c = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Download yt-dlp', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'yt-dlp is required',
      detail: YTDLP_BIN + ' was not found on this computer. Download the official build from the yt-dlp GitHub releases into the app data folder?',
    });
    if(c === 1) return {error: 'yt-dlp not available'};
  } else return {error: 'yt-dlp not found (smoke: no download)'};
  try {
    const dir = path.join(app.getPath('userData'), 'tools');
    await fs.mkdir(dir, {recursive: true});
    const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + YTDLP_BIN, {redirect: 'follow'});
    if(!r.ok) return {error: 'Download failed: HTTP ' + r.status};
    const dest = path.join(dir, YTDLP_BIN);
    // Zápis přes .tmp + rename: useknutý soubor (došlo místo, zabitá appka) se dřív tvářil jako
    // hotová instalace — findYtDlp() ho pak vracel navždy, stahování padalo a v UI nebylo jak to
    // spravit. Malý soubor navíc rovnou odmítneme, ať nezůstane vadná kopie.
    const buf = Buffer.from(await r.arrayBuffer());
    if(buf.length < 1024 * 1024) return {error: 'Download failed: incomplete file (' + buf.length + ' B)'};
    const tmp = dest + '.tmp';
    try {
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, dest);
      // Na Unixech je stažený soubor obyčejný „regular file" bez `x` bitu — bez chmodu by
      // spawn skončil `EACCES: permission denied`. Windows práva neřeší, tohle je no-op.
      if(!IS_MAC) { /* windows: přípona .exe stačí */ }
      else { try { await fs.chmod(dest, 0o755); } catch(e){} }
    } catch(err){ try { await fs.unlink(tmp); } catch(e){} throw err; }
    return {path: dest, downloaded: true};
  } catch(err){ return {error: 'Download failed: ' + err.message}; }
});
// Mezipaměť stažených médií (userData/yt). Soubory se ZÁMĚRNĚ nemažou samy — starší projekty
// na ně odkazují přes DFAudioPath. Úklid je proto ruční, přes tlačítko v dialogu stahování.
function ytCacheDir(){ return path.join(app.getPath('userData'), 'yt'); }
ipcMain.handle('yt:cacheInfo', async () => {
  const dir = ytCacheDir();
  try {
    const names = await fs.readdir(dir);
    let bytes = 0, count = 0;
    for(const n of names){
      try { const st = await fs.stat(path.join(dir, n)); if(st.isFile()){ bytes += st.size; count++; } } catch(err){}
    }
    return {dir, count, bytes};
  } catch(err){ return {dir, count: 0, bytes: 0}; }
});
// keepPath = soubor, který používá právě otevřený projekt (ten se nemaže)
ipcMain.handle('yt:cacheClear', async (e, keepPath) => {
  const dir = ytCacheDir();
  const keep = keepPath ? path.resolve(String(keepPath)).toLowerCase() : null;
  let removed = 0, bytes = 0, kept = 0;
  try {
    for(const n of await fs.readdir(dir)){
      const p = path.join(dir, n);
      try {
        const st = await fs.stat(p);
        if(!st.isFile()) continue;
        if(keep && path.resolve(p).toLowerCase() === keep){ kept++; continue; }
        await fs.unlink(p);
        removed++; bytes += st.size;
      } catch(err){}
    }
  } catch(err){ return {error: 'Could not clear the cache: ' + err.message}; }
  return {removed, bytes, kept};
});
// ffmpeg (volitelný): bez něj nelze 1080p. Vyšší rozlišení jsou na YouTube jen jako DASH stopy
// a ty se stáhnou jako FRAGMENTOVANÉ mp4 (ftyp moov sidx moof mdat …), které Clone Hero nepřehraje.
// S ffmpegem se soubor po stažení přebalí na progresivní mp4 (ftyp moov mdat) — bez překódování.
function findFfmpeg(){
  const local = path.join(app.getPath('userData'), 'tools', FFMPEG_BIN);
  if(fssync.existsSync(local)) return local;
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(MAC_EXTRA_PATHS);
  for(const d of dirs){
    if(!d) continue;
    try { const p = path.join(d, FFMPEG_BIN); if(fssync.existsSync(p)) return p; } catch(e){}
  }
  return null;
}
// Běžící potomci (yt-dlp / ffmpeg), aby se dali ukončit se zavřením aplikace. Na Windows
// potomek přežije rodiče, takže bez tohohle běžel yt-dlp dál skrytě na pozadí a plnil
// mezipaměť souborem, ke kterému už nic nevedlo.
const running = new Set();
app.on('before-quit', () => { for(const p of running){ try { p.kill(); } catch(e){} } running.clear(); });
function runProc(exe, args){
  return new Promise(resolve => {
    const p = spawn(exe, args, {windowsHide: true});
    running.add(p);
    let err = '';
    p.stdout.on('data', () => {});                 // odebírat stdout, ať se proces nezasekne na plné rouře
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', e => { running.delete(p); resolve({code: -1, err: e.message}); });
    p.on('close', code => { running.delete(p); resolve({code, err}); });
  });
}
// Přebalit stažené video na progresivní mp4. Stream copy → rychlé a beze ztráty kvality.
async function remuxProgressive(file, ff){
  const tmp = file.replace(/\.[^.]+$/, '') + '.prog.mp4';
  const r = await runProc(ff, ['-y', '-v', 'error', '-i', file, '-c', 'copy', '-movflags', '+faststart', tmp]);
  if(r.code !== 0){ try { await fs.unlink(tmp); } catch(e){} return {ok: false, err: r.err}; }
  // POŘADÍ: nejdřív přejmenovat, teprve pak mazat zdroj. Dřív se zdroj mazal první a když
  // rename selhal (antivirus na chvíli drží nový soubor, plný disk), catch smazal i .tmp —
  // uživateli po stažení 200MB videa nezbylo na disku nic.
  const out = file.replace(/\.[^.]+$/, '') + '.mp4';
  const sameName = path.resolve(out) === path.resolve(file);
  try {
    const st = await fs.stat(tmp);
    if(!st.size) throw new Error('prázdný výstup');
    if(sameName){
      const bak = file + '.old';
      await fs.rename(file, bak);                                  // uvolnit jméno, ale zdroj neztratit
      try { await fs.rename(tmp, out); }
      catch(err){ await fs.rename(bak, file); throw err; }          // nepovedlo se → vrátit původní
      try { await fs.unlink(bak); } catch(e){}
    } else {
      await fs.rename(tmp, out);
      try { await fs.unlink(file); } catch(e){}                     // zdroj až nakonec, selhání nevadí
    }
    return {ok: true, file: out};
  } catch(err){ try { await fs.unlink(tmp); } catch(e){} return {ok: false, err: err.message}; }
}

// Smazání JEDNOHO staženého souboru. Pojistka: cesta musí ležet uvnitř mezipaměti,
// jinak by šlo přes tohle IPC smazat cokoliv na disku.
ipcMain.handle('yt:deleteFile', async (e, filePath) => {
  if(!filePath) return {error: 'No file'};
  const dir = path.resolve(ytCacheDir());
  const p = path.resolve(String(filePath));
  if(p !== path.join(dir, path.basename(p))) return {error: 'That file is not in the download cache.'};
  try {
    const st = await fs.stat(p);
    await fs.unlink(p);
    return {removed: 1, bytes: st.size};
  } catch(err){
    if(err && err.code === 'ENOENT') return {removed: 0, bytes: 0};   // už tam není → není co řešit
    return {error: 'Could not delete the file: ' + err.message};
  }
});
ipcMain.handle('yt:download', async (e, videoUrl, kind) => {
  // yt-dlp podporuje 1000+ webů (YouTube, SoundCloud, Vimeo, Bandcamp…) — stačí ověřit, že jde o http(s) URL
  if(typeof videoUrl !== 'string' || !/^https?:\/\/\S+\.\S+/i.test(videoUrl)) return {error: 'Not a valid URL'};
  const exe = findYtDlp();
  if(!exe) return {error: 'yt-dlp not available'};
  const isVideo = kind === 'video';
  const outDir = path.join(app.getPath('userData'), 'yt');
  try { await fs.mkdir(outDir, {recursive: true}); } catch(err){}
  const status = s => { if(win && !win.isDestroyed()) win.webContents.send('yt:status', s); };
  status(isVideo ? 'Starting yt-dlp (video)…' : 'Starting yt-dlp…');
  return await new Promise(resolve => {
    // audio: bestaudio webm (opus) = dekódovatelné bez ffmpeg konverze
    // video: pozadí za highwayí se ve hře přehrává BEZ ZVUKU, takže bereme stopu jen s obrazem
    //        (`bestvideo`). Tím odpadá slučování obrazu se zvukem, které jediné vyžadovalo ffmpeg
    //        a drželo nás dřív na 720p — 1080p je na YouTube dostupné jen jako samostatná stopa.
    //        Clone Hero chce x264, proto se avc1 preferuje; progresivní mp4 zůstává jako záloha.
    // BEZ ffmpegu smí jít jen PROGRESIVNÍ formáty (obraz i zvuk v jednom, max 720p) — DASH stopy
    // se stáhnou fragmentované a hra je nepřehraje. S ffmpegem sáhneme po 1080p a přebalíme.
    const ff = isVideo ? findFfmpeg() : null;
    const progressive = ['best[ext=mp4][vcodec^=avc1][height<=720]', 'best[ext=mp4][height<=720]', 'best[ext=mp4]', 'best'];
    const vfmt = (ff ? [
      'bestvideo[ext=mp4][vcodec^=avc1][height<=1080]',   // ideál: 1080p h264, jen obraz
      'bestvideo[ext=mp4][height<=1080]',                 // 1080p mp4 jiným kodekem
    ] : []).concat(progressive).join('/');
    const args = ['--no-playlist',
      '-f', isVideo ? vfmt : 'bestaudio[ext=webm]/bestaudio',
      '-o', path.join(outDir, (isVideo ? 'bg ' : '') + '%(title).80s [%(id)s].%(ext)s'),
      '--no-mtime', '--force-overwrites', '--newline',
      // POZOR: samotná výška klame — u ultra-širokých videí má 1080p stopa třeba 1920×748
      // a hláška „748p" vypadá jako degradace. Proto se hlásí ŠÍŘKA×VÝŠKA + jak formát značí YouTube.
      ...(isVideo ? ['--print', 'before_dl:[res] %(width)sx%(height)s (%(format_note)s)'] : []),
      '--print', 'after_move:filepath', '--no-simulate', videoUrl];
    const proc = spawn(exe, args, {windowsHide: true});
    running.add(proc);
    proc.on('close', () => running.delete(proc));
    proc.on('error', () => running.delete(proc));
    let out = '', errTxt = '';
    proc.stdout.on('data', d => {
      const s = d.toString(); out += s;
      const lines = s.split(/\r?\n/).filter(Boolean);
      // `--print before_dl` nám řekne, jaká varianta se opravdu vybrala (kontrola, že jedeme 1080p)
      const res = lines.reverse().find(l => l.startsWith('[res] '));
      if(res) status('Video ' + res.slice(6).trim() + ' — downloading…');
      const prog = lines.find(l => /\[download\]\s+[\d.]+%/.test(l));
      if(prog) status(prog.replace('[download]', 'Downloading').trim());
    });
    proc.stderr.on('data', d => { errTxt += d.toString(); });
    proc.on('error', err => resolve({error: err.message}));
    proc.on('close', async code => {
      if(code !== 0){ status(''); resolve({error: 'yt-dlp failed: ' + errTxt.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400)}); return; }
      const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      let file = null;
      for(let i = lines.length - 1; i >= 0; i--){ if(fssync.existsSync(lines[i])){ file = lines[i]; break; } }
      // fallback: --print filepath může u některých verzí selhat → vzít nejnovější reálný soubor ve složce
      if(!file){
        try {
          const now = Date.now();
          const cands = (await fs.readdir(outDir))
            .filter(n => !/\.(part|ytdl|temp)$/i.test(n))
            .map(n => { const fp = path.join(outDir, n); let mt = 0; try { mt = fssync.statSync(fp).mtimeMs; } catch(e){} return {fp, mt}; })
            .filter(x => x.mt && (now - x.mt) < 5 * 60 * 1000)   // stažené během posledních 5 min
            .sort((a, b) => b.mt - a.mt);
          if(cands.length) file = cands[0].fp;
        } catch(err){}
      }
      if(!file){ status(''); resolve({error: 'Could not locate the downloaded file'}); return; }
      // DASH stopa (1080p) je fragmentovaná — přebalit na progresivní mp4, jinak ji hra nepřehraje
      if(isVideo && ff){
        status('Repacking video for the game…');
        const r = await remuxProgressive(file, ff);
        if(r.ok) file = r.file;
        else console.warn('[video] remux selhal, nechávám původní soubor:', r.err);
      }
      try {
        status('Decoding…');
        resolve({name: path.basename(file), path: file, data: await fs.readFile(file)});
      } catch(err){ resolve({error: err.message}); }
    });
  });
});

ipcMain.handle('audio:openDialog', async () => {
  const r = await dialog.showOpenDialog(win, {filters: AUDIO_FILTERS, properties: ['openFile']});
  if(r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  try { const data = await fs.readFile(p); return {path: p, name: path.basename(p), data}; }
  catch(err){ return {error: 'Could not read the audio file: ' + err.message}; }
});

// ---------- Menu ----------
function sendMenu(action){ if(win) win.webContents.send('menu', action); }

// ---------- Naposledy otevřené soubory ----------
// Seznam žije v userData (přežije aktualizaci) a plní ho renderer po každém úspěšném
// otevření/uložení. Neexistující cesty se při stavbě menu tiše vyhodí.
const RECENT_MAX = 10;
function recentPath(){ return path.join(app.getPath('userData'), 'recent.json'); }
function loadRecent(){
  try { const a = JSON.parse(fssync.readFileSync(recentPath(), 'utf8')); return Array.isArray(a) ? a : []; }
  catch(e){ return []; }
}
function saveRecent(list){ try { fssync.writeFileSync(recentPath(), JSON.stringify(list)); } catch(e){} }
function addRecent(p){
  if(!p) return;
  const list = loadRecent().filter(x => x.toLowerCase() !== String(p).toLowerCase());
  list.unshift(p);
  saveRecent(list.slice(0, RECENT_MAX));
  buildMenu();                                   // menu se musí přestavět, jinak drží starý seznam
}
function recentSubmenu(){
  const list = loadRecent().filter(p => { try { return fssync.existsSync(p); } catch(e){ return false; } });
  if(!list.length) return [{label: 'No recent files', enabled: false}];
  return [
    ...list.map(p => ({label: path.basename(p), sublabel: p, toolTip: p, click: () => sendMenu('recent:' + p)})),
    {type: 'separator'},
    {label: 'Clear list', click: () => { saveRecent([]); buildMenu(); }},
  ];
}
ipcMain.handle('recent:add', (e, p) => { addRecent(p); return true; });
// Vlastní (HTML) lišta menu si seznam kreslí sama — potřebuje ho tedy vyčíst.
ipcMain.handle('recent:list', () => loadRecent()
  .filter(p => { try { return fssync.existsSync(p); } catch(e){ return false; } })
  .map(p => ({path: p, name: path.basename(p)})));
ipcMain.handle('recent:clear', () => { saveRecent([]); buildMenu(); return true; });
ipcMain.on('app:quit', () => { if(win && !win.isDestroyed()) win.close(); });   // projde i kontrolou neuložených změn
ipcMain.on('app:devtools', () => { if(win && !win.isDestroyed()) win.webContents.toggleDevTools(); });
ipcMain.on('app:reload', () => { if(win && !win.isDestroyed()) win.webContents.reload(); });
function sendPanel(id, visible){ if(win) win.webContents.send('panel:toggle', id, visible); }

// panely v sidebaru (Window menu je zapíná/vypíná jako v Photoshopu)
const PANELS = [
  {id:'notebank',  label:'Selected note'},
  {id:'selection', label:'Selection'},
  {id:'diffs',     label:'Difficulties'},
  {id:'tempo',     label:'Tempo & meter'},
  {id:'flags',     label:'Markers'},
  {id:'charting',  label:'Chart tools'},
];
// Poslední známé stavy panelů. Menu se přestavuje při každém uložení/otevření (kvůli Open recent)
// a šablona měla `checked: true` napevno — po Ctrl+S se tedy skryté panely tvářily jako zapnuté
// a další kliknutí je skrylo znovu místo zobrazení. Držíme si je proto tady.
const panelState = {};
function applyPanelChecks(){
  const menu = Menu.getApplicationMenu(); if(!menu) return;
  for(const id of Object.keys(panelState)){
    const mi = menu.getMenuItemById('panel-' + id);
    if(mi) mi.checked = !!panelState[id];
  }
}
// renderer po startu pošle skutečné stavy (z localStorage) → srovnat zaškrtnutí
ipcMain.handle('panel:states', (e, states) => {
  if(!states) return true;
  for(const id of Object.keys(states)) panelState[id] = !!states[id];
  applyPanelChecks();
  return true;
});

function buildMenu(){
  // macOS má pevnou strukturu první položky (jmenuje se jako aplikace) — About/Preferences/
  // Hide/Quit patří tam, nikam jinam. V File menu proto na Macu Quit nedáváme; systém by ji
  // duplikoval do Cmd+Q na dvou místech.
  const appMenu = IS_MAC ? [{
    label: 'ChartStudio',
    submenu: [
      {role: 'about'},
      {type: 'separator'},
      {role: 'services'},
      {type: 'separator'},
      {role: 'hide'},
      {role: 'hideOthers'},
      {role: 'unhide'},
      {type: 'separator'},
      {role: 'quit'},
    ],
  }] : [];

  const fileSubmenu = [
    {label: 'New chart', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new')},
    {label: 'Open project or chart…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open')},
    {label: 'Open song folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenu('openfolder')},
    {label: 'Open recent', submenu: recentSubmenu()},
    {label: 'Load audio…', accelerator: 'CmdOrCtrl+L', click: () => sendMenu('audio')},
    {type: 'separator'},
    {label: 'Save project', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save')},
    {label: 'Save project As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('saveas')},
    {label: 'Save chart as .chart…', click: () => sendMenu('savechart')},
    {label: 'Export for Clone Hero…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export')},
    {label: 'Export as .sng…', click: () => sendMenu('exportsng')},
    {label: 'Export as .mid…', click: () => sendMenu('exportmid')},
  ];
  if(!IS_MAC){ fileSubmenu.push({type: 'separator'}, {role: 'quit'}); }

  const template = [
    ...appMenu,
    {
      label: 'File',
      submenu: fileSubmenu,
    },
    {
      label: 'Edit',
      submenu: [
        {label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo')},
        {label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => sendMenu('redo')},
      ],
    },
    {
      label: 'View',
      submenu: [
        {label: 'Cycle view 2D / 3D / Split (V)', click: () => sendMenu('view3d')},
        {type: 'separator'},
        {label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => sendMenu('zoomin')},
        {label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => sendMenu('zoomout')},
        {type: 'separator'},
        {role: 'toggleDevTools'},
        {role: 'reload'},
      ],
    },
    {
      label: 'Window',
      submenu: [
        {label: 'Panels', enabled: false},
        {type: 'separator'},
        ...PANELS.map(p => ({
          id: 'panel-' + p.id, label: p.label, type: 'checkbox',
          checked: panelState[p.id] !== false,
          click: (mi) => { panelState[p.id] = mi.checked; sendPanel(p.id, mi.checked); },
        })),
        {type: 'separator'},
        {label: 'Show all panels', click: () => sendMenu('panels-show-all')},
        {label: 'Reset panel layout', click: () => sendMenu('panels-reset')},
      ],
    },
    // samostatná klikací položka přímo v liště (bez podmenu) — otevře okno zkratek/keybindů
    {label: 'Keybinds', accelerator: 'F1', click: () => sendMenu('help')},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  applyPanelChecks();   // přestavba nesmí zahodit, co uživatel v Window menu navolil
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

// Na macOS je zvykem, že aplikace po zavření posledního okna žije dál v Docku (uživatel ji
// opustí přes ⌘Q nebo z menu ChartStudio → Quit). Na Windows/Linuxu se zavřením okna aplikace
// končí — tady jsme okno = aplikace, jiné okno neexistuje.
app.on('window-all-closed', () => { if(!IS_MAC) app.quit(); });

// Klasické macOS „activate": kliknutí na dockovou ikonu, když už žádné okno neběží, ho otevře
// znovu. Bez tohohle by po zavření okna appka jen tiše seděla v Docku a nešla by znovu spustit.
app.on('activate', () => { if(!SMOKE && BrowserWindow.getAllWindows().length === 0) createWindow(); });
