import * as constants from '../../shared/constants'
import * as fs from 'mz/fs'
import * as path from 'path'
import * as settings from '../settings'
import * as pgModels from '../../shared/models/pg'
import { addTags, TracingContext } from '../../shared/tracing'
import { Connection, EntityManager } from 'typeorm'
import { convertLsif } from './importer'
import { createSilentLogger } from '../../shared/logging'
import { dbFilename } from '../../shared/paths'
import { withLock } from '../../shared/store/locks'
import { DumpManager } from '../../shared/store/dumps'
import { DependencyManager } from '../../shared/store/dependencies'

/**
 * Create a function that takes a repository, commit, and filename containing the gzipped
 * input of an LSIF dump and converts it to a SQLite database. This will also populate
 * Postgres with the dependency data from this dump.
 *
 * @param entityManager The EntityManager to use as part of a transaction.
 * @param dumpManager The dumps manager instance.
 * @param dependencyManager The dependency manager instance.
 * @param fetchConfiguration A function that returns the current configuration.
 */
export const convertUpload = async (
    entityManager: EntityManager,
    dumpManager: DumpManager,
    dependencyManager: DependencyManager,
    fetchConfiguration: () => { gitServers: string[] },
    upload: pgModels.LsifUpload,
    ctx: TracingContext
): Promise<void> => {
    const { logger = createSilentLogger(), span } = addTags(ctx, {
        repository: upload.repository,
        commit: upload.commit,
        root: upload.root,
    })

    await convertDatabase(entityManager, dumpManager, dependencyManager, upload, ctx)
    await updateCommitsAndDumpsVisibleFromTip(dumpManager, fetchConfiguration, upload, { logger, span })
    await purgeOldDumps(
        entityManager.connection,
        dumpManager,
        settings.STORAGE_ROOT,
        settings.DBS_DIR_MAXIMUM_SIZE_BYTES,
        ctx
    )
}

/**
 * Convert the LSIF dump input into a SQLite database, create an LSIF dump record
 * and populate the dependency tables with packages and reference data.
 *
 * @param entityManager The EntityManager to use as part of a transaction.
 * @param dumpManager The dumps manager instance.
 * @param dependencyManager The dependency manager instance.
 * @param upload THe unprocessed upload record.
 * @param ctx The tracing context.
 */
async function convertDatabase(
    entityManager: EntityManager,
    dumpManager: DumpManager,
    dependencyManager: DependencyManager,
    upload: pgModels.LsifUpload,
    { logger = createSilentLogger(), span }: TracingContext
): Promise<void> {
    const tempFile = path.join(settings.STORAGE_ROOT, constants.TEMP_DIR, path.basename(upload.filename))

    try {
        // Create database in a temp path
        const { packages, references } = await convertLsif(upload.filename, tempFile, { logger, span })

        // Remove overlapping dumps that will cause a unique index error once this upload has
        // transitioned into the completed state.
        await dumpManager.deleteOverlappingDumps(upload.repository, upload.commit, upload.root, { logger, span })

        // Insert dump and add packages and references to Postgres
        await dependencyManager.addPackagesAndReferences(
            upload.id,
            packages,
            references,
            { logger, span },
            entityManager
        )

        // Move the temp file where it can be found by the server
        await fs.rename(tempFile, dbFilename(settings.STORAGE_ROOT, upload.id, upload.repository, upload.commit))

        logger.info('Created dump', {
            repository: upload.repository,
            commit: upload.commit,
            root: upload.root,
        })
    } catch (error) {
        // Don't leave busted artifacts
        await fs.unlink(tempFile)
        throw error
    }

    await fs.unlink(upload.filename)
}

/**
 * Update the commits for this repo, and update the visible_at_tip flag on the dumps
 * of this repository. This will query for commits starting from both the current tip
 * of the repo and from the commit that was just processed.
 *
 * @param dumpManager The dumps manager instance.
 * @param fetchConfiguration A function that returns the current configuration.
 * @param upload The processed upload record.
 * @param ctx The tracing context.
 */
