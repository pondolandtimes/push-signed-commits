package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

const MinGitMajor, MinGitMinor = 2, 38 // the minimum git version for the options we use.

type GitParseError struct {
	Reason error
}

func (err *GitParseError) Error() string {
	return fmt.Sprintf("internal error: failed to parse git output: %v", err.Reason)
}

func (err *GitParseError) Unwrap() error {
	return err.Reason
}

func gitParseErrf(format string, a ...any) error {
	return &GitParseError{
		Reason: fmt.Errorf(format, a...),
	}
}

type OID string

func (o OID) Valid() bool {
	for _, a := range o {
		switch {
		case 'a' <= a && a <= 'f':
		case '0' <= a && a <= '9':
		default:
			return false
		}
	}
	return len(o) != 0
}

type Git string

func (git *Git) LookPath() error {
	p := string(*git)
	if p == "" {
		p = "git"
	}
	p, err := exec.LookPath(p)
	if err == nil {
		*git = Git(p)
	}
	return err
}

func (git Git) CheckVersion() (version string, checked bool, err error) {
	version, err = git.Version()
	if err != nil {
		return "", false, fmt.Errorf("get version: %w", err)
	}

	major, minor, _, ok := parseVersion(version)
	if !ok {
		return version, false, nil
	}

	if major > MinGitMajor || (major == MinGitMajor && minor >= MinGitMinor) {
		err = nil
	} else {
		err = fmt.Errorf("git %q is too old (we need at least %d.%d)", version, MinGitMajor, MinGitMinor)
	}
	return version, true, err
}

func (git Git) Head() (OID, error) {
	buf, err := git.run("rev-parse", "--verify", "HEAD")
	if err != nil {
		return "", err
	}
	oid := OID(string(bytes.TrimSuffix(buf, []byte{'\n'})))
	if !oid.Valid() {
		return "", gitParseErrf("invalid oid %q", oid)
	}
	return oid, nil
}

func (git Git) Commits(revspec string) (commits []OID, err error) {
	buf, err := git.run("rev-list", // verify revs, list commits between them, and resolve them to their commit hash
		"-z",               // null-terminated output
		"--no-walk",        // if a single rev is specified, only resolve that one; ignored if a range is specified
		"--first-parent",   // only follow the first parent of merge commits (we'll filter those out later anyways)
		"--end-of-options", // prevent rev from being parsed as an option
		revspec,            // rev
		"--")               // prevent rev from being parsed as a path
	if err != nil {
		return nil, err
	}
	rest := buf
	for len(rest) != 0 {
		var (
			it []byte
			ok bool
		)
		it, rest, ok = bytes.Cut(rest, []byte{0})
		if !ok {
			return nil, gitParseErrf("unexpected end of output in %q", buf)
		}
		oid := OID(it)
		if !oid.Valid() {
			return nil, gitParseErrf("invalid oid %q", oid)
		}
		commits = append(commits, oid)
	}
	return commits, nil
}

func (git Git) CommitParents(committish OID) (commits []OID, err error) {
	buf, err := git.run("rev-parse", string(committish)+"^@") // note: unlike sha^, this will not fail if a commit has no parents
	if err != nil {
		return nil, err
	}
	for len(buf) > 0 {
		var line []byte
		line, buf, _ = bytes.Cut(buf, []byte{'\n'})
		oid := OID(line)
		if !oid.Valid() {
			return nil, gitParseErrf("invalid oid %q", oid)
		}
		commits = append(commits, oid)
	}
	return commits, nil
}

func (git Git) CommitMessage(committish OID) (string, error) {
	buf, err := git.run(
		"-c", "i18n.logOutputEncoding=UTF-8", // if the commit message is not UTF-8, re-encode it
		"show",             // show a formatted object
		"-s",               // only what we ask for, not the entire diff
		"--format=%B",      // raw commit message
		"--end-of-options", // no more options
		string(committish)) // commit
	if err != nil {
		return "", err
	}
	return string(buf), nil // yes, we keep the trailing newline since that's how git stores it
}

type GitDiffStatus byte

// git/diff.h DIFF_STATUS_*
const (
	GitDiffStatusAdded       GitDiffStatus = 'A'
	GitDiffStatusCopied      GitDiffStatus = 'C'
	GitDiffStatusDeleted     GitDiffStatus = 'D'
	GitDiffStatusModified    GitDiffStatus = 'M'
	GitDiffStatusRenamed     GitDiffStatus = 'R'
	GitDiffStatusTypeChanged GitDiffStatus = 'T'
	GitDiffStatusUnknown     GitDiffStatus = 'X'
	GitDiffStatusUnmerged    GitDiffStatus = 'U'
)

