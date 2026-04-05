package main

import (
	"bytes"
	"cmp"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"time"
)

const MinGitMajor, MinGitMinor = 2, 38 // the minimum git version for the options we use.

const DefaultGitHubGraphqlURL = "https://api.github.com/graphql"

var (
	Chdir      = flag.String("C", "", "change to a different directory before running the command")
	Git        = flag.String("g", "", "use a different git binary (minimum version "+strconv.Itoa(MinGitMajor)+"."+strconv.Itoa(MinGitMinor)+")")
	DryRun     = flag.Bool("n", false, "do not push commits, just dump the mutations to stdout, one line per commit")
	Insecure   = flag.Bool("k", false, "do not validate ssl certificates")
	Quiet      = flag.Bool("q", false, "do not print status messages to stderr")
	Verbose    = flag.Bool("v", false, "print verbose information to stderr")
	Debug      = flag.Bool("x", false, "print the git commands to stderr")
	Commit     = flag.Bool("commit", false, "commit the staged changes")
	AllowEmpty = flag.Bool("allow-empty", false, "allow an empty commit to be created (only valid with -commit)")
)

var (
	GitHubGraphqlURL = cmp.Or(os.Getenv("GITHUB_GRAPHQL_URL"), DefaultGitHubGraphqlURL)
	GitHubToken      = os.Getenv("GITHUB_TOKEN")
)

func init() {
	flag.CommandLine.Usage = usage
}

func usage() {
	var name string
	if len(os.Args) != 0 {
		name = os.Args[0]
	} else {
		name = "push-signed-commits"
	}
	fmt.Fprintf(flag.CommandLine.Output(), "usage:\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  %s [flags] username/repo target_branch rev|rev..rev\n", name)
	fmt.Fprintf(flag.CommandLine.Output(), "  %s [flags] -commit [-allow-empty] username/repo target_branch commit_message\n", name)
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "flags:\n")
	flag.CommandLine.PrintDefaults()
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "env:\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  GITHUB_GRAPHQL_URL    github graphql endpoint (default %q)\n", DefaultGitHubGraphqlURL)
	fmt.Fprintf(flag.CommandLine.Output(), "  GITHUB_TOKEN          github token (required if not -n)\n")
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "status:\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  0     success\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  1     error\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  2     invalid argument\n")
	fmt.Fprintf(flag.CommandLine.Output(), "  30    not pushing anymore commits due to a commit with unsupported content\n")
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "The final commit hashes will be written to stdout as they are pushed.\n")
	fmt.Fprintf(flag.CommandLine.Output(), "\n")
	fmt.Fprintf(flag.CommandLine.Output(), "If there are no commits in the specified range (or -commit is specified without\n")
	fmt.Fprintf(flag.CommandLine.Output(), "anything in the staging area or -allow-empty), the command does nothing (and\n")
	fmt.Fprintf(flag.CommandLine.Output(), "prints a message if not -q), then exits with status 0.\n")
}

func main() {
	flag.Parse()

	if flag.NArg() != 3 {
		usage()
		os.Exit(2)
	}

	if *AllowEmpty && !*Commit {
		usage()
		os.Exit(2)
	}

	if *Insecure {
		http.DefaultTransport.(*http.Transport).TLSClientConfig = &tls.Config{
			InsecureSkipVerify: true,
		}
	}

	if *Chdir != "" {
		if err := os.Chdir(*Chdir); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			os.Exit(1)
		}
	}

	if err := run(flag.Arg(0), flag.Arg(1), flag.Arg(2)); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		if _, ok := errors.AsType[*notPushableError](err); ok {
			os.Exit(30)
		}
		os.Exit(1)
	}
}

type notPushableError struct {
	Commit OID
	Reason error
}

func (err *notPushableError) Error() string {
	var what string
	if err.Commit == "" {
		what = "staging area"
	} else {
		what = "commit " + string(err.Commit)
	}
	return fmt.Sprintf("%s cannot be pushed via the API: %v", what, err.Reason)
}

func (err *notPushableError) Unwrap() error {
	return err.Reason
}

func notPushableErrf(commit OID, format string, a ...any) error {
	return &notPushableError{
		Commit: commit,
		Reason: fmt.Errorf(format, a...),
	}
}

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

