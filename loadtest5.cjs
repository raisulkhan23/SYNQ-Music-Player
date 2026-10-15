const { app, BrowserWindow } = require('electron');
app.on('ready', async () => {
  const path = require('node:path');
  const asarRoot = process.env.SYNQ_ASAR;
  const target = path.join(asarRoot, 'dist/index.html');
  const url = require('node:url').pathToFileURL(target).href;
  const preload = path.join(asarRoot, 'electron', 'preload.cjs');
  const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const logs = [];
  w.webContents.on('console-message', (_e, params) => { logs.push((params.level ?? params.levelLabel) + ': ' + params.message + ' @ ' + (params.sourceId||'') + ':' + params.lineNumber); });
  w.webContents.on('render-process-gone', (_e, d) => console.log('RENDER-GONE', d.reason));
  w.session.webRequest.onBeforeRequest({}, (details, cb) => {
    logs.push('REQ ' + details.resourceType + ' ' + details.url);
    cb({});
  });
  await w.loadURL(url);
  await new Promise(r => setTimeout(r, 8000));
  const state = await w.webContents.executeJavaScript(`({
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    rootHTML: document.getElementById('root')?.innerHTML?.slice(0, 200) ?? '',
    scripts: [...document.scripts].map(s => s.src || '(inline)').slice(0, 10),
    readyState: document.readyState,
  })`).catch(e => ({ err: e.message }));
  console.log('STATE=', JSON.stringify(state, null, 1));
  console.log('--- net/console ---');
  logs.slice(0, 50).forEach(l => console.log(l));
  app.exit(0);
});
