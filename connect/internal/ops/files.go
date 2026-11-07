package ops

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// maxTextFileBytes is the largest file read and edit load; a larger one
// answers computer_file_too_large.
var maxTextFileBytes int64 = 64 << 20

// loadFile reads a regular file of at most maxTextFileBytes.
func loadFile(path string) ([]byte, fs.FileInfo, protocol.ReasonCode) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, codeOf(err)
	}
	if info.IsDir() {
		return nil, nil, protocol.CodeComputerIsADirectory
	}
	if !info.Mode().IsRegular() {
		// A FIFO or device would block or never end.
		return nil, nil, protocol.CodeComputerFileBinary
	}
	if info.Size() > maxTextFileBytes {
		return nil, nil, protocol.CodeComputerFileTooLarge
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, codeOf(err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxTextFileBytes+1))
	if err != nil {
		return nil, nil, codeOf(err)
	}
	if int64(len(data)) > maxTextFileBytes {
		return nil, nil, protocol.CodeComputerFileTooLarge
	}
	return data, info, ""
}

// read returns lines offset..offset+limit-1 of a text file as UTF-8 with
// "\n" line breaks, each line cut to MaxReadLineLength characters.
func (e *Executor) read(args *protocol.ReadArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	data, _, code := loadFile(e.resolve(args.Cwd, args.Path))
	if code != "" {
		return nil, code
	}
	file, err := decodeText(data, e.sys.TextCodePage())
	if err != nil {
		return nil, protocol.CodeComputerFileBinary
	}
	text := toLF(file.text)
	lines := strings.SplitAfter(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	result := &protocol.ReadResult{
		StartLine: args.Offset, TotalLines: len(lines), Encoding: file.encoding, LineEnding: lineEnding(file.text),
	}
	var content strings.Builder
	from := args.Offset - 1
	for i := from; i < len(lines) && i < from+args.Limit; i++ {
		line, cut := cutLine(strings.TrimSuffix(lines[i], "\n"), protocol.MaxReadLineLength)
		if strings.HasSuffix(lines[i], "\n") {
			line += "\n"
		}
		if content.Len()+len(line) > protocol.MaxReadBytes {
			result.Truncated = true
			break
		}
		content.WriteString(line)
		result.Truncated = result.Truncated || cut
	}
	if from+args.Limit < len(lines) {
		result.Truncated = true
	}
	result.Content = content.String()
	return result, ""
}

// write creates or replaces a file, creating its parent folders. A new file
// is UTF-8 without a BOM. A replaced text file keeps its encoding as edit
// does: UTF-16 or UTF-8 with its BOM, the ANSI code page, CRLF line
// endings, told from the whole file also when it is too large to load
// (textFormat). Text that code page cannot hold answers
// computer_text_unencodable and writes nothing; a file that cannot be read
// answers its code and is not written either. A file that is not text
// becomes UTF-8. The replacement is atomic, or the file is written in place
// with a backup (replaceFile). The executor's write lock is held from the
// first look at the file to the end (lockWrites).
func (e *Executor) write(ctx context.Context, args *protocol.WriteArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	target := e.resolve(args.Cwd, args.Path)
	unlock, code := e.lockWrites(ctx)
	if code != "" {
		return nil, code
	}
	defer unlock()
	content := []byte(args.Content)
	info, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) {
		result, code, exists := create(target, content)
		if !exists {
			return result, code
		}
		// Another program created the file since: it is replaced.
		info, err = os.Stat(target)
	}
	switch {
	case err != nil:
		return nil, codeOf(err)
	case info.IsDir():
		return nil, protocol.CodeComputerIsADirectory
	case !info.Mode().IsRegular():
		return nil, protocol.CodeComputerFileBinary
	}
	file, code := textFormat(ctx, target, e.sys.TextCodePage())
	if code != "" {
		return nil, code
	}
	if file != nil {
		text := args.Content
		if file.lineEnding() == protocol.LineEndingCRLF {
			text = toCRLF(text)
		}
		if file.bom != nil {
			// The file's BOM is written once.
			text = strings.TrimPrefix(text, string(rune(0xFEFF)))
		}
		if content, err = file.encode(text); err != nil {
			return nil, protocol.CodeComputerTextUnencodable
		}
	}
	if err := replaceFile(e.sys, e.inPlace, target, content, info); err != nil {
		return nil, replaceCode(err)
	}
	return &protocol.WriteResult{Bytes: int64(len(content)), Created: false}, ""
}

// create writes content to a new file at path, creating its folders; at
// the target of a symbolic link that points nowhere yet (realPath). The
// file is created only where none is (O_EXCL), so a file another program
// created since the write looked is never cut: exists is then true and
// nothing was written.
func create(path string, content []byte) (result protocol.Validator, code protocol.ReasonCode, exists bool) {
	path = realPath(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return nil, codeOf(err), false
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if errors.Is(err, fs.ErrExist) {
		return nil, "", true
	}
	if err != nil {
		return nil, codeOf(err), false
	}
	_, err = f.Write(content)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, codeOf(err), false
	}
	return &protocol.WriteResult{Bytes: int64(len(content)), Created: true}, "", false
}

