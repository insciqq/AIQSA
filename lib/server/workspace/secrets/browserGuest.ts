/** Metadata only. Byte reads use the existing native file stream after quiescence. */
export const LIST_WORKSPACE_BROWSER_SESSIONS = String.raw`
import itertools, json, os, pathlib, stat
try:
    root = pathlib.Path('/workspace/secrets/browser')
    entries = []
    invalid = False
    for parent in [pathlib.Path('/workspace'), root.parent, root]:
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()): invalid = True
    if invalid:
        print(json.dumps({'invalid': True, 'entries': []}))
    elif not root.exists():
        print(json.dumps({'entries': []}))
    else:
        with os.scandir(root) as scan:
            for item in itertools.islice(scan, 129):
                info = item.stat(follow_symlinks=False)
                entries.append({'name': item.name, 'size': info.st_size, 'file': stat.S_ISREG(info.st_mode)})
        print(json.dumps({'entries': entries[:128], 'overflow': len(entries) > 128}))
except BaseException:
    print(json.dumps({'failed': True, 'entries': []}))
`;
