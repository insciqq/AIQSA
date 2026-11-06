package ops

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/insciqq/AIQSA/connect/internal/protocol"
)

// Bounds of a glob or grep walk.
const (
	// maxWalkEntries bounds the entries one walk visits.
	maxWalkEntries = 200_000
	// maxGlobCandidates bounds the matches kept for sorting by time.
	maxGlobCandidates = 20_000
	// maxGrepFileBytes skips larger files in a grep.
	maxGrepFileBytes = 16 << 20
	// maxBraceExpansions bounds `{a,b}` alternatives of one pattern.
	maxBraceExpansions = 64
)

// skippedDirs are not walked into unless the search starts inside one or
// its pattern names one.
var skippedDirs = []string{".git", "node_modules"}

var errBadPattern = errors.New("bad pattern")

// globMatcher matches slash-separated relative paths against patterns with
// `*`, `?`, `[...]` within a segment, `**` across segments and `{a,b}`.
type globMatcher struct {
	patterns [][]string
	fold     bool
	// depth is the most segments a match can have; 0 when a pattern has `**`.
	depth int
}

func compileGlob(pattern string, fold bool) (*globMatcher, error) {
	if fold {
		pattern = strings.ToLower(pattern)
	}
	expanded, err := expandBraces(pattern)
	if err != nil {
		return nil, err
	}
	m := &globMatcher{fold: fold}
	for _, p := range expanded {
		segments := strings.Split(strings.Trim(p, "/"), "/")
		for _, segment := range segments {
			if segment == "**" {
				continue
			}
			if _, err := path.Match(segment, ""); err != nil {
				return nil, errBadPattern
			}
		}
		if slices.Contains(segments, "**") {
			m.depth = -1
		} else if m.depth >= 0 {
			m.depth = max(m.depth, len(segments))
		}
		m.patterns = append(m.patterns, segments)
	}
	if m.depth < 0 {
		m.depth = 0
	}
	return m, nil
}

// expandBraces expands `{a,b}` groups, innermost first.
func expandBraces(pattern string) ([]string, error) {
	out := []string{pattern}
	for range maxBraceExpansions {
		changed := false
		var next []string
		for _, p := range out {
			open := strings.LastIndexByte(p, '{')
			if open < 0 {
				next = append(next, p)
				continue
			}
			end := strings.IndexByte(p[open:], '}')
			if end < 0 {
				return nil, errBadPattern
			}
			changed = true
			for _, alt := range strings.Split(p[open+1:open+end], ",") {
				next = append(next, p[:open]+alt+p[open+end+1:])
			}
		}
		if len(next) > maxBraceExpansions {
			return nil, errBadPattern
		}
		out = next
		if !changed {
			return out, nil
		}
	}
	return nil, errBadPattern
}

func (m *globMatcher) match(rel string) bool {
	if m.fold {
		rel = strings.ToLower(rel)
	}
	parts := strings.Split(rel, "/")
	for _, p := range m.patterns {
		if matchSegments(p, parts) {
			return true
		}
	}
	return false
}

func matchSegments(pattern, parts []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			for i := 0; i <= len(parts); i++ {
				if matchSegments(pattern[1:], parts[i:]) {
					return true
				}
			}
			return false
		}
		if len(parts) == 0 {
			return false
		}
		if ok, _ := path.Match(pattern[0], parts[0]); !ok {
			return false
		}
		pattern, parts = pattern[1:], parts[1:]
	}
	return len(parts) == 0
}

// namesSkipped reports whether the pattern names one of skippedDirs.
func namesSkipped(pattern string) bool {
	for _, segment := range strings.Split(pattern, "/") {
		if slices.Contains(skippedDirs, segment) {
			return true
		}
	}
	return false
}

