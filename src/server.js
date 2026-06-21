const app = require('./app');
const config = require('../config');
const cacheClient = require('./cache/cacheClient');
const batchWriter = require('./services/batchWriter');

app.listen(config.PORT, async () => {
  console.log(`Typeahead server listening at http://localhost:${config.PORT}`);

  // Phase 6: write-behind batch writer ka timer chalu.
  batchWriter.start();
  console.log(`[batch] write-behind started (size=${config.BATCH_SIZE}, interval=${config.FLUSH_INTERVAL_MS}ms)`);

  // Phase 4: startup pe ring distribution log -> vnodes se even spread visible ho (NFR evidence).
  cacheClient.logRingDistribution();

  // Redis nodes connectivity (cache down ho to bhi server chalega — graceful degradation).
  const pings = await cacheClient.pingAll();
  console.log('[cache] redis nodes:', pings);
});

// GRACEFUL SHUTDOWN: clean stop pe buffer flush kar do — clean stop pe kuch nahi khota; sirf hard
// crash (kill -9 / power loss) pe last un-flushed batch ka increment khota hai.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[batch] ${signal} received — flushing buffer before exit ...`);
  batchWriter.stop();
  try {
    const summary = await batchWriter.flush();
    console.log('[batch] final flush:', summary);
  } catch (err) {
    console.error('[batch] final flush failed:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
