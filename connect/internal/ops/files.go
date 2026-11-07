package ops

import (
	"bytes"
	"context"
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
// with a backup (replaceFile). The file's locks are held from the first
// look at it to the end (lockFile).
func (e *Executor) write(ctx context.Context, args *protocol.WriteArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	held, code := e.lockFile(ctx, e.resolve(args.Cwd, args.Path))
	if code != "" {
		return nil, code
	}
	defer held.release()
	target := held.path
	content := []byte(args.Content)
	info, err := os.Stat(target)
	if errors.Is(err, fs.ErrNotExist) {
		result, code, exists := create(ctx, held, content)
		if !exists {
			return result, code
		}
		// Another name of the file created it since: it is replaced.
		if err := held.lockExisting(ctx); err != nil {
			return nil, ctxCode(ctx)
		}
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
		if lineEnding(file.text) == protocol.LineEndingCRLF {
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

// create writes content to a new file at held.path, creating its folders.
// The file is created only where none is (O_EXCL), so a file another name
// of it created since the lock was taken is never cut: exists is then true
// and nothing was written. The new file's own lock is taken before its
// content goes in, as another name of it may have reached it already; when
// ctx ends during that wait, the new file stays empty and the reply is
// computer_timeout or computer_cancelled, whose outcome the server keeps
// unknown.
func create(ctx context.Context, held *heldFile, content []byte) (result protocol.Validator, code protocol.ReasonCode, exists bool) {
	if err := os.MkdirAll(filepath.Dir(held.path), 0o777); err != nil {
		return nil, codeOf(err), false
	}
	f, err := os.OpenFile(held.path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if errors.Is(err, fs.ErrExist) {
		return nil, "", true
	}
	if err != nil {
		return nil, codeOf(err), false
	}
	if err := held.lockCreated(ctx, f); err != nil {
		f.Close()
		return nil, ctxCode(ctx), false
	}
	// What another name of the file wrote before its lock was taken is
	// written over whole.
	_, err = f.WriteAt(content, 0)
	if err == nil {
		err = f.Truncate(int64(len(content)))
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return nil, codeOf(err), false
	}
	return &protocol.WriteResult{Bytes: int64(len(content)), Created: true}, "", false
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
// inside a character, decides nothing. A UTF-16 BOM makes it UTF-16, read
// from the first chunk alone (binary when that has a NUL code unit);
// otherwise NUL bytes make it binary (nil), and it is UTF-8 (with its BOM)
// when all of it is, else in the code page cp when all of it decodes in
// it, else of an unknown encoding (raw). Its text is the first chunk's,
// which gives the line endings. Each chunk ends where a character does
// (chunkEnd), and an incomplete one is carried into the next. It stops,
// answering computer_timeout or computer_cancelled, when ctx ends.
func scanFormat(ctx context.Context, path string, cp CodePage) (*textFile, protocol.ReasonCode) {
	f, err := os.Open(path)
	if err != nil {
		return nil, codeOf(err)
	}
	defer f.Close()
	read := make([]byte, min(formatChunkBytes, maxTextFileBytes))
	var buf, head, bom []byte
	utf8OK, cpOK := true, cp != nil
	for first := true; ; first = false {
		if ctx.Err() != nil {
			return nil, ctxCode(ctx)
		}
		n, err := io.ReadFull(f, read)
		end := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
		if err != nil && !end {
			return nil, codeOf(err)
		}
		buf = append(buf, read[:n]...)
		if first {
			if bytes.HasPrefix(buf, bomUTF16LE) || bytes.HasPrefix(buf, bomUTF16BE) {
				// A code unit cut in two is left out; a surrogate pair cut in
				// two reads as U+FFFD.
				file, err := decodeText(buf[:len(buf)&^1], cp)
				if err != nil {
					return nil, ""
				}
				return &file, ""
			}
			if bytes.HasPrefix(buf, bomUTF8) {
				bom = bomUTF8
				buf = append(buf[:0], buf[len(bomUTF8):]...)
				// decodeText reads no code page after a UTF-8 BOM.
				cpOK = false
			}
			head = bytes.Clone(buf)
		}
		if bytes.IndexByte(buf, 0) >= 0 {
			return nil, ""
		}
		cut := len(buf)
		if !end {
			cut = chunkEnd(buf)
		}
		chunk := buf[:cut]
		utf8OK = utf8OK && utf8.Valid(chunk)
		if cpOK {
			_, cpOK = cp.Decode(chunk)
		}
		if end {
			break
		}
		buf = append(buf[:0], buf[cut:]...)
	}
	file := textFile{text: strings.ToValidUTF8(string(head), "�"), encoding: "utf-8", bom: bom}
	if bom != nil {
		file.encoding = "utf-8-bom"
	}
	switch {
	case utf8OK:
	case cpOK:
		file.encoding, file.codePage = cp.Name(), cp
	default:
		file.raw = append([]byte{}, head...)
	}
	return &file, ""
}

// edit replaces oldString with newString, once unless replaceAll, keeping
// the file's encoding, BOM and line endings. The file's locks are held from
// its read to the end (lockFile).
func (e *Executor) edit(ctx context.Context, args *protocol.EditArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	held, code := e.lockFile(ctx, e.resolve(args.Cwd, args.Path))
	if code != "" {
		return nil, code
	}
	defer held.release()
	target := held.path
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
