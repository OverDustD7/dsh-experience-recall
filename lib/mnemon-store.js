// Read the local mnemon store: the authoritative "what memories exist now".
//
// Reading it directly is what makes the vocabulary current. `node:sqlite` opens
// the file read-only, so this never blocks or mutates the memory plugin's data.
import { open, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseList } from './terms.js'

export function defaultStorePaths(options = {}) {
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const root = options.mnemonDataDir || join(home, 'mnemon')
  return {
    dbPath: join(root, 'data', options.mnemonStore || 'default', 'mnemon.db'),
    documentsIndexPath: join(root, 'documents', 'index.json'),
    documentsRoot: root,
  }
}

/**
 * Body of one project document, for `##`-section fragment indexing.
 * Bounded (200 KB) so a runaway file cannot stall a reconcile.
 */
export async function readDocumentText(root, relativePath) {
  try {
    const base = await realpath(root)
    const target = await realpath(resolve(base, String(relativePath)))
    const within = relative(base, target)
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return undefined
    const file = await open(target, 'r')
    try {
      const bytes = Buffer.alloc(200000)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      return new TextDecoder().decode(bytes.subarray(0, bytesRead), { stream: bytesRead === bytes.length })
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Every live insight with its author-provided tags/entities.
 * @returns `{ rows, revision, error? }` — never throws.
 */
export async function readInsights(options = {}) {
  const dbPath = options.dbPath ?? defaultStorePaths().dbPath
  const limit = Number.isFinite(options.limit) ? options.limit : 5000
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = db
        .prepare('select id, content, category, tags, entities, updated_at, effective_importance from insights where deleted_at is null order by updated_at desc limit ?')
        .all(limit)
      const mapped = rows.map((row) => ({
        id: String(row.id),
        content: String(row.content ?? ''),
        category: String(row.category ?? ''),
        tags: parseList(row.tags),
        entities: parseList(row.entities),
        updatedAt: String(row.updated_at ?? ''),
        importance: typeof row.effective_importance === 'number' ? row.effective_importance : undefined,
      }))
      return { rows: mapped, revision: `${mapped.length}:${mapped[0]?.updatedAt ?? ''}` }
    } finally {
      db.close()
    }
  } catch (error) {
    return { rows: [], revision: '', error: String(error?.message ?? error) }
  }
}

/** Active project documents (tier 2), title + description only. */
export async function readDocuments(options = {}) {
  const indexPath = options.indexPath ?? defaultStorePaths().documentsIndexPath
  const limit = Number.isFinite(options.limit) ? options.limit : 2000
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    if (!Array.isArray(parsed?.documents)) throw new Error('invalid document index: documents must be an array')
    const documents = parsed.documents
    const rows = documents
      .filter((document) => document?.status === 'active' && typeof document.id === 'string')
      .slice(0, limit)
      .map((document) => ({
        id: String(document.id),
        title: String(document.title ?? ''),
        description: String(document.description ?? ''),
        updatedAt: String(document.updatedAt ?? ''),
        relativePath: String(document.relativePath ?? ''),
      }))
    return { rows, revision: `${rows.length}:${parsed?.revision ?? ''}` }
  } catch (error) {
    return { rows: [], revision: '', error: String(error?.message ?? error) }
  }
}

export function createStoreReader(options = {}) {
  const paths = { ...defaultStorePaths(), ...(options.paths ?? {}) }
  const limits = options.limits ?? {}
  const logger = options.logger
  function log(record) {
    try {
      logger?.write(record)
    } catch {
      // best effort by contract
    }
  }
  return {
    paths,
    async insights() {
      const result = await readInsights({ dbPath: paths.dbPath, limit: limits.insights })
      if (result.error !== undefined) log({ kind: 'store', source: 'insights', error: result.error })
      return result
    },
    async documents() {
      const result = await readDocuments({ indexPath: paths.documentsIndexPath, limit: limits.documents })
      if (result.error !== undefined) log({ kind: 'store', source: 'documents', error: result.error })
      return result
    },
    /** Bodies for the documents that carry a relativePath (tier-2 fragments). */
    async documentBodies(rows = []) {
      const bodies = new Map()
      for (const row of rows) {
        if (typeof row.relativePath !== 'string' || row.relativePath === '') continue
        const text = await readDocumentText(paths.documentsRoot, row.relativePath)
        if (text !== undefined) bodies.set(row.id, text)
      }
      return bodies
    },
  }
}
