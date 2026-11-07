package ops

import (
	"encoding/base64"
	"errors"
	"io"
	"os"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// maxTransferBytes is the largest file read_bytes reads; tests lower it.
var maxTransferBytes int64 = protocol.MaxTransferBytes

// readBytes answers bytes offset..offset+length of a regular file as
// base64, with the whole file's size and modification time, so the server
// can fetch a file in chunks and tell when it changed between them. The
// size and time are the open file's after the read: a file cut short while
// it is read answers its new size, never a chunk that disagrees with it.
// An offset at or past the end answers an empty chunk with eof. It opens
// the file as read does (on Windows other programs may keep reading and
// writing it) and changes nothing on the computer, not even the recent
// folders. Its reply is never shrunk (shrink), since a cut chunk is
// corrupt; a full chunk fits the reply (TestReadBytesFullChunkFitsReply).
func (e *Executor) readBytes(args *protocol.ReadBytesArgs) (protocol.Validator, protocol.ReasonCode) {
	target := e.resolve(args.Cwd, args.Path)
	// A FIFO or device would block or never end: only a regular file is opened.
	if code := checkTransferFile(os.Stat(target)); code != "" {
		return nil, code
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, codeOf(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if code := checkTransferFile(info, err); code != "" {
		return nil, code
	}
	var data []byte
	if args.Offset < info.Size() {
		data = make([]byte, min(int64(args.Length), info.Size()-args.Offset))
		n, err := f.ReadAt(data, args.Offset)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, codeOf(err)
		}
		data = data[:n]
		if info, err = f.Stat(); err != nil {
			return nil, codeOf(err)
		}
		if code := checkTransferFile(info, nil); code != "" {
			return nil, code
		}
	}
	size := info.Size()
	return &protocol.ReadBytesResult{
		Data:       base64.StdEncoding.EncodeToString(data),
		Size:       size,
		ModifiedMs: info.ModTime().UnixMilli(),
		EOF:        args.Offset+int64(len(data)) >= size,
	}, ""
}

// checkTransferFile answers the code of a stat that read_bytes cannot read:
// missing, a folder, not a regular file (as read: computer_file_binary) or
// larger than maxTransferBytes.
func checkTransferFile(info os.FileInfo, err error) protocol.ReasonCode {
	switch {
	case err != nil:
		return codeOf(err)
	case info.IsDir():
		return protocol.CodeComputerIsADirectory
	case !info.Mode().IsRegular():
		return protocol.CodeComputerFileBinary
	case info.Size() > maxTransferBytes:
		return protocol.CodeComputerFileTooLarge
	}
	return ""
}
