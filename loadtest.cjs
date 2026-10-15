// Load the PACKAGED asar the way main.cjs does, from dev electron with asar fs support enabled.
const { app, BrowserWindow } = require('electron');
const asarInit = require('electron').defaultApp === undefined;
app.on('ready', async () => {
  const path = require('node:path');
  const asarRoot = process.env.SYNQ_ASAR || path.resolve('dist/win-unpacked/resources/app.asar');
  process.noAsar = false;
  require('module')._extensions['.asar']; // noop
  const { addAsarToLookupPaths } = require(path.join(asarRoot, 'noop-missing'));
  app.exit(1);
});
