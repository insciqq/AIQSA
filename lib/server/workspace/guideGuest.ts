/**
 * The managed names and root are fixed; guide content is stdin data only. Each
 * guide is published by an atomic rename of a complete, synced staging file,
 * so a guide path holds complete content or is absent. Staging left by an
 * interrupted installer is removed by the next one.
 */
export const INSTALL_WORKSPACE_GUIDES = String.raw`
import json, os, secrets, stat, sys

WORKSPACE_ROOT = '/workspace'
MAX_INPUT = 65536
MAX_FILE = 32768
NAMES = ('office.md', 'browser.md', 'psd.md', 'skills.md')
STAGING_PREFIX = '.aiqsa-guide-'

def identity(info):
    return info.st_dev, info.st_ino

def install():
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError()
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {'version', 'guides'} or value['version'] != 1:
        raise ValueError()
    guides = value['guides']
    if not isinstance(guides, list) or len(guides) != len(NAMES):
        raise ValueError()
    prepared = []
    for expected, guide in zip(NAMES, guides):
        if not isinstance(guide, dict) or set(guide) != {'name', 'content'} or guide['name'] != expected:
            raise ValueError()
        content = guide['content']
        if not isinstance(content, str) or not content or '\x00' in content:
            raise ValueError()
        data = content.encode('utf-8')
        if len(data) > MAX_FILE:
            raise ValueError()
        prepared.append((expected, data))
    root = os.open(WORKSPACE_ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory = None
    try:
        try:
            os.mkdir('guides', 0o755, dir_fd=root)
        except FileExistsError:
            pass
        directory = os.open('guides', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        for stale in os.listdir(directory):
            if stale.startswith(STAGING_PREFIX):
                try:
                    os.unlink(stale, dir_fd=directory)
                except OSError:
                    pass
        for name, data in prepared:
            unchanged = False
            try:
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                info = None
            if info is not None:
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError()
                descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                with os.fdopen(descriptor, 'rb') as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode) or identity(opened) != identity(info):
                        raise ValueError()
                    unchanged = (opened.st_nlink == 1 and stat.S_IMODE(opened.st_mode) == 0o444
                                 and stream.read(MAX_FILE + 1) == data)
            if unchanged:
                continue
            temporary = STAGING_PREFIX + secrets.token_hex(16)
            try:
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=directory)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), 0o444)
                    os.fsync(stream.fileno())
                os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
                temporary = None
            finally:
                if temporary is not None:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass
        os.fsync(directory)
        if identity(os.stat('guides', dir_fd=root, follow_symlinks=False)) != identity(os.fstat(directory)):
            raise ValueError()
        if identity(os.stat(WORKSPACE_ROOT, follow_symlinks=False)) != identity(os.fstat(root)):
            raise ValueError()
    finally:
        if directory is not None:
            os.close(directory)
        os.close(root)

try:
    install()
except BaseException:
    sys.exit(1)
`;
