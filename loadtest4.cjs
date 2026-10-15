const { app, BrowserWindow } = require('electron');
app.on('ready', async () => {
  const path = require('node:path');
  const asarRoot = process.env.SYNQ_ASAR;
  const target = path.join(asarRoot, 'dist/index.html');
  const url = require('node:url').pathToFileURL(target).href;
  const preload = path.join(asarRoot, 'electron', 'preload.cjs');
  const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const logs = [];
  w.webContents.on('console-message', (_e, level, message, line, src) => { logs.push(level + ': ' + message + ' @ ' + (src||'') + ':' + line); });
  w.webContents.on('render-process-gone', (_e, d) => console.log('RENDER-GONE', d.reason));
  await w.loadURL(url);
  // wait for React to mount
  await new Promise(r => setTimeout(r, 6000));
  const state = await w.webContents.executeJavaScript(`({
    rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    bodyText: document.body?.innerText?.slice(0, 300) ?? '',
    hasSynq: typeof window.synq,
  })`).catch(e => ({ err: e.message }));
  console.log('STATE=', JSON.stringify(state, null, 1));
  console.log('--- console messages ---');
  logs.slice(0, 30).forEach(l => console.log(l));
  app.exit(0);
});
