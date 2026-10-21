// `npm run migrate`: applies any new files in migrations/ to the database, once each, in name order.
// The server does the same at startup, so this is for when you want to run a migration without starting the service.
// Stop the server first: only one process may open the database folder.
import { openDb } from '../src/db.js';

try {
  const { applied, close } = await openDb();
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply: the database is up to date');
  await close();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