func run(repo, branch, specOrMessage string) error {
	if p, err := exec.LookPath(cmp.Or(*Git, "git")); err != nil {
		return fmt.Errorf("resolve git binary: %w", err)
	} else {
		*Git = p
	}

	ver, err := gitVersion()
	if err != nil {
		return fmt.Errorf("get git version: %w", err)
	}
	verbose("git version %s", ver)

	if major, minor, _, ok := parseVersion(ver); !ok {
		// it might be a commit if built from source
		fmt.Fprintf(os.Stderr, "warning: failed to parse git version %q, will continue anyways\n", ver)
	} else if !(major > MinGitMajor || (major == MinGitMajor && minor >= MinGitMinor)) {
		return fmt.Errorf("git %q is too old (we need at least %d.%d)", ver, MinGitMajor, MinGitMinor)
	}

	if *Commit {
		return runCommit(repo, branch, specOrMessage)
	}
	return runCommits(repo, branch, specOrMessage)
}

func runCommit(repo, branch, message string) error {
	parent, err := gitHead()
	if err != nil {
		return fmt.Errorf("get head commit: %w", err)
	}

	files, err := gitStagedDiff(parent)
	if err != nil {
		return fmt.Errorf("diff staging area against head %s: %w", parent, err)
	}
	for _, file := range files {
		verbose("diff %s %q", file.Status, file.Path)
	}

	if !*AllowEmpty && len(files) == 0 {
		if !*Quiet {
			fmt.Fprintf(os.Stderr, "nothing to commit in the staging area\n")
		}
		return nil
	}

	subject, body := cutCommitMessage(message)
	verbose("subject %q", subject)
	verbose("body %q", body)

	input := gqlCreateCommitOnBranchInput{
		Branch: gqlCommittableBranch{
			RepositoryNameWithOwner: repo,
			BranchName:              branch,
		},
		Message: gqlCommitMessage{
			Headline: subject,
			Body:     body,
		},
		ExpectedHeadOid: parent,
	}

	// note: files are transformed (e.g., for core.autocrlf) when adding them to
	// the index, so that isn't something we have to worry about here

	input.FileChanges, err = changes("", files)
	if err != nil {
		return err
	}

	inputJSON, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("marshal json: %w", err)
	}

	if *DryRun {
		os.Stdout.Write(append(inputJSON, '\n'))
		return nil
	}

	verbose("creating commit")

	if !*Quiet {
		fmt.Fprintf(os.Stderr, "pushing new commit from staging area (size=%d additions=%d deletions=%d) over %s:%s@%s\n", len(inputJSON), len(input.FileChanges.Additions), len(input.FileChanges.Deletions), input.Branch.RepositoryNameWithOwner, input.Branch.BranchName, input.ExpectedHeadOid)
	}
	newCommit, err := ghCreateCommitOnBranch(input)
	if err != nil {
		return fmt.Errorf("failed to create new commit from staging area: %w", err)
	}
	if !*Quiet {
		fmt.Fprintf(os.Stderr, "-> %s\n", newCommit)
	}
	fmt.Println(newCommit)

	return nil
}

func runCommits(repo, branch, spec string) error {
	commits, err := gitCommits(spec)
	if err != nil {
		return fmt.Errorf("list commits for %q: %w", spec, err)
	}
	verbose("resolved %q to commits %s", spec, commits)

	if len(commits) == 0 {
		// e.g., for HEAD..HEAD
		if !*Quiet {
			fmt.Fprintf(os.Stderr, "nothing to push\n")
		}
		return nil
	}

	slices.Reverse(commits)

	var prevNewCommit OID
	for i, commit := range commits {
		verbose("[%d/%d] processing commit %s", i+1, len(commits), commit)

		parents, err := gitCommitParents(commit)
		if err != nil {
			return fmt.Errorf("list parents of commit %s: %w", commit, err)
		}
		verbose("commit %s has parents %s", commit, parents)

		if len(parents) == 0 {
			return notPushableErrf(commit, "commit has no parents (cannot create new branch)")
		}
		if len(parents) != 1 {
			return notPushableErrf(commit, "commit has multiple parents (cannot push merge commits)")
		}
		parent := parents[0]

		message, err := gitCommitMessage(commit)
		if err != nil {
			return fmt.Errorf("get subject of commit %s: %w", commit, err)
		}

		subject, body := cutCommitMessage(message)
		verbose("subject %q", subject)
		verbose("body %q", body)

		input := gqlCreateCommitOnBranchInput{
			Branch: gqlCommittableBranch{
				RepositoryNameWithOwner: repo,
				BranchName:              branch,
			},
			Message: gqlCommitMessage{
				Headline: subject,
				Body:     body,
			},
			ExpectedHeadOid: cmp.Or(prevNewCommit, parent),
		}

		files, err := gitCommitDiff(parent, commit)
		if err != nil {
			return fmt.Errorf("compute diff of commit %s: %w", commit, err)
		}
		for _, file := range files {
			verbose("diff %s %q", file.Status, file.Path)
		}

		input.FileChanges, err = changes(commit, files)
		if err != nil {
			return err
		}

		inputJSON, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("marshal json: %w", err)
		}

		if *DryRun {
			os.Stdout.Write(append(inputJSON, '\n'))
			prevNewCommit = OID(strings.Repeat("x", len(commit)))
			continue
		}

		verbose("creating commit")

		if !*Quiet {
			fmt.Fprintf(os.Stderr, "[%d/%d] pushing %s (size=%d additions=%d deletions=%d) over %s:%s@%s\n", i+1, len(commits), commit, len(inputJSON), len(input.FileChanges.Additions), len(input.FileChanges.Deletions), input.Branch.RepositoryNameWithOwner, input.Branch.BranchName, input.ExpectedHeadOid)
		}
		newCommit, err := ghCreateCommitOnBranch(input)
		if err != nil {
			return fmt.Errorf("failed to create commit for local commit %s: %w", commit, err)
		}
		if !*Quiet {
			fmt.Fprintf(os.Stderr, "[%d/%d] -> %s\n", i+1, len(commits), newCommit)
		}
		fmt.Println(newCommit)

		prevNewCommit = newCommit
	}
	return nil
}