// walk visits the files under root, skipping skippedDirs unless allowed,
// at most maxDepth levels deep (0: any) and maxWalkEntries entries. It
// returns true when it stopped early.
func walk(ctx context.Context, root string, allowSkipped bool, maxDepth int, visit func(path string, d fs.DirEntry) bool) bool {
	if !allowSkipped {
		for _, segment := range strings.FieldsFunc(filepath.ToSlash(root), func(r rune) bool { return r == '/' }) {
			if slices.Contains(skippedDirs, segment) {
				allowSkipped = true
			}
		}
	}
	visited := 0
	stopped := false
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() && p != root {
				return fs.SkipDir
			}
			return nil
		}
		visited++
		if visited > maxWalkEntries || visited%256 == 0 && ctx.Err() != nil {
			stopped = true
			return fs.SkipAll
		}
		if d.IsDir() {
			if p == root {
				return nil
			}
			if !allowSkipped && slices.Contains(skippedDirs, d.Name()) {
				return fs.SkipDir
			}
			if maxDepth > 0 && depthOf(root, p) >= maxDepth {
				return fs.SkipDir
			}
			return nil
		}
		if !visit(p, d) {
			stopped = true
			return fs.SkipAll
		}
		return nil
	})
	return stopped
}

func depthOf(root, p string) int {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return 0
	}
	return len(strings.Split(filepath.ToSlash(rel), "/"))
}

