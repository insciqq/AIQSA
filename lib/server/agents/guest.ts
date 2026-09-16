import { CODEX_HOME_DIRECTORY } from "./codexProfile";

export const AGENT_PROMPT_MAX_BYTES = 1024 * 1024;

/** Static setup only. Configuration travels on stdin, never in shell source. */
export const INSTALL_CODEX_PROFILE = String.raw`
import json, os, pathlib, stat, sys, tempfile
temporary = None
try:
    data = sys.stdin.buffer.read(524289)
    if len(data) > 524288: raise ValueError('input_invalid')
    config = json.loads(data)['config']
    if not isinstance(config, str): raise ValueError('input_invalid')
    current = pathlib.Path('/')
    for part in '${CODEX_HOME_DIRECTORY}'.strip('/').split('/'):
        current /= part
        if current.is_symlink(): raise ValueError('directory_invalid')
        current.mkdir(mode=0o700, exist_ok=True)
        if not stat.S_ISDIR(current.lstat().st_mode): raise ValueError('directory_invalid')
    fd, temporary = tempfile.mkstemp(prefix='.config-', dir=current)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream: stream.write(config)
    os.replace(temporary, current / 'config.toml')
    temporary = None
except BaseException:
    sys.exit(1)
finally:
    if temporary is not None: os.unlink(temporary)
`;