async function updateCommitsAndDumpsVisibleFromTip(
    dumpManager: DumpManager,
    fetchConfiguration: () => { gitServers: string[] },
    upload: pgModels.LsifUpload,
    ctx: TracingContext
): Promise<void> {
    const gitserverUrls = fetchConfiguration().gitServers

    const tipCommit = await dumpManager.discoverTip({ repository: upload.repository, gitserverUrls, ctx })
    if (tipCommit === undefined) {
        throw new Error('No tip commit available for repository')
    }

    const commits = await dumpManager.discoverCommits({
        repository: upload.repository,
        commit: upload.commit,
        gitserverUrls,
        ctx,
    })

    if (tipCommit !== upload.commit) {
        // If the tip is ahead of this commit, we also want to discover all of
        // the commits between this commit and the tip so that we can accurately
        // determine what is visible from the tip. If we do not do this before the
        // updateDumpsVisibleFromTip call below, no dumps will be reachable from
        // the tip and all dumps will be invisible.

        const tipCommits = await dumpManager.discoverCommits({
            repository: upload.repository,
            commit: tipCommit,
            gitserverUrls,
            ctx,
        })

        for (const [k, v] of tipCommits.entries()) {
            commits.set(
                k,
                new Set<string>([...(commits.get(k) || []), ...v])
            )
        }
    }

    await dumpManager.updateCommits(upload.repository, commits, ctx)
    await dumpManager.updateDumpsVisibleFromTip(upload.repository, tipCommit, ctx)
}

/**
 * Remove dumps until the space occupied by the dbs directory is below
 * the given limit.
 *
 * @param connection The Postgres connection.
 * @param dumpManager The dumps manager instance.
 * @param storageRoot The path where SQLite databases are stored.
 * @param maximumSizeBytes The maximum number of bytes.
 * @param ctx The tracing context.
 */
function purgeOldDumps(
    connection: Connection,
    dumpManager: DumpManager,
    storageRoot: string,
    maximumSizeBytes: number,
    { logger = createSilentLogger() }: TracingContext = {}
): Promise<void> {
    if (maximumSizeBytes < 0) {
        return Promise.resolve()
    }

    const purge = async (): Promise<void> => {
        let currentSizeBytes = await dirsize(path.join(storageRoot, constants.DBS_DIR))

        while (currentSizeBytes > maximumSizeBytes) {
            // While our current data usage is too big, find candidate dumps to delete
            const dump = await dumpManager.getOldestPrunableDump()
            if (!dump) {
                logger.warn(
                    'Unable to reduce disk usage of the DB directory because deleting any single dump would drop in-use code intel for a repository.',
                    { currentSizeBytes, softMaximumSizeBytes: maximumSizeBytes }
                )

                break
            }

            logger.info('Pruning dump', {
                repository: dump.repository,
                commit: dump.commit,
                root: dump.root,
            })

            // Delete this dump and subtract its size from the current dir size
            const filename = dbFilename(storageRoot, dump.id, dump.repository, dump.commit)
            currentSizeBytes -= await filesize(filename)

            // This delete cascades to the packages and references tables as well
            await dumpManager.deleteDump(dump)
        }
    }

    // Ensure only one worker is doing this at the same time so that we don't
    // choose more dumps than necessary to purge. This can happen if the directory
    // size check and the selection of a purgeable dump are interleaved between
    // multiple workers.
    return withLock(connection, 'retention', purge)
}

/**
 * Calculate the size of a directory.
 *
 * @param directory The directory path.
 */
async function dirsize(directory: string): Promise<number> {
    return (
        await Promise.all((await fs.readdir(directory)).map(filename => filesize(path.join(directory, filename))))
    ).reduce((a, b) => a + b, 0)
}

/**
 * Get the file size or zero if it doesn't exist.
 *
 * @param filename The filename.
 */
async function filesize(filename: string): Promise<number> {
    try {
        return (await fs.stat(filename)).size
    } catch (error) {
        if (!(error && error.code === 'ENOENT')) {
            throw error
        }

        return 0
    }
}
