import { SKILL_ARCHIVE_MAX_ENTRIES, SKILL_FILE_MAX_BYTES, SKILL_MAX_FILES } from "@/lib/contracts/skills";
import { SKILL_RUNTIME_ARCHIVE_MAX_BYTES, SKILL_RUNTIME_CONTENT_MAX_BYTES, SKILL_RUNTIME_JSON_MAX_BYTES,
  SKILL_RUNTIME_MARKDOWN_MAX_BYTES, SKILL_RUNTIME_REFS_MAX, SKILL_RUNTIME_TAR_MAX_BYTES,
  WORKSPACE_SKILLS_DIRECTORY, WORKSPACE_SKILLS_DISCOVERY_DIRECTORY } from "./skillBundles";

/** Fixed guest paths and code; bounded metadata travels on stdin, never shell source. */
export const WORKSPACE_SKILL_GUEST_SCRIPT = String.raw`
import gzip, hashlib, io, json, os, pathlib, re, shutil, stat, sys, tempfile

ROOT = '${WORKSPACE_SKILLS_DIRECTORY}'
DISCOVERY = '${WORKSPACE_SKILLS_DISCOVERY_DIRECTORY}'
temporary = None
class Invalid(Exception): pass
class Limit(Exception): pass

def chain(path):
    current = pathlib.Path('/')
    for part in pathlib.PurePosixPath(path).parts[1:]:
        current /= part
        try: mode = current.lstat().st_mode
        except FileNotFoundError:
            current.mkdir(mode=0o755)
            mode = current.lstat().st_mode
        if not stat.S_ISDIR(mode): raise Invalid()
    return str(current)

def remove(path):
    try: mode = os.lstat(path).st_mode
    except FileNotFoundError: return
    if stat.S_ISDIR(mode): shutil.rmtree(path)
    else: os.unlink(path)

def alias(value):
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*', value): raise Invalid()
    return value

def text(header, start, length):
    raw = header[start:start+length]
    if b'\0' in raw:
        value, rest = raw.split(b'\0', 1)
        if any(rest): raise Invalid()
    else: value = raw
    return value.decode('utf-8', 'strict')

def number(header, start, length):
    value = header[start:start+length].split(b'\0', 1)[0].strip()
    if not re.fullmatch(b'[0-7]+', value): raise Invalid()
    return int(value, 8)

def safe_path(path):
    parts = path.split('/')
    if not path or path.startswith('/') or '\\' in path or re.match('[a-zA-Z]:', path) or any(ord(c)<32 or ord(c)==127 for c in path): raise Invalid()
    if any(p in ('', '.', '..') or len(p.encode('utf-8'))>255 for p in parts): raise Invalid()
    if len(path.encode('utf-8')) <= 100: return
    for i in range(1, len(parts)):
        if len('/'.join(parts[:i]).encode('utf-8'))<=155 and len('/'.join(parts[i:]).encode('utf-8'))<=100: return
    raise Invalid()

def entries(data):
    result, tree, seen = [], {}, set()
    offset, total, files = 0, 0, 0
    ended = False
    while offset+512 <= len(data):
        header = data[offset:offset+512]
        offset += 512
        if not any(header):
            if offset+512 > len(data) or any(data[offset:]): raise Invalid()
            ended = True
            break
        if len(result) >= ${SKILL_ARCHIVE_MAX_ENTRIES}: raise Limit()
        if text(header,257,6)!='ustar' or text(header,263,2)!='00' or number(header,148,8)!=sum(header[:148])+256+sum(header[156:]): raise Invalid()
        name, prefix = text(header,0,100), text(header,345,155)
        directory = header[156]==53
        if not directory and header[156] not in (0,48): raise Invalid()
        path = (prefix+'/' if prefix else '')+name
        if directory and path.endswith('/'): path = path[:-1]
        safe_path(path)
        if path.lower() in seen or text(header,157,100): raise Invalid()
        seen.add(path.lower())
        parts = path.split('/')
        for i in range(1,len(parts)+1):
            part = '/'.join(parts[:i])
            kind = i<len(parts) or directory
            previous = tree.get(part.lower())
            if previous and (previous[0]!=part or not previous[1] or not kind): raise Invalid()
            tree[part.lower()] = (part,kind)
        size, mode = number(header,124,12), number(header,100,8)
        if (directory and (size!=0 or mode!=0o755)) or (not directory and mode not in (0o644,0o755)): raise Invalid()
        if not directory: files += 1
        if files > ${SKILL_MAX_FILES + 1}: raise Limit()
        if size > (${SKILL_RUNTIME_MARKDOWN_MAX_BYTES} if path=='SKILL.md' else ${SKILL_FILE_MAX_BYTES}): raise Limit()
        total += size
        if total > ${SKILL_RUNTIME_CONTENT_MAX_BYTES}: raise Limit()
        end = offset+((size+511)//512)*512
        if end>len(data) or any(data[offset+size:end]): raise Invalid()
        result.append((path,directory,mode,data[offset:offset+size]))
        offset = end
    if not ended or not any(path=='SKILL.md' and not directory for path,directory,mode,content in result): raise Invalid()
    return result

try:
    raw = sys.stdin.buffer.read(${SKILL_RUNTIME_JSON_MAX_BYTES + 1})
    if len(raw)>${SKILL_RUNTIME_JSON_MAX_BYTES}: raise Limit()
    data = json.loads(raw)
    action = data['action']
    if action=='stage':
        path = data['archivePath']
        if not re.fullmatch('/tmp/aiqsa-skill-[a-f0-9-]+[.]tar[.]gz', path): raise Invalid()
        chain('/tmp')
        fd = os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        os.close(fd)
    elif action=='reset':
        chain('/workspace/.aiqsa')
        chain('/root/.agents')
        remove(ROOT)
        os.mkdir(ROOT, 0o755)
        os.chmod(ROOT, 0o755)
        remove(DISCOVERY)
        os.mkdir(DISCOVERY, 0o755)
    elif action=='links':
        names = [alias(value) for value in data['aliases']]
        if len(names)!=len(set(names)) or len(names)>${SKILL_RUNTIME_REFS_MAX}: raise Invalid()
        chain(ROOT)
        chain('/root/.agents')
        for name in names:
            destination = os.path.join(ROOT,name)
            if not stat.S_ISDIR(os.lstat(destination).st_mode): raise Invalid()
            if not stat.S_ISREG(os.lstat(os.path.join(destination,'SKILL.md')).st_mode): raise Invalid()
        temporary = tempfile.mkdtemp(prefix='.skills-',dir='/root/.agents')
        os.chmod(temporary,0o755)
        for name in names: os.symlink(os.path.join(ROOT,name),os.path.join(temporary,name))
        remove(DISCOVERY)
        os.replace(temporary,DISCOVERY)
        temporary = None
    elif action=='install':
        name = alias(data['alias'])
        archive = data['archivePath']
        if not re.fullmatch('/tmp/aiqsa-skill-[a-f0-9-]+[.]tar[.]gz',archive): raise Invalid()
        fd = os.open(archive,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size!=data['byteSize'] or info.st_size>${SKILL_RUNTIME_ARCHIVE_MAX_BYTES}: raise Invalid()
            compressed = source.read(${SKILL_RUNTIME_ARCHIVE_MAX_BYTES + 1})
        if hashlib.sha256(compressed).hexdigest()!=data['checksum']: raise Invalid()
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source: unpacked=source.read(${SKILL_RUNTIME_TAR_MAX_BYTES + 1})
        if len(unpacked)>${SKILL_RUNTIME_TAR_MAX_BYTES}: raise Limit()
        members = entries(unpacked)
        # No managed path is touched until all members have passed validation.
        chain(ROOT)
        temporary = tempfile.mkdtemp(prefix='.install-',dir=ROOT)
        os.chmod(temporary,0o755)
        for path,directory,mode,content in members:
            destination = os.path.join(temporary,path)
            os.makedirs(os.path.dirname(destination),mode=0o755,exist_ok=True)
            if directory: os.makedirs(destination,mode=0o755,exist_ok=True)
            else:
                fd = os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
                with os.fdopen(fd,'wb') as target: target.write(content)
            os.chmod(destination,mode)
        for parent,dirs,files in os.walk(temporary):
            os.chmod(parent,0o755)
        target = os.path.join(ROOT,name)
        remove(target)
        os.replace(temporary,target)
        temporary = None
    else: raise Invalid()
except BaseException as error:
    sys.exit(67 if isinstance(error,Limit) else 65)
finally:
    if temporary is not None: remove(temporary)
`;
