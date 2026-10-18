// Package logx is the client's content-free log: event names, codes and
// counts only. Terminal bytes, input, commands, titles, paths and tokens
// never belong in it, and the logger enforces that for string values: any
// string that is not a short code is written as "?".
package logx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MaxFileBytes is the size at which the log file is rotated to <name>.1.
const MaxFileBytes = 5 << 20

var codeValue = regexp.MustCompile(`^[a-z0-9_.:-]{0,64}$`)

// Logger writes one line per event to its writers.
type Logger struct {
	mu      sync.Mutex
	writers []io.Writer
	file    *rotatingFile
	now     func() time.Time
}

// New logs to the given writers.
func New(writers ...io.Writer) *Logger {
	return &Logger{writers: writers, now: time.Now}
}

// Discard drops every event.
func Discard() *Logger { return New() }

// Open logs to the size-bounded file at path (mode 0600) and to extra writers.
func Open(path string, extra ...io.Writer) (*Logger, error) {
	file, err := openRotating(path, MaxFileBytes)
	if err != nil {
		return nil, err
	}
	l := New(append([]io.Writer{file}, extra...)...)
	l.file = file
	return l, nil
}

// Close closes the log file, if any.
func (l *Logger) Close() error {
	if l == nil || l.file == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.file.Close()
}

// Event logs name with key/value pairs. Keys and string values must be
// short lowercase codes; other strings are replaced by "?". Integers,
// booleans and durations are written as is; errors are reduced to ErrKind.
func (l *Logger) Event(name string, kv ...any) {
	if l == nil {
		return
	}
	var b strings.Builder
	b.WriteString(l.now().UTC().Format("2006-01-02T15:04:05.000Z"))
	b.WriteByte(' ')
	b.WriteString(safeCode(name))
	for i := 0; i+1 < len(kv); i += 2 {
		key, _ := kv[i].(string)
		b.WriteByte(' ')
		b.WriteString(safeCode(key))
		b.WriteByte('=')
		b.WriteString(formatValue(kv[i+1]))
	}
	b.WriteByte('\n')
	line := b.String()
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, w := range l.writers {
		io.WriteString(w, line)
	}
}

func safeCode(s string) string {
	if s != "" && codeValue.MatchString(s) {
		return s
	}
	return "?"
}

func formatValue(v any) string {
	switch value := v.(type) {
	case string:
		return safeCode(value)
	case fmt.Stringer:
		if d, ok := v.(time.Duration); ok {
			return d.Round(time.Millisecond).String()
		}
		return safeCode(value.String())
	case error:
		return ErrKind(value)
	case bool:
		return strconv.FormatBool(value)
	case int:
		return strconv.Itoa(value)
	case int64:
		return strconv.FormatInt(value, 10)
	case uint64:
		return strconv.FormatUint(value, 10)
	case int32:
		return strconv.FormatInt(int64(value), 10)
	case uint32:
		return strconv.FormatUint(uint64(value), 10)
	case nil:
		return "none"
	}
	// Named string types such as protocol reason codes.
	if rv := reflect.ValueOf(v); rv.Kind() == reflect.String {
		return safeCode(rv.String())
	}
	return "?"
}

// ErrKind reduces an error to a content-free category.
func ErrKind(err error) string {
	if err == nil {
		return "none"
	}
	var netErr net.Error
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "eof"
	case errors.As(err, &netErr):
		return "network"
	case errors.Is(err, os.ErrNotExist):
		return "not_found"
	case errors.Is(err, os.ErrPermission):
		return "permission"
	}
	var coded interface{ LogCode() string }
	if errors.As(err, &coded) {
		return safeCode(coded.LogCode())
	}
	return "error"
}

type rotatingFile struct {
	path string
	max  int64
	f    *os.File
	size int64
}

func openRotating(path string, max int64) (*rotatingFile, error) {
	r := &rotatingFile{path: path, max: max}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *rotatingFile) open() error {
	f, err := os.OpenFile(r.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	f.Chmod(0o600)
	r.f, r.size = f, info.Size()
	return nil
}

// Write appends p, rotating first when the file would exceed max. Callers
// hold the logger's mutex.
func (r *rotatingFile) Write(p []byte) (int, error) {
	if r.f == nil {
		return 0, os.ErrClosed
	}
	if r.size+int64(len(p)) > r.max {
		r.f.Close()
		os.Rename(r.path, r.path+".1")
		if err := r.open(); err != nil {
			r.f = nil
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

func (r *rotatingFile) Close() error {
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}