// maxLinkHops bounds how many symbolic links realPath follows.
const maxLinkHops = 40

// realPath is path with its symbolic links resolved. A file that does not
// exist yet is where it would be created: the target of a dangling link,
// in its folder with that folder's links resolved; path as given when not
// even its folder exists. O_EXCL does not follow a link, so create needs
// the target itself.
func realPath(path string) string {
	path = filepath.Clean(path)
	for range maxLinkHops {
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			return resolved
		}
		link, err := os.Readlink(path)
		if err != nil {
			break
		}
		if !filepath.IsAbs(link) {
			link = filepath.Join(realDir(filepath.Dir(path)), link)
		}
		path = filepath.Clean(link)
	}
	return filepath.Join(realDir(filepath.Dir(path)), filepath.Base(path))
}

func realDir(dir string) string {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return dir
}

// formatChunkBytes is how much of a file too large to load scanFormat
// reads at a time; never more than maxTextFileBytes, which tests lower.
const formatChunkBytes = 1 << 20

// textFormat tells how the existing file at path stores its text, as
// decodeText does from the whole file; nil when it is not text. A file too
// large to load is read through in chunks (scanFormat). A file that cannot
// be read answers its code, so a write never changes how a file is stored
// unseen.
func textFormat(ctx context.Context, path string, cp CodePage) (*textFile, protocol.ReasonCode) {
	data, _, code := loadFile(path)
	if code == protocol.CodeComputerFileTooLarge {
		return scanFormat(ctx, path, cp)
	}
	if code != "" {
		return nil, code
	}
	file, err := decodeText(data, cp)
	if err != nil {
		return nil, ""
	}
	return &file, ""
}

// scanFormat tells how a file too large to load stores its text, deciding
// as decodeText does from the whole file, read in chunks of
// formatChunkBytes in bounded memory: a start that is ASCII, or that ends
// inside a character or a line break, decides nothing. A UTF-16 BOM makes
// it UTF-16, binary (nil) with a NUL code unit or an odd length; otherwise
// NUL bytes make it binary, and it is UTF-8 (with its BOM) when all of it
// is, else in the code page cp when all of it decodes in it (decodeChunk),
// else of an unknown encoding (raw, which holds its first chunk). Its line
// endings are all of its own (ending); its text is empty. UTF-8 is checked
// in chunks that end where a character does (chunkEnd), and an incomplete
// one is carried into the next. It stops, answering computer_timeout or
// computer_cancelled, when ctx ends.
func scanFormat(ctx context.Context, path string, cp CodePage) (*textFile, protocol.ReasonCode) {
	f, err := os.Open(path)
	if err != nil {
		return nil, codeOf(err)
	}
	defer f.Close()
	read := make([]byte, min(formatChunkBytes, maxTextFileBytes))
	file := textFile{encoding: "utf-8"}
	var lines lineCounter
	// odd is the first byte of a UTF-16 code unit a read cut in two. buf is
	// what followed the last chunk's end; carry is what decodeChunk carried.
	var odd, buf, carry, head []byte
	utf8OK, cpOK := true, cp != nil
	for first := true; ; first = false {
		if ctx.Err() != nil {
			return nil, ctxCode(ctx)
		}
		n, err := io.ReadFull(f, read)
		last := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
		if err != nil && !last {
			return nil, codeOf(err)
		}
		data := read[:n]
		if first {
			switch {
			case bytes.HasPrefix(data, bomUTF8):
				file.encoding, file.bom = "utf-8-bom", bomUTF8
				// decodeText reads no code page after a UTF-8 BOM.
				cpOK = false
			case bytes.HasPrefix(data, bomUTF16LE):
				file.encoding, file.bom, file.order = "utf-16le", bomUTF16LE, binary.LittleEndian
			case bytes.HasPrefix(data, bomUTF16BE):
				file.encoding, file.bom, file.order = "utf-16be", bomUTF16BE, binary.BigEndian
			}
			data = data[len(file.bom):]
			head = bytes.Clone(data)
		}
		if file.order != nil {
			var ok bool
			if odd, ok = lines.addUTF16(file.order, odd, data); !ok || last && len(odd) != 0 {
				return nil, ""
			}
			if last {
				break
			}
			continue
		}
		if bytes.IndexByte(data, 0) >= 0 {
			return nil, ""
		}
		lines.addBytes(data)
		buf = append(buf, data...)
		cut := len(buf)
		if !last {
			cut = chunkEnd(buf)
		}
		chunk := buf[:cut]
		utf8OK = utf8OK && utf8.Valid(chunk)
		if cpOK {
			if len(carry) > 0 {
				chunk = append(carry, chunk...)
			}
			carry, cpOK = decodeChunk(cp, chunk, last)
		}
		if last {
			break
		}
		buf = append(buf[:0], buf[cut:]...)
	}
	file.ending = lines.ending()
	switch {
	case file.order != nil, utf8OK:
	case cpOK:
		file.encoding, file.codePage = cp.Name(), cp
	default:
		file.raw = head
	}
	return &file, ""
}

