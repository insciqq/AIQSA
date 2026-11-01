import { WORKSPACE_PROXY_PLAN_PATH, WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES } from "./manifest";

/** Environments of the runs one shared Workspace serves: the newest of them, within the file bound. */
const WORKSPACE_RUN_ENVIRONMENTS_KEPT = 24;
const WORKSPACE_RUN_ENVIRONMENTS_FILE_MAX_BYTES = 4 * 262_144;

/** Exit statuses of the read helper; any other failure is its plain 1, and nothing else ever leaves it. */
export const WORKSPACE_SECRET_ENV_EXIT = Object.freeze({ missing: 65, unreadable: 66 });

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
    # The runs of one shared Workspace each keep their own environment: a later run's install never replaces an
    # attached run's values. The newest ${WORKSPACE_RUN_ENVIRONMENTS_KEPT} runs are kept, oldest dropped first.
    runs = []
    marker = managed / '.environment.json'
    if marker.exists() or marker.is_symlink():
        fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > ${WORKSPACE_RUN_ENVIRONMENTS_FILE_MAX_BYTES}: raise ValueError('run_marker_invalid')
            # Bytes a crash left behind cost the other runs their copy, never this install: each writes itself back.
            try: previous = json.loads(stream.read(${WORKSPACE_RUN_ENVIRONMENTS_FILE_MAX_BYTES + 1}))
            except ValueError: previous = {}
        if not isinstance(previous, dict): previous = {}
        if isinstance(previous.get('runs'), list):
            runs = [entry for entry in previous['runs'] if isinstance(entry, dict) and isinstance(entry.get('runId'), str)]
        elif isinstance(previous.get('runId'), str):
            runs = [{'runId': previous['runId'], 'values': previous.get('values', {})}]
        same_run = any(entry['runId'] == data['runId'] for entry in runs)
    runs = [entry for entry in runs if entry['runId'] != data['runId']]
    # The agent identity is supplied per command by the server. Never persist
    # a legacy or forged AIQSA_AGENT_* value in the VM's shared environment.
    values = {name: value for name, value in data['environment'].items() if not name.startswith('AIQSA_AGENT_')}
    runs.append({'runId': data['runId'], 'values': values})
    runs = runs[-${WORKSPACE_RUN_ENVIRONMENTS_KEPT}:]
    environments = json.dumps({'runs': runs}, ensure_ascii=False).encode('utf-8')
    while len(environments) > ${WORKSPACE_RUN_ENVIRONMENTS_FILE_MAX_BYTES} and len(runs) > 1:
        runs = runs[1:]
        environments = json.dumps({'runs': runs}, ensure_ascii=False).encode('utf-8')
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
    write(temporary / '.environment.json', environments)
    write(temporary / 'guide', data['guide'].encode('utf-8'))
    # The VM has one proxy plan, renamed into place so that it is never absent, and only over an equal or older
    # generation: a sub-agent of an earlier answer installs later than a newer run and must not undo its plan.
    plan_path = pathlib.Path('${WORKSPACE_PROXY_PLAN_PATH}')
    offered = data.get('proxyPlan')
    publish_plan = False
    if offered is not None:
        current = -1
        try:
            fd = os.open(plan_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if stat.S_ISREG(info.st_mode) and info.st_size <= ${WORKSPACE_SECRETS_GUEST_INPUT_MAX_BYTES}:
                    held = json.loads(stream.read()).get('generation')
                    if isinstance(held, int): current = held
        except (AttributeError, OSError, ValueError):
            pass  # Nothing there, or nothing readable: an offer replaces what cannot be ordered.
        publish_plan = offered['generation'] >= current
    if publish_plan:
        write(temporary / '.proxy-plan.json', json.dumps({'version': 1, **offered}, ensure_ascii=False).encode('utf-8'))
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
    if publish_plan: os.replace(temporary / '.proxy-plan.json', plan_path)
except BaseException:
    sys.exit(1)
finally:
    if temporary is not None: shutil.rmtree(temporary, ignore_errors=True)
`;

export const READ_WORKSPACE_SECRET_ENV = String.raw`
import json, os, pathlib, stat, sys

def read():
    path = pathlib.Path('/workspace/secrets/.environment.json')
    if pathlib.Path('/workspace').is_symlink() or path.parent.is_symlink(): return ${WORKSPACE_SECRET_ENV_EXIT.unreadable}
    if not path.exists() and not path.is_symlink(): return ${WORKSPACE_SECRET_ENV_EXIT.missing}
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > ${WORKSPACE_RUN_ENVIRONMENTS_FILE_MAX_BYTES}: return ${WORKSPACE_SECRET_ENV_EXIT.unreadable}
            data = json.loads(stream.read(${WORKSPACE_RUN_ENVIRONMENTS_FILE_MAX_BYTES + 1}))
        runs = data['runs'] if isinstance(data.get('runs'), list) else [data]
        values = next((entry['values'] for entry in runs if isinstance(entry, dict) and entry.get('runId') == sys.argv[1]), None)
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return ${WORKSPACE_SECRET_ENV_EXIT.unreadable}
    if values is None: return ${WORKSPACE_SECRET_ENV_EXIT.missing}
    print(json.dumps(values, ensure_ascii=False))
    return 0

try:
    status = read()
except BaseException:
    status = 1
sys.exit(status)
`;
