const cluster = require('cluster');
const config = require('./config');

// Node is single-threaded, so one process can't use more than one CPU core.
// CLUSTER_WORKERS defaults to 1 (identical behavior to running server.js
// directly) so this is a safe default on any host — raise it once you know
// how many cores are actually available in production.
const numWorkers = config.clusterWorkers;

if (cluster.isPrimary || cluster.isMaster) {
  console.log(`Primary ${process.pid} starting ${numWorkers} worker(s)`);
  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} exited (${signal || code}). Restarting...`);
    cluster.fork();
  });
} else {
  require('./server');
}
