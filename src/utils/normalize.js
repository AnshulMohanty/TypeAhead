// read aur write same normalization use karein warna likha hua query baad me prefix-match me nahi milega.
function normalizeQuery(input) {
  // Null/undefined/non-string -> "" (caller gracefully empty handle karega).
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase();
}

module.exports = { normalizeQuery };
