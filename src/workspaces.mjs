// Workspaces: where a worker run works. A workspace has a name, a folder and
// a kind. The kind says which runner (runners.mjs) reaches its folders, on
// this computer or in a container, and which names are its own; Workers
// (workers.mjs) asks it for both, and checks before and after a run by the
// kind. So far there is one kind:
//
//   repo   a git repository directly in the worker root, on this computer or
//          in the worker container, named by its folder. One run at a time.
//          Before a run the gateway looks at uncommitted files, the origin and
//          the access level; after it, at git (Workers.audit), and what is
//          left becomes a push decision.
//
// Task records and queue entries name their workspace in `repo` and `worker`,
// as before. A task record's `kind` says which kind it is; one without, from
// an older version, is a repository.

// The kind of a task record, or of a queue entry.
export const kindOf = record => record?.kind ?? 'repo'

// The repositories in the worker root, as the runner lists them.
export class Repositories {
  constructor(runner) {
    this.kind = 'repo'
    this.runner = runner
  }

  // Folder names have no slash; the names of every other kind have one.
  owns(name) {
    return typeof name === 'string' && name !== '' && !name.includes('/')
  }

  // Throws when the worker container does not answer.
  names() {
    return this.runner.names()
  }

  dir(name) {
    return this.runner.dir(name)
  }
}
