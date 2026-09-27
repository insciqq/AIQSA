import type { WorkspaceConfig } from "./config";

// Project trees have a separate entry bound from generated answer outputs.
export const PROJECT_ARCHIVE_MAX_ENTRIES = 100_000;

/**
 * One bound for every runtime: capture proves these limits before a
 * continuation seed can become READY, and restore enforces the same ones, so
 * an accepted checkpoint is always restorable. Bytes count expanded regular
 * file content; entries count every archive member.
 */
export function projectArchiveLimits(config: Pick<WorkspaceConfig, "diskMiB" | "outputTotalMaxBytes">): Readonly<{
  maxBytes: number;
  maxEntries: number;
}> {
  return {
    maxBytes: Math.min(config.outputTotalMaxBytes, config.diskMiB * 1_024 * 1_024),
    maxEntries: PROJECT_ARCHIVE_MAX_ENTRIES
  };
}

/** Raw tar stream ceiling for the limits above: headers and padding included. */
export function projectArchiveTarMaxBytes(limits: Readonly<{ maxBytes: number; maxEntries: number }>): number {
  return limits.maxBytes + limits.maxEntries * 2_048 + 1_048_576;
}

/**
 * Runs inside the guest. All validation is structural; no file data leaves it.
 *
 * Arguments: archive, project, max_bytes, max_entries, mode.
 * - verify: validate structure and bounds only; nothing is written.
 * - restore: validate first (a preflight failure never touches the project),
 *   extract into sibling staging, then replace contents under a durable
 *   rollback journal. The project root stays in place: overlayfs rejects
 *   renaming lower/merged directories, including nested old directories.
 * - recover: copy back the unchanged snapshot after an interrupted replace;
 *   a committed journal preserves the new tree. Recovery is itself restartable.
 *   The coordinator keeps the guest fenced until restore/recovery settles.
 *
 * Exit codes: 65 invalid, 67 limit, 68 other, 69 cleanup not proven.
 */
