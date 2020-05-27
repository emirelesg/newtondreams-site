require('dotenv').config();
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const FileHashMap = require('./hash');
const Ftp = require('./ftp');

const ftpp = new Ftp(
  {
    host: process.env.FTP_HOST,
    port: process.env.FTP_PORT,
    user: process.env.FTP_USERNAME,
    pass: process.env.FTP_PASSWORD
  },
  argv['dry-run'] || false
);

const hash = new FileHashMap();
const localBaseDir = path.normalize(process.env.FTP_LOCAL_DIR);
const remoteBaseDir = path.normalize(process.env.FTP_REMOTE_DIR);

function lsLocal(dir) {
  return fs.readdirSync(dir).reduce(
    (a, file) => {
      const fullPath = path.join(dir, file);
      if (ftpp.filter(localToRemote(fullPath))) {
        if (fs.lstatSync(fullPath).isDirectory()) {
          a.dirs.push(fullPath);
        } else {
          a.files.push(fullPath);
        }
      }
      return a;
    },
    { dir, files: [], dirs: [] }
  );
}

function localToRemote(local) {
  const samePath = local.replace(localBaseDir + '/', '');
  return path.join(remoteBaseDir, samePath);
}

function remoteToLocal(remote) {
  const samePath = remote.replace(remoteBaseDir + '/', '');
  return path.join(localBaseDir, samePath);
}

async function sync(subdir) {
  console.log(chalk`Subdir: {bold ${subdir}}`);

  const localPath = path.join(localBaseDir, subdir);
  const remotePath = path.join(remoteBaseDir, subdir);
  const local = lsLocal(localPath);
  const remote = await ftpp.ls(remotePath);

  // Upload local files to remote.
  await local.files.reduce(
    (lastPromise, file) =>
      lastPromise.then(() => {
        const fileRemote = localToRemote(file);
        if (hash.compare(file)) {
          console.log(chalk`{grey Skipping ${file} -> ${fileRemote}}`);
          return true;
        }
        hash.add(local);
        if (remote.files.indexOf(fileRemote) > -1) {
          console.log(chalk`{blue Uploading ${file} -> ${fileRemote}}`);
        } else {
          console.log(chalk`{green Uploading ${file} -> ${fileRemote}}`);
        }
        return ftpp.putBuffer(fs.readFileSync(local), remote);
      }),
    Promise.resolve()
  );

  // Remove remote files that are not found in local.
  await remote.files.reduce(
    (lastPromise, file) =>
      lastPromise.then(() => {
        if (local.files.indexOf(remoteToLocal(file)) === -1) {
          hash.remove(remoteToLocal(file));
          return ftpp.rm(file);
        }
      }),
    Promise.resolve()
  );

  // Remove remote dirs that are not found in local.
  await remote.dirs.reduce(
    (lastPromise, dir) =>
      lastPromise.then(() => {
        if (local.dirs.indexOf(remoteToLocal(dir)) === -1) {
          return ftpp.rmdirRecursive(dir);
        }
      }),
    Promise.resolve()
  );

  // Iterate through all dirs and sync them
  await local.dirs.reduce(
    (lastPromise, dir) =>
      lastPromise
        // Make local subdir in remote if it does not exist.
        .then(() => {
          if (remote.dirs.indexOf(localToRemote(dir)) === -1) {
            return ftpp.mkdir(localToRemote(dir));
          }
        })
        // Sync local subdir.
        .then(() => sync(dir.replace(localBaseDir + '/', ''))),
    Promise.resolve()
  );
}

(async () => {
  // Load hashes from the ftp server.
  hash.hashes = await ftpp.getJSON(path.join(remoteBaseDir, '.hashes'));

  // Make base dir in ftp server.
  if (remoteBaseDir !== '.') await ftpp.mkdirFull(remoteBaseDir);

  // Sync local and remote dirs.
  await sync('');

  // Upload the updated hashes to the server.
  await ftpp.putJSON(hash.hashes, path.join(remoteBaseDir, '.hashes'));
})()
  .catch(err => console.error(err))
  .finally(() => ftpp.quit());