func changes(commit OID, diff []gitDiffFile) (changes gqlFileChanges, err error) {
	changes = gqlFileChanges{
		Additions: []gqlFileAddition{},
		Deletions: []gqlFileDeletion{},
	}
	var what string
	if commit == "" {
		what = "staging area"
	} else {
		what = "commit " + string(commit)
	}
	for _, file := range diff {
		switch file.Status {
		case gitCommitDiffAdded, gitCommitDiffModified, gitCommitDiffTypeChanged:
			objs, err := gitListTreeObjects(commit, file.Path)
			if err != nil {
				return changes, fmt.Errorf("get %s tree object %q: %w", what, file.Path, err)
			}
			if len(objs) != 1 {
				// diff-tree doesn't return trees, so it should only ever have one
				return changes, fmt.Errorf("get %s tree object %q: expected exactly one object", what, file.Path)
			}
			obj := objs[0]

			switch obj.Type {
			case "blob": // file
				// okay
			case "commit": // submodule
				return changes, notPushableErrf(commit, "contains an added/modified submodule %q", file.Path)
			case "tree":
				return changes, fmt.Errorf("wtf: why is %q a tree", file.Path)
			default:
				return changes, notPushableErrf(commit, "contains an added/modified object %q with unknown type %s", file.Path, obj.Type)
			}
			switch obj.Mode {
			case 100644: // regular file
				// okay
			case 100755: // executable file
				return changes, notPushableErrf(commit, "contains an executable file %q", file.Path)
			case 120000: // symbolic link
				return changes, notPushableErrf(commit, "contains a symbolic link %q", file.Path)
			default: // should never happen since git doesn't store other modes
				return changes, notPushableErrf(commit, "contains a non-regular file %q with mode %d", file.Path, obj.Mode)
			}

			buf, err := gitCatFile(obj.OID)
			if err != nil {
				return changes, fmt.Errorf("get %s file %q contents: %w", what, file.Path, err)
			}
			changes.Additions = append(changes.Additions, gqlFileAddition{
				Path:     file.Path,
				Contents: gqlBase64String(buf),
			})

		case gitCommitDiffDeleted:
			changes.Deletions = append(changes.Deletions, gqlFileDeletion{
				Path: file.Path,
			})

		default:
			return changes, notPushableErrf(commit, "unsupported diff status %s (%s)", file.Status, file)
		}
	}
	return changes, nil
}

type gqlCreateCommitOnBranchInput struct {
	Branch          gqlCommittableBranch `json:"branch"`
	ExpectedHeadOid gqlGitObjectID       `json:"expectedHeadOid"`
	Message         gqlCommitMessage     `json:"message"`
	FileChanges     gqlFileChanges       `json:"fileChanges"`
}

type gqlCommittableBranch struct {
	RepositoryNameWithOwner string `json:"repositoryNameWithOwner"`
	BranchName              string `json:"branchName"`
}

type gqlGitObjectID = OID

type gqlCommitMessage struct {
	Headline string `json:"headline"`
	Body     string `json:"body"`
}

type gqlFileChanges struct {
	Additions []gqlFileAddition `json:"additions"`
	Deletions []gqlFileDeletion `json:"deletions"`
}

type gqlFileAddition struct {
	Contents gqlBase64String `json:"contents"`
	Path     string          `json:"path"`
}

type gqlFileDeletion struct {
	Path string `json:"path"`
}

type gqlBase64String []byte

var _ json.Marshaler = (gqlBase64String)(nil)

func (b gqlBase64String) MarshalJSON() ([]byte, error) {
	dst := make([]byte, 0, base64.StdEncoding.EncodedLen(len(b))+2)
	dst = append(dst, '"')
	dst = base64.StdEncoding.AppendEncode(dst, b)
	dst = append(dst, '"')
	return dst, nil
}

