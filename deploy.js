require('dotenv').config();
const jsftp = require("jsftp");
const path = require('path');
const fs = require('fs');

const localBaseDir = 'src';
const remoteBaseDir = '.';

// const localBaseDir = '../../covid19-mx/dist';
// const remoteBaseDir = 'covid19';

const ignoreRemote = [
  'js/core',
  'js/core_3d',
  'covid19',
  'mandelbrot',
  '.well-known',
  'fisica/_template',
  'divyx/protected/descargas_divyx_sistema_anterior.csv',
  'divyx/protected/log.csv',
  '.ftpquota'
];
 
const ftp = new jsftp({
  host: process.env.FTP_HOST,
  port: process.env.FTP_PORT,
  user: process.env.FTP_USERNAME,
  pass: process.env.FTP_PASSWORD
});

const accept = p => ignoreRemote.indexOf(p) < 0;

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
    { files: [], dirs: [] }
  );
}

async function ls(dir) {
  return new Promise((resolve, reject) => {
    ftp.ls((dir), (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          files: res.filter(t => t.type === 0).map(t => path.join(dir, t.name)).filter(accept),
          dirs: res.filter(t => t.type === 1).map(t => path.join(dir, t.name)).filter(accept),
        });
      }
    })
  })
}

async function raw(command) {
  return new Promise((resolve, reject) => {
    ftp.raw(command, (err, res) => {
      if (err) {
        reject(err);
      } else {
        resolve(res);
      }
    })
  })
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

  const indent = Array(subdir.split(path.sep).length - 1).fill('\t').join('');
  console.log(`${indent}Checking subdir: ${subdir}`)


  const localPath = path.join(localBaseDir, subdir);
  const remotePath = path.join(remoteBaseDir, subdir);

  const local = lsLocal(localPath);
  const remote = await ls(remotePath);

  local.files.forEach(file => {
    console.log(`${indent}Uploading ${file} -> ${localToRemote(file)} | ${remote.files.indexOf(localToRemote(file)) > -1}`)
  });

  local.dirs.forEach(dir => {
    if (remote.dirs.indexOf(localToRemote(dir)) < 0) {
      console.log(`${indent}Making remote ${dir} -> ${localToRemote(dir)}`);
    }
  });

  remote.files.forEach(file => {
    if (local.files.indexOf(remoteToLocal(file)) < 0) {
      console.log(`${indent}Removing ${file} -> ${remoteToLocal(file)}`)
    }
  })

  await local.dirs.reduce((lastPromise, dir) => {
    return lastPromise.then(() => {
      if (remote.dirs.indexOf(localToRemote(dir)) < 0) {
        console.log(`${indent}Making remote ${dir} -> ${localToRemote(dir)}`);
      }
    }).then(() => sync(dir.replace(localBaseDir + '/', '')))
  }, Promise.resolve())

  // console.log(local);
  // console.log(remote);

}

(async () => {

  await sync('')
  await raw('quit');

})().catch(err => {
  console.error(err);
});
