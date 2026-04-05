package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

const MinGitMajor, MinGitMinor = 2, 38 // the minimum git version for the options we use.

type gitParseError struct {
	Reason error
}

func (err *gitParseError) Error() string {
	return fmt.Sprintf("internal error: failed to parse git output: %v", err.Reason)
}

func (err *gitParseError) Unwrap() error {
	return err.Reason
}

func gitParseErrf(format string, a ...any) error {
	return &gitParseError{
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

func gitHead() (OID, error) {
	buf, err := git("rev-parse", "--verify", "HEAD")
	if err != nil {
		return "", err
	}
	oid := OID(string(bytes.TrimSuffix(buf, []byte{'\n'})))
	if !oid.Valid() {
		return "", gitParseErrf("invalid oid %q", oid)
	}
	return oid, nil
}

func gitCommits(revspec string) (commits []OID, err error) {
	buf, err := git("rev-list", // verify revs, list commits between them, and resolve them to their commit hash
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

func gitCommitParents(committish OID) (commits []OID, err error) {
	buf, err := git("rev-parse", string(committish)+"^@") // note: unlike sha^, this will not fail if a commit has no parents
	if err != nil {
		return nil, err
	}
	for line := range bytes.Lines(buf) {
		oid := OID(line[:len(line)-1])
		if !oid.Valid() {
			return nil, gitParseErrf("invalid oid %q", oid)
		}
		commits = append(commits, oid)
	}
	return commits, nil
}

func gitCommitMessage(committish OID) (string, error) {
	buf, err := git("show",
		"-s",               // only what we ask for, not the entire diff
		"--format=%B",      // raw commit message
		"--end-of-options", // no more options
		string(committish)) // commit
	if err != nil {
		return "", err
	}
	return string(buf), nil // yes, we keep the trailing newline since that's how git stores it
}

type gitDiffStatus byte

// git/diff.h DIFF_STATUS_*
const (
	gitCommitDiffAdded       gitDiffStatus = 'A'
	gitCommitDiffCopied      gitDiffStatus = 'C'
	gitCommitDiffDeleted     gitDiffStatus = 'D'
	gitCommitDiffModified    gitDiffStatus = 'M'
	gitCommitDiffRenamed     gitDiffStatus = 'R'
	gitCommitDiffTypeChanged gitDiffStatus = 'T'
	gitCommitDiffUnknown     gitDiffStatus = 'X'
	gitCommitDiffUnmerged    gitDiffStatus = 'U'
)

func (s gitDiffStatus) String() string {
	switch s {
	case gitCommitDiffAdded:
		return "added"
	case gitCommitDiffCopied:
		return "copied"
	case gitCommitDiffDeleted:
		return "deleted"
	case gitCommitDiffModified:
		return "modified"
	case gitCommitDiffRenamed:
		return "renamed"
	case gitCommitDiffTypeChanged:
		return "type changed"
	case gitCommitDiffUnknown:
		return "unknown"
	case gitCommitDiffUnmerged:
		return "unmerged"
	default:
		return string(s)
	}
}

type gitDiffFile struct {
	Status gitDiffStatus
	Path   string
}

func (f gitDiffFile) String() string {
	return string(appendMaybeQuoteToASCII([]byte{byte(f.Status), ' '}, f.Path))
}

func gitStagedDiff(treeish OID) (files []gitDiffFile, err error) {
	buf, err := git("diff-index", // low-level tree diff
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

func gitCommitDiff(treeishA, treeishB OID) (files []gitDiffFile, err error) {
	buf, err := git("diff-tree", // low-level tree diff
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

func gitParseDiffTree(buf []byte) (files []gitDiffFile, err error) {
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
		switch gitDiffStatus(status[0]) {
		case gitCommitDiffRenamed, gitCommitDiffCopied:
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
		files = append(files, gitDiffFile{
			Status: gitDiffStatus(status[0]),
			Path:   string(path),
		})
	}
	return files, nil
}

type gitObject struct {
	Type string
	Mode int
	OID  OID
}

func gitListTreeObjects(treeish OID, path string) (objects []gitObject, err error) {
	var buf []byte
	if treeish != "" {
		buf, err = git("ls-tree", // information about a tree object in the repository
			"-z", // null terminated
			"--format=%(objecttype) %(objectmode) %(objectname)", // fields
			"--end-of-options", // escape
			string(treeish),    // tree object
			path)               // path
	} else {
		buf, err = git("ls-files", // information about files in the index and working tree
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
		objects = append(objects, gitObject{
			Type: string(objecttype),
			Mode: int(mode),
			OID:  oid,
		})
	}
	return objects, nil
}

func gitCatFile(oid OID) ([]byte, error) {
	buf, err := git("cat-file", "-p", "--end-of-options", string(oid))
	if err != nil {
		return nil, err
	}
	return buf, nil
}

func gitVersion() (string, error) {
	buf, err := git("version")
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

func git(args ...string) ([]byte, error) {
	debugcmd("git", args...)
	buf, err := exec.Command(*Git, args...).Output()
	if err != nil {
		err = fmt.Errorf("run %q: %w", "git"+fmtargs(args...), err)
	}
	return buf, err
}

// cutCommitMessage splits m into the subject and body for pretty-printing
// according to git's rules (see git/pretty.c format_subject), does NOT merge
// the subject into a single line (so subject isn't exactly equal to
// --format=%s).
func cutCommitMessage(m string) (subject, body string) {
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
