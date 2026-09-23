// @ts-check
// Aster controller — GET /api/backup: builds the archive (including secrets.env) and streams it out,
// storing nothing on the appliance. bin/backup.js writes the same archive into backups/.
import { createArchive } from '../../backup.js';

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {import('../server.js').Ctx} ctx
 */
export function backupRoutes(app, ctx) {
  app.get('/api/backup', async (request, reply) => {
    /** @type {Awaited<ReturnType<typeof createArchive>>} */
    let archive;
    try {
      archive = await createArchive({ home: ctx.paths.home, db: ctx.db, log: ctx.log });
    } catch (err) {
      ctx.log.error('the backup archive could not be started', { err });
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
    ctx.log.info('backup download started', { name: archive.name, members: archive.members, missing: archive.missing });
    archive.done.then(
      () => ctx.log.info('backup download finished', { name: archive.name }),
      (err) => {
        ctx.log.error('the backup archive failed while it was being sent', { name: archive.name, err });
        archive.stream.destroy(err instanceof Error ? err : new Error(String(err)));
      },
    );
    // A client that goes away mid-download leaves tar writing into a closed pipe: kill it and drop the temporary copy.
    request.raw.once('close', () => {
      if (!reply.raw.writableEnded) archive.cancel();
    });
    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${archive.name}"`)
      .header('cache-control', 'no-store')
      .header('x-aster-backup-members', archive.members.join(','))
      .send(archive.stream);
  });
}
