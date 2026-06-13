const fs = require('fs');
const file = 'agent/src/researcher.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  "const MODEL_ID = 'deepseek/deepseek-v3';",
  "const MODEL_ID = 'google/gemma-4-26b-a4b-it';"
);

code = code.replace(
  "MAX_SCRAPE_BATCHES: 4,",
  "MAX_SCRAPE_BATCHES: 2,\n      MAX_FAILED_RESEARCHERS: 1,"
);

fs.writeFileSync(file, code);
