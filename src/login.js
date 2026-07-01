import { loadConfig } from './config.js';
import { refreshAuthState } from './auth.js';

async function main() {
  const config = loadConfig();
  await refreshAuthState(config);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});