// `npm run backfill`: generates embeddings for every intake note that does not have one yet, in batches.
// Safe to re-run: it only touches rows where embedding IS NULL. Stop the server first (one process per database folder).
import { openDb } from '../src/db.js';
import { embed, toPgVector } from '../src/lib/embed.js';

const BATCH_SIZE = 50;

const { pg, close } = await openDb();
try {
  let done = 0;
  for (;;) {
    const { rows } = await pg.query('SELECT id, note_text FROM intake_notes WHERE embedding IS NULL ORDER BY id LIMIT $1', [BATCH_SIZE]);
    if (rows.length === 0) break;
    await pg.transaction(async tx => {
      for (const row of rows) {
        await tx.query('UPDATE intake_notes SET embedding = $1::vector WHERE id = $2', [toPgVector(embed(row.note_text)), row.id]);
      }
    });
    done += rows.length;
    console.log(`embedded ${done} notes`);
  }
  // Rebuild the ivfflat index so its centroids reflect the real data, not the empty table it was created on.
  if (done > 0) await pg.exec('REINDEX INDEX intake_notes_embedding_idx');
  console.log(done ? `done: ${done} notes embedded` : 'nothing to do: every note already has an embedding');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await close();
}