// lineCounter counts the line endings of a text read in parts, as
// lineEnding does from all of it: a "\r" that ends one part and the "\n"
// that starts the next are one "\r\n".
type lineCounter struct {
	crlf, lf int
	// cr is true when the last character was "\r".
	cr bool
}

// addBytes counts the next part of a text in UTF-8 or a Windows code page,
// whose "\r" and "\n" bytes are never part of another character.
func (c *lineCounter) addBytes(b []byte) {
	if len(b) == 0 {
		return
	}
	crlf := bytes.Count(b, []byte("\r\n"))
	if c.cr && b[0] == '\n' {
		crlf++
	}
	c.crlf += crlf
	c.lf += bytes.Count(b, []byte("\n")) - crlf
	c.cr = b[len(b)-1] == '\r'
}

// addUTF16 counts the next part of a UTF-16 text in byte order order:
// data after odd, the first byte of a code unit the part before cut in
// two. rest is the first byte of a code unit this part cuts in two; ok is
// false at a NUL code unit, which makes the file binary.
func (c *lineCounter) addUTF16(order binary.ByteOrder, odd, data []byte) (rest []byte, ok bool) {
	if len(odd) == 0 && len(data) == 0 {
		return nil, true
	}
	if len(odd) > 0 {
		if len(data) == 0 {
			return odd, true
		}
		if !c.addUnit(order.Uint16([]byte{odd[0], data[0]})) {
			return nil, false
		}
		data = data[1:]
	}
	whole := len(data) &^ 1
	for i := 0; i < whole; i += 2 {
		if !c.addUnit(order.Uint16(data[i:])) {
			return nil, false
		}
	}
	return bytes.Clone(data[whole:]), true
}

func (c *lineCounter) addUnit(unit uint16) bool {
	switch unit {
	case 0:
		return false
	case '\n':
		if c.cr {
			c.crlf++
		} else {
			c.lf++
		}
	}
	c.cr = unit == '\r'
	return true
}

func (c *lineCounter) ending() protocol.LineEnding { return endingOf(c.crlf, c.lf) }

// edit replaces oldString with newString, once unless replaceAll, keeping
// the file's encoding, BOM and line endings. The executor's write lock is
// held from its read to the end (lockWrites).
func (e *Executor) edit(ctx context.Context, args *protocol.EditArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	target := e.resolve(args.Cwd, args.Path)
	unlock, code := e.lockWrites(ctx)
	if code != "" {
		return nil, code
	}
	defer unlock()
	data, info, code := loadFile(target)
	if code != "" {
		return nil, code
	}
	file, err := decodeText(data, e.sys.TextCodePage())
	if err != nil {
		return nil, protocol.CodeComputerFileBinary
	}
	var out []byte
	var count int
	if file.raw != nil {
		// Bytes that are not text stay as they are: the edit works on bytes.
		out, count, code = replaceBytes(file.raw, args)
	} else {
		var text string
		text, count, code = replaceText(file.text, args)
		if code == "" {
			if out, err = file.encode(text); err != nil {
				return nil, protocol.CodeComputerTextUnencodable
			}
		}
	}
	if code != "" {
		return nil, code
	}
	if err := replaceFile(e.sys, e.inPlace, target, out, info); err != nil {
		return nil, replaceCode(err)
	}
	return &protocol.EditResult{Replacements: int64(count)}, ""
}

// replaceText finds oldString as given and, in a file with CRLF line
// endings (or mixed ones, when it is not found as given), with its "\n"
// written as "\r\n".
func replaceText(text string, args *protocol.EditArgs) (string, int, protocol.ReasonCode) {
	oldString, newString := args.OldString, args.NewString
	ending := lineEnding(text)
	if ending == protocol.LineEndingCRLF || ending == protocol.LineEndingMixed && !strings.Contains(text, oldString) {
		oldString, newString = toCRLF(oldString), toCRLF(newString)
	}
	count := strings.Count(text, oldString)
	switch {
	case count == 0:
		return "", 0, protocol.CodeComputerEditNoMatch
	case count > 1 && !args.ReplaceAll:
		return "", 0, protocol.CodeComputerEditAmbiguous
	}
	return strings.ReplaceAll(text, oldString, newString), count, ""
}

func replaceBytes(data []byte, args *protocol.EditArgs) ([]byte, int, protocol.ReasonCode) {
	text, count, code := replaceText(string(data), args)
	return []byte(text), count, code
}
