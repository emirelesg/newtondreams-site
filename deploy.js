require('dotenv').config();
const chalk = require('chalk');
const jsftp = require('jsftp');
const path = require('path');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const md5 = require('md5');

let ignore = [];
if (fs.existsSync('.ftp-ignore')) {
  const data = fs.readFileSync('.ftp-ignore', 'utf-8');
  ignore = data.split('\n').map(p => path.normalize(p));
}

class HashMap {
  constructor() {
    this.file = 'hashes.json';
    this.hashes = this.loadHashes(this.file);
    this.sums = {};
  }
  loadHashes() {
    if (fs.existsSync(this.file)) {
      const data = fs.readFileSync(this.file, 'utf-8');
      return JSON.parse(data);
    }
    return {};
  }
  md5(file) {
    if (this.sums[file]) return this.sums[file];
    this.sums[file] = md5(fs.readFileSync(file));
    return this.sums[file];
  }
  compareHash(file) {
    const hash = this.md5(file);
    return this.hashes[file] && this.hashes[file] === hash;
  }
  addHash(file) {
    this.hashes[file] = this.md5(file);
  }
  saveHashes() {
    console.log(chalk`Saving hash map to {bold ${this.file}}`);
    const data = `${JSON.stringify(this.hashes, null, 2)}\n`;
    fs.writeFileSync(this.file, data, {
      encoding: 'utf-8'
    });
  }
}
const hash = new HashMap();

const DRY_RUN = argv['dry-run'] || false;
if (DRY_RUN) {
  console.log(chalk`{red *DRY RUN* }`);
}

const localBaseDir = path.normalize(process.env.FTP_LOCAL_DIR);
const remoteBaseDir = path.normalize(process.env.FTP_REMOTE_DIR);

const ftp = new jsftp({
  host: process.env.FTP_HOST,
  port: process.env.FTP_PORT,
  user: process.env.FTP_USERNAME,
  pass: process.env.FTP_PASSWORD
});

const accept = p => ignore.indexOf(p) < 0;

function lsLocal(dir) {
  return fs.readdirSync(dir).reduce(
    (a, file) => {
      const fullPath = path.join(dir, file);
      if (accept(localToRemote(fullPath))) {
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

function ls(dir) {
  return new Promise((resolve, reject) => {
    ftp.ls(dir, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          dir,
          files: res
            .filter(t => t.type === 0)
            .map(t => path.join(dir, t.name))
            .filter(accept),
          dirs: res
            .filter(t => t.type === 1)
            .map(t => path.join(dir, t.name))
            .filter(accept)
        });
      }
    });
  });
}

function raw(command, args) {
  return new Promise((resolve, reject) => {
    ftp.raw(command, args, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    });
  });
}

function upload(local, remote, isInRemote) {
  if (hash.compareHash(local)) {
    console.log(chalk`{grey Skipping ${local} -> ${localToRemote(remote)}}`);
    return true;
  } else {
    if (isInRemote) {
      console.log(chalk`{blue Uploading ${local} -> ${localToRemote(remote)}}`);
    } else {
      console.log(
        chalk`{green Uploading ${local} -> ${localToRemote(remote)}}`
      );
    }
  }
  if (DRY_RUN) return true;
  return new Promise((resolve, reject) => {
    fs.readFile(local, (err, data) => {
      if (err) {
        reject(err);
      } else {
        ftp.put(data, remote, err => {
          if (err) {
            reject(err);
          } else {
            hash.addHash(local);
            resolve(true);
          }
        });
      }
    });
  });
}

function rm(remote) {
  console.log(chalk`{red Removing ${remote}}`);
  if (DRY_RUN) return true;
  return new Promise((resolve, reject) => {
    raw('dele', remote)
      .then(() => resolve(remote))
      .catch(err => reject(err));
  });
}

function rmdir(remote) {
  console.log(chalk`{yellow Removing ${remote}}`);
  if (DRY_RUN) return true;
  return new Promise((resolve, reject) => {
    raw('rmd', remote)
      .then(() => resolve(remote))
      .catch(err => reject(err));
  });
}

async function rmdirFull(remote) {
  const { files, dirs } = await ls(remote);

  // Delete all files inside folder.
  await files.reduce(
    (lastPromise, file) =>
      lastPromise.then(() => {
        return rm(file);
      }),
    Promise.resolve()
  );

  // For each dir call the rmdirFull function to remote all files inside.
  await dirs.reduce(
    (lastPromise, dir) =>
      lastPromise.then(() => {
        return rmdirFull(dir);
      }),
    Promise.resolve()
  );

  // Since remote does not have more files/dirs it can be removed.
  return rmdir(remote);
}

function mkdir(remote) {
  console.log(chalk`{green Making ${remote}}`);
  if (DRY_RUN) return true;
  return new Promise((resolve, reject) => {
    raw('mkd', remote)
      .then(() => resolve(remote))
      .catch(err => reject(err));
  });
}

function mkdirFull(remote) {
  return remote.split(path.sep).reduce(
    (lastPromise, subdir) =>
      lastPromise
        .then(currentDir => ls(currentDir))
        .then(({ dir, dirs }) => {
          const completePath = path.join(dir, subdir);
          if (dirs.indexOf(subdir) === -1) {
            return mkdir(completePath);
          }
          return completePath;
        }),
    Promise.resolve('.')
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
  const remote = await ls(remotePath);

  // Upload local files to remote.
  await local.files.reduce(
    (lastPromise, file) =>
      lastPromise.then(() => {
        return upload(
          file,
          localToRemote(file),
          remote.files.indexOf(localToRemote(file)) > -1
        );
      }),
    Promise.resolve()
  );

  // Remove remote files that are not found in local.
  await remote.files.reduce(
    (lastPromise, file) =>
      lastPromise.then(() => {
        if (local.files.indexOf(remoteToLocal(file)) === -1) {
          return rm(file);
        }
      }),
    Promise.resolve()
  );

  // Remove remote dirs that are not found in local.
  await remote.dirs.reduce(
    (lastPromise, dir) =>
      lastPromise.then(() => {
        if (local.dirs.indexOf(remoteToLocal(dir)) === -1) {
          return rmdirFull(dir);
        }
      }),
    Promise.resolve()
  );

  // Iterate through all dirs.
  await local.dirs.reduce(
    (lastPromise, dir) =>
      lastPromise
        // Make local dir if it does not exist.
        .then(() => {
          if (remote.dirs.indexOf(localToRemote(dir)) < 0) {
            return mkdir(localToRemote(dir));
          }
        })
        // Sync local subdir.
        .then(() => sync(dir.replace(localBaseDir + '/', ''))),
    Promise.resolve()
  );
}

(async () => {
  if (remoteBaseDir !== '.') {
    await mkdirFull(remoteBaseDir);
  }
  await sync('');
  await raw('quit');

  hash.saveHashes();
})().catch(err => {
  console.error(err);
});
