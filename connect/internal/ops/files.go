package ops

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

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
// endings; text that code page cannot hold answers
// computer_text_unencodable and writes nothing. A file that is not text
// becomes UTF-8. The replacement is atomic (replaceFile).
func (e *Executor) write(args *protocol.WriteArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	target := e.resolve(args.Cwd, args.Path)
	content := []byte(args.Content)
	info, err := os.Stat(target)
	created := errors.Is(err, fs.ErrNotExist)
	switch {
	case created:
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			return nil, codeOf(err)
		}
		if err := os.WriteFile(target, content, 0o666); err != nil {
			return nil, codeOf(err)
		}
		return &protocol.WriteResult{Bytes: int64(len(content)), Created: true}, ""
	case err != nil:
		return nil, codeOf(err)
	case info.IsDir():
		return nil, protocol.CodeComputerIsADirectory
	case !info.Mode().IsRegular():
		return nil, protocol.CodeComputerFileBinary
	}
	if existing, _, code := loadFile(target); code == "" {
		if file, err := decodeText(existing, e.sys.TextCodePage()); err == nil {
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
	}
	if err := replaceFile(e.sys, target, content, info); err != nil {
		return nil, codeOf(err)
	}
	return &protocol.WriteResult{Bytes: int64(len(content)), Created: false}, ""
}

// edit replaces oldString with newString, once unless replaceAll, keeping
// the file's encoding, BOM and line endings.
func (e *Executor) edit(args *protocol.EditArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	target := e.resolve(args.Cwd, args.Path)
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
	if err := replaceFile(e.sys, target, out, info); err != nil {
		return nil, codeOf(err)
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
