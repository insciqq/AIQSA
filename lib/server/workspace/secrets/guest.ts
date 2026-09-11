import { WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES } from "./manifest";

/** Static code; secret bytes travel on stdin, never in executable source. */
export const INSTALL_WORKSPACE_SECRETS = String.raw`
import base64, json, os, pathlib, shutil, stat, subprocess, sys, tempfile

def directory(path):
    if path.is_symlink(): raise ValueError('directory_invalid')
    path.mkdir(mode=0o700, exist_ok=True)
    if not stat.S_ISDIR(path.lstat().st_mode): raise ValueError('directory_invalid')

def remove(path):
    if path.is_symlink() or path.is_file(): path.unlink()
    elif path.exists(): shutil.rmtree(path)

def write(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream: stream.write(value)

temporary = None
try:
    raw = sys.stdin.buffer.read(${WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES + 1})
    if len(raw) > ${WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES}: raise ValueError('input_invalid')
    data = json.loads(raw)
    root = pathlib.Path('/workspace')
    directory(root)
    managed = root / 'secrets'
    directory(managed)
    directory(managed / 'browser')
    same_run = False
    marker = managed / '.environment.json'
    if marker.exists() or marker.is_symlink():
        fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 262144: raise ValueError('run_marker_invalid')
            same_run = json.loads(stream.read(262145)).get('runId') == data['runId']
    directory(pathlib.Path('/root'))
    ssh_home = pathlib.Path('/root/.ssh')
    directory(ssh_home)
    config_path = ssh_home / 'config'
    if config_path.is_symlink() or (config_path.exists() and not stat.S_ISREG(config_path.lstat().st_mode)):
        raise ValueError('ssh_config_invalid')
    existing_config = b''
    if config_path.exists():
        fd = os.open(config_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 131072: raise ValueError('ssh_config_invalid')
            existing_config = stream.read(131073)
    if len(existing_config) > 131072: raise ValueError('ssh_config_invalid')
    include = b'Include /workspace/secrets/ssh_config'
    existing_config = b'\n'.join(line for line in existing_config.splitlines() if line.strip() != include)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.install-', dir=managed))
    directory(temporary / 'ssh')
    directory(temporary / 'files')
    directory(temporary / 'browser')
    identities = []
    for item in data['secrets']:
        value = item['value']
        if value['kind'] == 'file':
            write(temporary / 'files' / item['id'], base64.b64decode(value['base64'], validate=True))
        elif value['kind'] == 'browser_session' and not same_run:
            write(temporary / 'browser' / value['originalName'], base64.b64decode(value['base64'], validate=True))
        elif value['kind'] == 'ssh_key':
            target = temporary / 'ssh' / item['id']
            write(target, (value['privateKey'].strip() + '\n').encode('utf-8'))
            result = subprocess.run(['/usr/bin/ssh-keygen', '-q', '-p', '-P', value['passphrase'], '-N', '', '-f', str(target)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}, timeout=8)
            if result.returncode: raise ValueError('ssh_key_invalid')
            target.chmod(0o600)
            identities.append('/workspace/secrets/ssh/' + item['id'])
    ssh_config = 'Host *\n  BatchMode yes\n  StrictHostKeyChecking accept-new\n'
    if identities:
        ssh_config += '  IdentitiesOnly yes\n' + ''.join('  IdentityFile ' + path + '\n' for path in identities)
    write(temporary / 'ssh_config', ssh_config.encode())
    write(temporary / 'user_config', include + b'\n' + existing_config + b'\n')
    write(temporary / '.environment.json', json.dumps({'runId': data['runId'], 'values': data['environment']}, ensure_ascii=False).encode('utf-8'))
    write(temporary / 'guide', data['guide'].encode('utf-8'))
    for name in ['ssh', 'files']:
        remove(managed / name)
        os.replace(temporary / name, managed / name)
    if not same_run:
        remove(managed / 'browser')
        os.replace(temporary / 'browser', managed / 'browser')
    for name in ['ssh_config', '.environment.json']:
        os.replace(temporary / name, managed / name)
    os.replace(temporary / 'user_config', config_path)
    os.replace(temporary / 'guide', root / 'SECRETS.md')
except BaseException:
    sys.exit(1)
finally:
    if temporary is not None: shutil.rmtree(temporary, ignore_errors=True)
`;

export const READ_WORKSPACE_SECRET_ENV = String.raw`
import json, os, pathlib, stat, sys
try:
    path = pathlib.Path('/workspace/secrets/.environment.json')
    if pathlib.Path('/workspace').is_symlink() or path.parent.is_symlink(): raise ValueError('invalid')
    if not path.exists() and not path.is_symlink():
        print('{}')
    else:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 262144: raise ValueError('invalid')
            data = json.loads(stream.read(262145))
        if data['runId'] != sys.argv[1]: raise ValueError('stale')
        print(json.dumps(data['values'], ensure_ascii=False))
except BaseException:
    sys.exit(1)
`;