func ghCreateCommitOnBranch(input gqlCreateCommitOnBranchInput) (OID, error) {
	query := `
		mutation($input: CreateCommitOnBranchInput!) {
			createCommitOnBranch(input: $input) {
				commit {
					oid
				}
			}
		}
	`
	type result struct {
		CreateCommitOnBranch struct {
			Commit struct {
				OID OID `json:"oid"`
			} `json:"commit"`
		} `json:"createCommitOnBranch"`
	}
	resp, err := ghGraphql[result](query, map[string]any{"input": input})
	if err != nil {
		// best-effort attempt to have better errors for certain cases (as of 2026-04-04)
		switch {
		case strings.Contains(err.Error(), "No commit exists with specified expectedHeadOid"):
			return "", fmt.Errorf("remote branch head is behind local parent commit (error: %w)", err)
		case strings.Contains(err.Error(), "Expected branch to point to"):
			return "", fmt.Errorf("local parent commit is behind remote branch head (error: %w)", err)
		}
		return "", err
	}
	if !resp.CreateCommitOnBranch.Commit.OID.Valid() {
		return "", fmt.Errorf("github created the commit but returned an empty/invalid oid %q", resp.CreateCommitOnBranch.Commit.OID)
	}
	return resp.CreateCommitOnBranch.Commit.OID, nil
}

var ghMutationRateLimit *time.Ticker

func ghGraphql[T any](query string, variables map[string]any) (*T, error) {
	var reqObj struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	reqObj.Query = query
	reqObj.Variables = variables

	reqObjJSON, err := json.Marshal(reqObj)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}
	verbose("request body size %d", len(reqObjJSON))

	req, err := http.NewRequest(http.MethodPost, GitHubGraphqlURL, bytes.NewReader(reqObjJSON))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Length", strconv.Itoa(len(reqObjJSON)))
	req.Header.Set("Accept", "application/json")

	if GitHubToken == "" {
		return nil, fmt.Errorf("no github token specified")
	}
	req.Header.Set("Authorization", "Bearer "+GitHubToken)

	var buf []byte
	for try := 1; ; try++ {
		if ghMutationRateLimit == nil {
			ghMutationRateLimit = time.NewTicker(time.Second) // https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#staying-under-the-rate-limit
		} else {
			select {
			case <-ghMutationRateLimit.C:
			default:
				verbose("delaying request to stay within rate limit")
				<-ghMutationRateLimit.C
			}
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
		buf, err = io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("read response: %w", err)
		}

		verbose("response status %d", resp.StatusCode)
		for k, vs := range resp.Header {
			for _, v := range vs {
				verbose("response header %s = %q", k, v)
			}
		}
		verbose("response body %q", buf)

		// https://github.com/octokit/plugin-retry.js/blob/v8.1.0/src/index.ts
		if resp.StatusCode >= 400 {
			switch resp.StatusCode {
			case 400, 401, 403, 404, 410, 422, 451:
				return nil, fmt.Errorf("non-retryable response status %d (try: %d, body: %q)", try, resp.StatusCode, buf)
			}
			if try > 3 {
				return nil, fmt.Errorf("response status %d, no retries left (try: %d, body: %q)", try, resp.StatusCode, buf)
			}
			retryAfter := time.Duration(float64(time.Second) * math.Pow(float64(try), 2))
			fmt.Fprintf(os.Stderr, "warning: request failed, will retry after %s (response status %d, body %q)", retryAfter, resp.StatusCode, buf)
			<-time.After(retryAfter)
			continue
		}

		if mt, _, _ := mime.ParseMediaType(req.Header.Get("Content-Type")); mt != "application/json" {
			if resp.StatusCode != 200 {
				return nil, fmt.Errorf("response status %d (body: %q)", resp.StatusCode, buf)
			}
			return nil, fmt.Errorf("incorrect response type %q", mt)
		}
		break
	}

	var respObj struct {
		Errors []struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"errors"`
		Data T `json:"data"`
	}
	if err := json.Unmarshal(buf, &respObj); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	var errs []error
	for _, e := range respObj.Errors {
		errs = append(errs, fmt.Errorf("%s: %s", e.Type, e.Message))
	}
	if err := errors.Join(errs...); err != nil {
		return nil, fmt.Errorf("github failed to create commit: %w", err)
	}
	return &respObj.Data, nil
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
	if *Debug {
		fmt.Fprintf(os.Stderr, "# git%s\n", fmtargs(args...))
	}
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

func verbose(format string, a ...any) {
	if *Verbose {
		fmt.Fprintf(os.Stderr, format+"\n", a...)
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
