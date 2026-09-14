// Project trees have a separate entry bound from generated answer outputs.
export const PROJECT_ARCHIVE_MAX_ENTRIES = 100_000;

/** Runs inside the guest. All validation is structural; no file data leaves it. */
export const PROJECT_RESTORE_SCRIPT = String.raw`
import gzip, os, posixpath, shutil, sys, tarfile

archive, project = sys.argv[1:3]
max_bytes, max_entries = map(int, sys.argv[3:5])

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

def clear_project():
    if os.path.islink(project) or (os.path.exists(project) and not os.path.isdir(project)):
        os.unlink(project)
    elif os.path.isdir(project):
        shutil.rmtree(project)
    os.makedirs(project, mode=0o755)

try:
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
    clear_project()
    links, modes = [], []
    for tar, member in members():
        path = path_of(member)
        destination = os.path.join(project, path)
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
    root = os.path.realpath(project)
    for target, destination in links:
        if os.path.commonpath([root, os.path.realpath(destination)]) != root: raise Invalid()
    for destination, mode in sorted(modes, key=lambda entry: len(entry[0]), reverse=True):
        os.chmod(destination, mode)
except Exception as error:
    try:
        clear_project()
    except Exception:
        sys.exit(69)
    sys.exit(67 if isinstance(error, Limit) else 65 if isinstance(error, (Invalid, tarfile.TarError, EOFError)) else 68)
`;