func (s GitDiffStatus) String() string {
	switch s {
	case GitDiffStatusAdded:
		return "added"
	case GitDiffStatusCopied:
		return "copied"
	case GitDiffStatusDeleted:
		return "deleted"
	case GitDiffStatusModified:
		return "modified"
	case GitDiffStatusRenamed:
		return "renamed"
	case GitDiffStatusTypeChanged:
		return "type changed"
	case GitDiffStatusUnknown:
		return "unknown"
	case GitDiffStatusUnmerged:
		return "unmerged"
	default:
		return string(s)
	}
}

type GitDiffFile struct {
	Status GitDiffStatus
	Path   string
}

func (f GitDiffFile) String() string {
	return string(appendMaybeQuoteToASCII([]byte{byte(f.Status), ' '}, f.Path))
}

func (git Git) StagedDiff(treeish OID) (files []GitDiffFile, err error) {
	buf, err := git.run("diff-index", // low-level tree diff
		"-z",               // null-terminated
		"-r",               // recurse into trees (and don't return the trees themselves)
		"--name-status",    // only status and paths
		"--cached",         // only index (i.e.,  staging area), not working tree files
		"--end-of-options", // no more options
		string(treeish))    // target
	if err != nil {
		return nil, err
	}
	return gitParseDiffTree(buf)
}

func (git Git) CommitDiff(treeishA, treeishB OID) (files []GitDiffFile, err error) {
	buf, err := git.run("diff-tree", // low-level tree diff
		"-z",               // null-terminated
		"-r",               // recurse into trees (and don't return the trees themselves)
		"--name-status",    // only status and paths
		"--end-of-options", // no more options
		string(treeishA),   // a
		string(treeishB))   // b
	if err != nil {
		return nil, err
	}
	return gitParseDiffTree(buf)
}

func gitParseDiffTree(buf []byte) (files []GitDiffFile, err error) {
	rest := buf
	for len(rest) != 0 {
		var (
			status []byte
			path   []byte
			ok     bool
		)
		status, rest, ok = bytes.Cut(rest, []byte{0})
		if !ok {
			return nil, gitParseErrf("unexpected eof in output %q: expected status", buf)
		}
		if len(status) == 0 {
			return nil, gitParseErrf("invalid empty status in output %q", buf)
		}
		switch GitDiffStatus(status[0]) {
		case GitDiffStatusRenamed, GitDiffStatusCopied:
			// these take two paths after (which we don't handle), and we shouldn't seem them anyways (diff-tree, unlike diff, won't give them by default even if the git config enables them)
			return nil, gitParseErrf("wtf: diff-tree gave us renames/copies but it shouldn't have")
		}
		path, rest, ok = bytes.Cut(rest, []byte{0})
		if !ok {
			return nil, gitParseErrf("unexpected eof in output %q: expected path", buf)
		}
		if len(path) == 0 {
			return nil, gitParseErrf("invalid empty path in output %q", buf)
		}
		files = append(files, GitDiffFile{
			Status: GitDiffStatus(status[0]),
			Path:   string(path),
		})
	}
	return files, nil
}

type GitObject struct {
	Type string
	Mode int
	OID  OID
}

func (git Git) ListTreeObjects(treeish OID, path string) (objects []GitObject, err error) {
	var buf []byte
	if treeish != "" {
		buf, err = git.run("ls-tree", // information about a tree object in the repository
			"-z", // null terminated
			"--format=%(objecttype) %(objectmode) %(objectname)", // fields
			"--end-of-options", // escape
			string(treeish),    // tree object
			path)               // path
	} else {
		buf, err = git.run("ls-files", // information about files in the index and working tree
			"-z", // null terminated
			"--format=%(objecttype) %(objectmode) %(objectname)", // fields
			"--cached",         // only index (i.e.,  staging area), not working tree files
			"--end-of-options", // escape
			path)               // path
	}
	if err != nil {
		return nil, err
	}
	rest := buf
	for len(rest) != 0 {
		var (
			objecttype []byte
			objectmode []byte
			objectname []byte
			ok         bool
		)
		objecttype, rest, ok = bytes.Cut(rest, []byte{0})
		if !ok {
			return nil, gitParseErrf("unexpected end of output in %q: expected type", buf)
		}
		objecttype, objectmode, ok = bytes.Cut(objecttype, []byte{' '})
		if !ok {
			return nil, gitParseErrf("invalid entry format in %q: expected mode", buf)
		}
		objectmode, objectname, ok = bytes.Cut(objectmode, []byte{' '})
		if !ok {
			return nil, gitParseErrf("invalid entry format in %q: expected name", buf)
		}
		mode, err := strconv.ParseInt(string(objectmode), 10, 0)
		if err != nil {
			return nil, gitParseErrf("invalid entry format in %q: invalid mode", buf)
		}
		oid := OID(objectname)
		if !oid.Valid() {
			return nil, gitParseErrf("invalid oid %q", oid)
		}
		objects = append(objects, GitObject{
			Type: string(objecttype),
			Mode: int(mode),
			OID:  oid,
		})
	}
	return objects, nil
}

