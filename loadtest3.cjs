const { app, BrowserWindow } = require('electron');
app.on('ready', async () => {
  const path = require('node:path');
  const asarRoot = process.env.SYNQ_ASAR;
  const fs = require('node:fs');
  const target = path.join(asarRoot, 'dist/index.html');
  const url = require('node:url').pathToFileURL(target).href;
  const preload = path.join(asarRoot, 'electron', 'preload.cjs');
  const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
  let done = false;
  w.webContents.on('did-fail-load', (_e, code, desc, u) => { done = true; console.log('DID-FAIL-LOAD', code, desc, u); app.exit(7); });
  w.webContents.on('did-finish-load', async () => {
    done = true;
    console.log('TITLE=', await w.webContents.executeJavaScript('document.title').catch(e => 'ERR ' + e.message));
    console.log('BODYLEN=', await w.webContents.executeJavaScript('document.body?document.body.innerHTML.length:-1').catch(e => 'ERR ' + e.message));
    console.log('HAS_SYNQ=', await w.webContents.executeJavaScript('typeof window.synq').catch(e => 'ERR ' + e.message));
    console.log('ROOT_CHILDREN=', await w.webContents.executeJavaScript('document.getElementById("root") ? document.getElementById("root").childElementCount : -1').catch(e => 'ERR ' + e.message));
    app.exit(0);
  });
  w.webContents.on('preload-error', (_e, p, err) => console.log('PRELOAD-ERROR', p, err && err.message));
  w.webContents.on('render-process-gone', (_e, d) => console.log('RENDER-GONE', d.reason));
  try { await w.loadURL(url); } catch (err) { console.log('LOADURL_REJECT', err.message); if (!done) app.exit(5); }
  setTimeout(() => { if (!done) { console.log('TIMEOUT'); app.exit(8); } }, 10000);
});