// splitGlob separates an absolute pattern into the folder before its first
// wildcard and the rest.
func (e *Executor) splitGlob(pattern string) (base, rest string) {
	var parts []string
	if e.goos == "windows" {
		parts = strings.Split(strings.ReplaceAll(pattern, `\`, "/"), "/")
	} else {
		parts = strings.Split(pattern, "/")
	}
	for i, part := range parts {
		if strings.ContainsAny(part, "*?[{") {
			base = strings.Join(parts[:i], "/")
			if base == "" || e.goos == "windows" && len(base) == 2 {
				base += "/"
			}
			return e.resolve(e.home, base), strings.Join(parts[i:], "/")
		}
	}
	return e.resolve(e.home, pattern), ""
}

// foldCase reports whether names compare without regard to case: on
// Windows and macOS, whose file systems usually do.
func (e *Executor) foldCase() bool { return e.goos == "windows" || e.goos == "darwin" }

// glob lists the files matching a pattern under path (or cwd), most
// recently modified first.
func (e *Executor) glob(ctx context.Context, args *protocol.GlobArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	base := e.resolveCwd(args.Cwd)
	if args.Path != nil {
		base = e.resolve(args.Cwd, *args.Path)
	}
	pattern := args.Pattern
	if e.goos == "windows" {
		pattern = strings.ReplaceAll(pattern, `\`, "/")
	}
	if isAbsPath(e.goos, args.Pattern) {
		base, pattern = e.splitGlob(args.Pattern)
		if pattern == "" {
			pattern = "*"
			if info, err := os.Stat(base); err == nil && !info.IsDir() {
				base, pattern = filepath.Dir(base), filepath.Base(base)
			}
		}
	}
	if info, err := os.Stat(base); err != nil {
		return nil, codeOf(err)
	} else if !info.IsDir() {
		return nil, protocol.CodeComputerNotADirectory
	}
	matcher, err := compileGlob(pattern, e.foldCase())
	if err != nil {
		return nil, protocol.CodeComputerPatternInvalid
	}
	type found struct {
		path  string
		mtime time.Time
	}
	var matches []found
	truncated := walk(ctx, base, namesSkipped(pattern), matcher.depth, func(p string, d fs.DirEntry) bool {
		rel, err := filepath.Rel(base, p)
		if err != nil || !matcher.match(filepath.ToSlash(rel)) || !validDevicePath(p) {
			return true
		}
		info, err := d.Info()
		if err != nil {
			return true
		}
		matches = append(matches, found{p, info.ModTime()})
		return len(matches) < maxGlobCandidates
	})
	if ctx.Err() != nil {
		return nil, protocol.CodeComputerTimeout
	}
	slices.SortStableFunc(matches, func(a, b found) int {
		if c := b.mtime.Compare(a.mtime); c != 0 {
			return c
		}
		return strings.Compare(a.path, b.path)
	})
	result := &protocol.GlobResult{Paths: []string{}, Truncated: truncated}
	for _, m := range matches {
		if len(result.Paths) == protocol.MaxGlobPaths {
			result.Truncated = true
			break
		}
		result.Paths = append(result.Paths, m.path)
	}
	return result, ""
}

// grep searches file contents with an RE2 pattern, line by line.
func (e *Executor) grep(ctx context.Context, args *protocol.GrepArgs) (protocol.Validator, protocol.ReasonCode) {
	e.useCwd(args.Cwd)
	source := args.Pattern
	if args.IgnoreCase {
		source = "(?i)" + source
	}
	re, err := regexp.Compile(source)
	if err != nil {
		return nil, protocol.CodeComputerPatternInvalid
	}
	var filter *globMatcher
	filterPath := false
	if args.Glob != nil {
		pattern := *args.Glob
		if e.goos == "windows" {
			pattern = strings.ReplaceAll(pattern, `\`, "/")
		}
		if filter, err = compileGlob(pattern, e.foldCase()); err != nil {
			return nil, protocol.CodeComputerPatternInvalid
		}
		filterPath = strings.Contains(pattern, "/")
	}
	target := e.resolveCwd(args.Cwd)
	if args.Path != nil {
		target = e.resolve(args.Cwd, *args.Path)
	}
	info, err := os.Stat(target)
	if err != nil {
		return nil, codeOf(err)
	}
	result := &protocol.GrepResult{Mode: args.Mode, Matches: []protocol.GrepMatch{}}
	type fileHit struct {
		path  string
		mtime time.Time
	}
	var hits []fileHit
	full := func() bool { return len(result.Matches)+len(hits) >= protocol.MaxGrepMatches }
	search := func(p string, fileInfo fs.FileInfo) bool {
		if !validDevicePath(p) || fileInfo.Size() > maxGrepFileBytes || !fileInfo.Mode().IsRegular() {
			return true
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return true
		}
		file, err := decodeText(data, e.sys.TextCodePage())
		if err != nil {
			return true
		}
		lines := strings.Split(toLF(file.text), "\n")
		if len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
		switch args.Mode {
		case protocol.GrepFiles:
			for _, line := range lines {
				if re.MatchString(line) {
					hits = append(hits, fileHit{p, fileInfo.ModTime()})
					break
				}
			}
		case protocol.GrepCount:
			var count int64
			for _, line := range lines {
				if re.MatchString(line) {
					count++
				}
			}
			if count > 0 {
				result.Matches = append(result.Matches, protocol.GrepMatch{Path: p, Count: &count})
			}
		case protocol.GrepContent:
			if !grepContent(result, p, lines, re, args.Context) {
				result.Truncated = true
				return false
			}
		}
		return !full()
	}
	if !info.IsDir() {
		search(target, info)
	} else {
		pattern := ""
		if args.Glob != nil {
			pattern = *args.Glob
		}
		stopped := walk(ctx, target, namesSkipped(pattern), 0, func(p string, d fs.DirEntry) bool {
			if filter != nil {
				name := d.Name()
				if filterPath {
					rel, err := filepath.Rel(target, p)
					if err != nil {
						return true
					}
					name = filepath.ToSlash(rel)
				}
				if !filter.match(name) {
					return true
				}
			}
			fileInfo, err := d.Info()
			if err != nil {
				return true
			}
			return search(p, fileInfo)
		})
		result.Truncated = result.Truncated || stopped
	}
	if ctx.Err() != nil {
		return nil, protocol.CodeComputerTimeout
	}
	if args.Mode == protocol.GrepFiles {
		slices.SortStableFunc(hits, func(a, b fileHit) int { return b.mtime.Compare(a.mtime) })
		for _, hit := range hits {
			result.Matches = append(result.Matches, protocol.GrepMatch{Path: hit.path})
		}
	}
	if len(result.Matches) > protocol.MaxGrepMatches {
		result.Matches, result.Truncated = result.Matches[:protocol.MaxGrepMatches], true
	}
	return result, ""
}

// grepContent adds a file's matching lines with context lines around them;
// false when the result is full.
func grepContent(result *protocol.GrepResult, p string, lines []string, re *regexp.Regexp, context int) bool {
	matched := make([]bool, len(lines))
	any := false
	for i, line := range lines {
		if re.MatchString(line) {
			matched[i], any = true, true
		}
	}
	if !any {
		return true
	}
	isContext := true
	for i := range lines {
		near := false
		for j := max(i-context, 0); j <= min(i+context, len(lines)-1); j++ {
			if matched[j] {
				near = true
				break
			}
		}
		if !near {
			continue
		}
		if len(result.Matches) >= protocol.MaxGrepMatches {
			return false
		}
		text, _ := cutLine(lines[i], protocol.MaxReadLineLength)
		line := i + 1
		match := protocol.GrepMatch{Path: p, Line: &line, Text: &text}
		if !matched[i] {
			match.Context = &isContext
		}
		result.Matches = append(result.Matches, match)
	}
	return true
}