func (git Git) CatFile(oid OID) ([]byte, error) {
	buf, err := git.run("cat-file", "-p", "--end-of-options", string(oid))
	if err != nil {
		return nil, err
	}
	return buf, nil
}

func (git Git) Version() (string, error) {
	buf, err := git.run("version")
	if err != nil {
		return "", err
	}
	// note: git/help.c specifies that "the format of this string should be kept stable for compatibility with external projects that rely on the output"
	rest, ok := bytes.CutPrefix(buf, []byte("git version "))
	if !ok {
		return "", fmt.Errorf("bad git version output %q", buf)
	}
	rest, _, ok = bytes.Cut(rest, []byte{'\n'})
	if !ok {
		return "", fmt.Errorf("bad git version output %q", buf)
	}
	return string(rest), nil
}

func parseVersion(v string) (major int, minor int, patch int, ok bool) {
	majorStr, minorStr, ok1 := strings.Cut(v, ".")
	minorStr, patchStr, ok2 := strings.Cut(minorStr, ".")
	major, err1 := strconv.Atoi(majorStr)
	minor, err2 := strconv.Atoi(minorStr)
	patch, err3 := strconv.Atoi(patchStr)
	return major, minor, patch, ok1 && ok2 && err1 == nil && err2 == nil && err3 == nil
}

func (git Git) run(args ...string) ([]byte, error) {
	debugcmd("git", args...)
	p := string(git)
	if p == "" {
		p = "git"
	}
	buf, err := exec.Command(p, args...).Output()
	if err != nil {
		err = fmt.Errorf("run %q: %w", "git"+fmtargs(args...), err)
	}
	return buf, err
}

// CutCommitMessage splits m into the subject and body for pretty-printing
// according to git's rules (see git/pretty.c format_subject), does NOT merge
// the subject into a single line (so subject isn't exactly equal to
// --format=%s).
func CutCommitMessage(m string) (subject, body string) {
	subject = trimBlankLinesStart(m)
	subject, body, _ = cutBlankLine(subject)
	subject = trimBlankLinesEnd(subject)
	body = trimBlankLinesStart(body)
	body = trimBlankLinesEnd(body)
	return
}

const asciiSpace = " \t\n\v\f\r"

func trimBlankLinesStart(s string) string {
	for {
		i := strings.IndexByte(s, '\n')
		if i == -1 {
			return s
		}
		if strings.TrimLeft(s[:i], asciiSpace) != "" {
			return s
		}
		s = s[i+1:]
	}
}

func trimBlankLinesEnd(s string) string {
	for {
		i := strings.LastIndexByte(s, '\n')
		if i == -1 {
			return s
		}
		if strings.TrimLeft(s[i+1:], asciiSpace) != "" {
			return s
		}
		s = s[:i]
	}
}

func cutBlankLine(s string) (before, after string, found bool) {
	rest := s
	for {
		i := strings.IndexByte(rest, '\n')
		if i == -1 {
			return s, "", false
		}
		if strings.TrimLeft(rest[:i], asciiSpace) == "" {
			return s[:len(s)-len(rest)], rest[i+1:], true
		}
		rest = rest[i+1:]
	}
}

func fmtargs(args ...string) string {
	var s []byte
	for _, a := range args {
		s = append(s, ' ')
		s = appendMaybeQuoteToASCII(s, a)
	}
	return string(s)
}

func appendMaybeQuoteToASCII(dst []byte, s string) []byte {
	i := len(dst)
	dst = strconv.AppendQuoteToASCII(dst, s)
	if len(dst)-i > 2 && string(dst[i+1:len(dst)-1]) == s {
		dst = append(dst[:i], s...)
	}
	return dst
}
