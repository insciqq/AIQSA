/** Bounded control metadata only on stdout; file bytes use the existing SDK FS stream. */
export const SELECTED_FILE_CAPTURE_GUEST = String.raw`
import os, sys, json, stat, signal, fcntl, hashlib

class CaptureFailure(Exception):
    def __init__(self, code): self.code = code

def fail(code='source_invalid'): raise CaptureFailure(code)
def interrupt(*_): fail('source_busy')
def timeout(*_): fail('timeout')

signal.signal(signal.SIGIO, interrupt)
signal.signal(signal.SIGALRM, timeout)
signal.alarm(30)
files = []

def open_regular(path):
    parts = path.split('/')
    if parts[0] != '' or any(p in ('', '.', '..') for p in parts[1:]): fail()
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[1:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        pinned = os.open(parts[-1], os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
        try:
            metadata = os.fstat(pinned)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1: fail()
            # Inspect before opening for I/O: even device/FIFO open side effects
            # are forbidden. Reopen only the inode pinned by this helper.
            fd = os.open('/proc/self/fd/' + str(pinned), os.O_RDONLY | os.O_NONBLOCK)
            return fd, metadata
        finally:
            os.close(pinned)
    finally:
        os.close(directory)

try:
    line = sys.stdin.buffer.readline(65537)
    if len(line) > 65536 or not line.endswith(b'\n'): fail()
    request = json.loads(line)
    paths = request['paths']
    maximum = request['fileMaxBytes']
    total_maximum = request['totalMaxBytes']
    if not isinstance(paths, list) or not 1 <= len(paths) <= 100: fail()
    if type(maximum) != int or not 0 < maximum <= 1073741824: fail()
    if type(total_maximum) != int or not 0 < total_maximum <= 2147483647: fail()
    total = 0
    for path in paths:
        if not isinstance(path, str) or len(path.encode('utf-8')) > 768 or '\x00' in path: fail()
        if not path.startswith(('/workspace/inbox/messages/', '/workspace/project/', '/workspace/output/')): fail()
        fd, metadata = open_regular(path)
        files.append((path, fd, metadata))
        if metadata.st_size < 0 or metadata.st_size > maximum: fail('limit')
        total += metadata.st_size
        if total > total_maximum: fail('limit')
    # All leases precede all reads: one stable set, including cross-file writers.
    for _, fd, _ in files:
        try: fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        except OSError as error:
            if error.errno in (11, 13): fail('source_busy')
            if error.errno in (22, 38, 95): fail('unsupported')
            raise
    metadata = []
    for _, fd, original in files:
        current = os.fstat(fd)
        if current.st_size != original.st_size: fail('source_busy')
        checksum = hashlib.sha256()
        count = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk: break
            count += len(chunk)
            if count > original.st_size: fail('source_busy')
            checksum.update(chunk)
        if count != original.st_size or fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK: fail('source_busy')
        metadata.append({'fd': fd, 'byteSize': count, 'checksum': checksum.hexdigest()})
    print(json.dumps({'pid': os.getpid(), 'files': metadata}), flush=True)
    if sys.stdin.buffer.readline(32) != b'finish\n': fail()
    for path, fd, original in files:
        if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK: fail('source_busy')
        checked, current = open_regular(path)
        os.close(checked)
        if (current.st_dev, current.st_ino, current.st_size) != (original.st_dev, original.st_ino, original.st_size): fail('source_busy')
    print('{"complete":true}', flush=True)
except CaptureFailure as error:
    print(json.dumps({'error': error.code}), flush=True)
    sys.exit(65)
except BaseException:
    print('{"error":"source_invalid"}', flush=True)
    sys.exit(65)
finally:
    signal.signal(signal.SIGIO, signal.SIG_IGN)
    signal.alarm(0)
    for _, fd, _ in files:
        try: fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
        except OSError: pass
        try: os.close(fd)
        except OSError: pass
`;
