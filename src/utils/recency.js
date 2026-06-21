const config = require('../../config');

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// lazy decay — koi cron nahi; jab bhi chhuo tab tak ka decay laga do, phir +1. Isse short spike
// apne aap thanda ho jata hai (permanent over-ranking nahi hoti).
//   decayed(now) = trend_score * 0.5 ^ ((now - trend_ts) / HALF_LIFE)
function decay(trendScore, trendTs, now = nowSeconds(), halfLife = config.HALF_LIFE_SECONDS) {
  if (!trendScore || !trendTs) return 0;
  const value = trendScore * Math.pow(0.5, (now - trendTs) / halfLife);
  // itna chhota ho gaya toh effectively trending nahi raha (prune COULD ho — abhi 0 treat).
  return value < 1e-6 ? 0 : value;
}

module.exports = { nowSeconds, decay };
