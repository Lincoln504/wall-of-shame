const fs = require('fs');
const file = 'agent/src/researcher.ts';
let code = fs.readFileSync(file, 'utf8');

// Apply runtime configuration patches.
// Each replace targets a known pattern; if the pattern has already
// changed the replace is a no-op — that's intentional for idempotency.

code = code.replace(
  "const MODEL_ID = 'google/gemma-4-26b-a4b-it';",
  "const MODEL_ID = 'google/gemma-4-26b-a4b-it';"
);

code = code.replace(
  "MAX_SCRAPE_BATCHES: 3,",
  "MAX_SCRAPE_BATCHES: 2,"
);

fs.writeFileSync(file, code);