export const PROJECT_RESTORE_SCRIPT = String.raw`
import gzip, json, os, posixpath, shutil, stat, sys, tarfile

archive, project = sys.argv[1:3]
max_bytes, max_entries = map(int, sys.argv[3:5])
mode = sys.argv[5]
if mode not in ('verify', 'restore', 'recover'): sys.exit(68)
parent, name = os.path.split(os.path.normpath(project))
staging = os.path.join(parent, '.' + name + '.restore')
previous = os.path.join(parent, '.' + name + '.previous')
journal = os.path.join(parent, '.' + name + '.restore-state')
journal_tmp = journal + '.tmp'

class Invalid(Exception): pass
class Limit(Exception): pass

class BoundedReader:
    def __init__(self, source):
        self.source = source
        self.remaining = max_bytes + max_entries * 2048 + 1048576
    def read(self, size):
        data = self.source.read(min(size, self.remaining + 1))
        self.remaining -= len(data)
        if self.remaining < 0: raise Limit()
        return data

def members():
    with gzip.open(archive, 'rb') as source:
        with tarfile.open(fileobj=BoundedReader(source), mode='r|') as tar:
            for member in tar:
                yield tar, member

def path_of(member):
    name = member.name
    if not name or len(name) > 4096 or name.startswith('/') or '..' in name.split('/'):
        raise Invalid()
    path = posixpath.normpath(name)
    if path == '.' and not member.isdir(): raise Invalid()
    if not (member.isfile() or member.isdir() or member.issym()): raise Invalid()
    if member.size < 0 or (not member.isfile() and member.size != 0): raise Invalid()
    if member.issym():
        target = member.linkname
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
        if not target or len(target) > 4096 or target.startswith('/') or resolved == '..' or resolved.startswith('../'):
            raise Invalid()
    return path

def status(error):
    return 67 if isinstance(error, Limit) else 65 if isinstance(error, (Invalid, tarfile.TarError, EOFError)) else 68

def remove(path):
    if os.path.isdir(path) and not os.path.islink(path): shutil.rmtree(path)
    elif os.path.lexists(path): os.unlink(path)

def directory(path):
    if not os.path.isdir(path) or os.path.islink(path): raise Invalid()

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)

def walk_error(error): raise error

def sync_tree(path):
    directory(path)
    for current, dirs, files in os.walk(path, topdown=False, followlinks=False, onerror=walk_error):
        for name in files:
            item = os.path.join(current, name)
            if os.path.islink(item): continue
            fd = os.open(item, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode): raise Invalid()
                os.fsync(fd)
            finally: os.close(fd)
        sync_directory(current)

def record(phase, had_project):
    remove(journal_tmp)
    with open(journal_tmp, 'x') as output:
        json.dump({'phase': phase, 'had_project': had_project}, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(journal_tmp, journal)
    sync_directory(parent)

def read_journal():
    if not os.path.lexists(journal): return None
    fd = os.open(journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 256: raise Invalid()
        value = json.loads(os.read(fd, 256))
    finally: os.close(fd)
    if (not isinstance(value, dict) or set(value) != {'phase', 'had_project'} or
        value['phase'] not in ('replacing', 'committed') or
        not isinstance(value['had_project'], bool)): raise Invalid()
    return value

def clear_contents(path):
    directory(path)
    for name in os.listdir(path): remove(os.path.join(path, name))

def recover():
    state = read_journal()
    if state and state['phase'] == 'replacing':
        # Never consume the only rollback copy. If recovery is interrupted,
        # the same journal and complete snapshot can be applied again.
        directory(previous)
        if state['had_project']:
            if not os.path.lexists(project): os.mkdir(project, 0o755)
            directory(project)
            clear_contents(project)
            shutil.copytree(previous, project, symlinks=True, dirs_exist_ok=True)
            sync_tree(project)
        else:
            remove(project)
        sync_directory(parent)
    elif state:
        directory(project)
    # First make the recovered/committed tree authoritative; only then may
    # its rollback copy disappear. No journal means the project was untouched.
    remove(journal)
    sync_directory(parent)
    remove(staging)
    remove(previous)
    remove(journal_tmp)

def validate():
    entries, total, count = {}, 0, 0
    for tar, member in members():
        count += 1
        total += member.size
        if count > max_entries or total > max_bytes: raise Limit()
        path = path_of(member)
        if path in entries: raise Invalid()
        entries[path] = 'link' if member.issym() else 'dir' if member.isdir() else 'file'
    for path in entries:
        parent = posixpath.dirname(path)
        while parent:
            if entries.get(parent, 'dir') != 'dir': raise Invalid()
            parent = posixpath.dirname(parent)

def extract():
    os.mkdir(staging, 0o755)
    links, modes = [], []
    for tar, member in members():
        path = path_of(member)
        destination = os.path.join(staging, path)
        if member.issym():
            links.append((member.linkname, destination))
            continue
        if member.isdir():
            os.makedirs(destination, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with tar.extractfile(member) as source, open(destination, 'xb') as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
        modes.append((destination, member.mode & 0o777))
    # Links are created last: extraction never follows an archive symlink.
    for target, destination in links:
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        os.symlink(target, destination)
    root = os.path.realpath(staging)
    for target, destination in links:
        if os.path.commonpath([root, os.path.realpath(destination)]) != root: raise Invalid()
    for destination, mode in sorted(modes, key=lambda entry: len(entry[0]), reverse=True):
        os.chmod(destination, mode)

if mode == 'recover':
    try: recover()
    except Exception: sys.exit(69)
    sys.exit(0)
try:
    validate()
except Exception as error:
    sys.exit(status(error))
if mode == 'verify': sys.exit(0)
try:
    recover()
except Exception:
    sys.exit(69)
try:
    extract()
    had_project = os.path.lexists(project)
    if had_project:
        directory(project)
        # Copy lower/merged directories; renaming them can fail with EXDEV.
        # Any space/copy failure occurs before modifying the original tree.
        shutil.copytree(project, previous, symlinks=True)
    else:
        os.mkdir(previous, 0o755)
    sync_tree(previous)
    record('replacing', had_project)
    if not had_project: os.mkdir(project, 0o755)
    clear_contents(project)
    # These entries were freshly extracted into the writable upper layer.
    for name in os.listdir(staging):
        os.rename(os.path.join(staging, name), os.path.join(project, name))
    os.chmod(project, stat.S_IMODE(os.stat(staging).st_mode))
    sync_tree(project)
    record('committed', had_project)
except Exception as error:
    try:
        recover()
    except Exception:
        sys.exit(69)
    sys.exit(status(error))
# The journal proves a complete new tree. Cleanup failure may leave harmless
# scratch state; the next recovery must keep the committed project.
try: recover()
except Exception: pass
`;
